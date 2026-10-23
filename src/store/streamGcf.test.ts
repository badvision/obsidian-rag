import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { encodeVector } from './vectorCodec';
import { appendRows, writeText, openLines, scanIndexDocumentStream, validateChunkRow } from './streamGcf';

// A byte-mode sink whose buffer is 1 byte, so every non-trivial write returns
// false and the caller MUST await 'drain'. _write flushes on setImmediate, so
// backpressure is real and the drain path is exercised on every row — this is
// what makes the ordering regression deterministic instead of timing-dependent.
function makeSlowSink() {
  const parts: string[] = [];
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk: unknown, _enc: string, cb: (e?: Error | null) => void) {
      parts.push(String(chunk));
      setImmediate(cb);
    },
  });
  return { sink, parts };
}

function rowStream(n: number): Readable {
  return Readable.from(
    (async function* () {
      for (let i = 0; i < n; i++) yield `row-${i}|x|y`;
    })(),
    { objectMode: true }
  );
}

describe('streamGcf appendRows (publication ordering)', () => {
  test('flushes every row before resolving, so a trailer written next cannot overtake rows', async () => {
    const N = 5000;
    const { sink, parts } = makeSlowSink();
    const counter = { count: 0 };

    await appendRows(sink as unknown as Writable, rowStream(N), counter);
    // The caller writes the summary trailer only after appendRows resolves.
    await writeText(sink as unknown as Writable, `##! summary counts=${counter.count}\n`);
    await new Promise<void>((resolve, reject) => {
      (sink as Writable).once('error', reject);
      (sink as Writable).end(() => resolve());
    });

    expect(counter.count).toBe(N);
    const lines = parts.join('').split('\n');
    // Every data row precedes the trailer; the trailer is the final content line.
    expect(lines[0]).toBe('row-0|x|y');
    expect(lines[N - 1]).toBe(`row-${N - 1}|x|y`);
    expect(lines[N]).toBe(`##! summary counts=${N}`);
    expect(lines[lines.length - 1]).toBe(''); // trailing newline
  });

  test('propagates a source error and leaves the counter at the rows actually written', async () => {
    const { sink, parts } = makeSlowSink();
    const counter = { count: 0 };
    const rows = Readable.from(
      (async function* () {
        yield 'row-0|x|y';
        yield 'row-1|x|y';
        throw new Error('source failed');
      })(),
      { objectMode: true }
    );
    await expect(appendRows(sink as unknown as Writable, rows, counter)).rejects.toThrow('source failed');
    expect(counter.count).toBe(2);
    expect(parts.join('')).toContain('row-1|x|y');
  });
});

describe('streamGcf openLines / scan (newline integrity)', () => {
  test('openLines emits complete lines and no spurious undefined tail row', async () => {
    // Written through a temp file: openLines must split on real newlines only.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gcf-lines-'));
    const file = path.join(dir, 'doc.txt');
    await fsp.writeFile(file, 'a|1\nb|2\n##! summary counts=2\n', 'utf8');
    const got: string[] = [];
    for await (const line of openLines(file)) got.push(line);
    await fsp.rm(dir, { recursive: true, force: true });
    expect(got).toEqual(['a|1', 'b|2', '##! summary counts=2']);
    // Regression for the multi-cb bug: a trailing cb() used to emit undefined.
    expect(got.every((l) => typeof l === 'string' && l.length > 0)).toBe(true);
  });

  test('scanIndexDocumentStream validates rows in place and reports completeness', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gcf-scan-'));
    const file = path.join(dir, 'index.gcf');
    const v1 = encodeVector([1, 0]);
    const v2 = encodeVector([0, 1]);
    const doc =
      'GCF profile=generic\nformatVersion=1\nschemaVersion=2\n' +
      'embeddingModel=m\nembeddingDimension=2\nvectorCodec=f64le-deflate-base64\n' +
      'createdAt=x\nupdatedAt=x\n' +
      '## files [?]{vaultPath,mtime,chunkCount}\na.pdf|1|2\n' +
      `## chunks [?]{id,vaultPath,page,chunkIndex,sourceType,text,embedding}\n` +
      `a.pdf::p0::c0|a.pdf|0|0|pdf|t0|${v1}\n` +
      `a.pdf::p0::c1|a.pdf|0|1|pdf|t1|${v2}\n` +
      '##! summary counts=1,2\n';
    await fsp.writeFile(file, doc, 'utf8');
    const scan = await scanIndexDocumentStream(file);
    await fsp.rm(dir, { recursive: true, force: true });
    expect(scan.complete).toBe(true);
    expect(scan.fileRecords.map((f) => f.vaultPath)).toEqual(['a.pdf']);
    expect(scan.chunkRowCount).toBe(2);
    expect(validateChunkRow(doc.split('\n')[11], 2)).toBe(true);
  });
});
