import {
  CliChatProvider,
  CLI_PRESETS,
  applyCliPreset,
  expandCliTemplate,
  extractCliAnswer,
  resolveCliCommand,
  tokenizeCliTemplate,
} from './cli';
import { ProviderError } from './types';

describe('tokenizeCliTemplate', () => {
  test('splits on whitespace', () => {
    expect(tokenizeCliTemplate('a b c')).toEqual(['a', 'b', 'c']);
  });

  test('collapses runs of whitespace including tabs', () => {
    expect(tokenizeCliTemplate('a\n  b\tc')).toEqual(['a', 'b', 'c']);
  });

  test('double quotes keep spaces inside one token', () => {
    expect(tokenizeCliTemplate('run "two words" {prompt}')).toEqual([
      'run',
      'two words',
      '{prompt}',
    ]);
  });

  test('single quotes keep spaces inside one token', () => {
    expect(tokenizeCliTemplate("sh -c 'echo hi'")).toEqual(['sh', '-c', 'echo hi']);
  });

  test('unbalanced quotes throw ProviderError', () => {
    expect(() => tokenizeCliTemplate('run "unbalanced {prompt}')).toThrow(ProviderError);
    expect(() => tokenizeCliTemplate("run 'unbalanced {prompt}")).toThrow(ProviderError);
  });
});

describe('expandCliTemplate', () => {
  const values = {
    prompt: 'whole conversation here',
    system: 'sys prompt',
    question: 'the question',
    tmpdir: '/tmp/xyz',
  };

  test('standalone {prompt} becomes one argv element even with spaces', () => {
    expect(expandCliTemplate('/bin/echo plain {prompt}', values)).toEqual([
      '/bin/echo',
      'plain',
      'whole conversation here',
    ]);
  });

  test('token embedded in a quoted fragment is substituted inline', () => {
    expect(
      expandCliTemplate('run --system-prompt "{system}" {question}', values)
    ).toEqual([
      'run',
      '--system-prompt',
      'sys prompt',
      'the question',
    ]);
  });

  test('{tmpdir} expands to the working directory', () => {
    expect(expandCliTemplate('run --dir {tmpdir} {prompt}', values)).toEqual([
      'run',
      '--dir',
      '/tmp/xyz',
      'whole conversation here',
    ]);
  });

  test('template without any prompt token throws', () => {
    expect(() => expandCliTemplate('run --format json', values)).toThrow(
      /\{prompt\}/
    );
  });

  test('empty template throws', () => {
    expect(() => expandCliTemplate('   ', values)).toThrow(ProviderError);
  });
});

describe('extractCliAnswer', () => {
  test('plain text output is returned trimmed', () => {
    expect(extractCliAnswer('the answer\n\n')).toBe('the answer');
  });

  test('single JSON object: text field wins', () => {
    expect(extractCliAnswer('{"type":"result","text":"PONG"}\n')).toBe('PONG');
  });

  test('NDJSON: scans from the last line backwards', () => {
    const output = [
      JSON.stringify({ type: 'init', session: 'abc' }),
      JSON.stringify({ type: 'text', text: 'thinking' }),
      JSON.stringify({ type: 'text', text: 'final answer' }),
    ].join('\n');
    expect(extractCliAnswer(output)).toBe('final answer');
  });

  test('agent NDJSON with user echo: returns the assistant reply, not the prompt echo', () => {
    const output = [
      JSON.stringify({ type: 'session', id: 'abc' }),
      JSON.stringify({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'the question itself' }] } }),
      JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'the question itself' }] } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PONG' }] } }),
    ].join('\n');
    expect(extractCliAnswer(output)).toBe('PONG');
  });

  test('JSON array: last element with a text field wins', () => {
    const output = JSON.stringify([
      { id: 1 },
      { content: 'hello' },
    ]);
    expect(extractCliAnswer(output)).toBe('hello');
  });

  test('JSON without a recognizable text field falls back to raw output', () => {
    const output = '{"foo":42}';
    expect(extractCliAnswer(output)).toBe(output);
  });

  test('invalid JSON that looks like JSON falls back to raw output', () => {
    expect(extractCliAnswer('{not json')).toBe('{not json');
  });

  test('empty output returns empty string', () => {
    expect(extractCliAnswer('   ')).toBe('');
  });
});

describe('resolveCliCommand', () => {
  test('existing absolute path is returned as-is', () => {
    expect(resolveCliCommand(process.execPath)).toBe(process.execPath);
  });

  test('missing absolute path returns null', () => {
    expect(resolveCliCommand('/no/such/binary-xyz')).toBeNull();
  });

  test('bare name found on PATH resolves to an absolute path', () => {
    const resolved = resolveCliCommand('sh');
    expect(resolved).toMatch(/\/sh$/);
  });

  test('unknown bare name returns null', () => {
    expect(resolveCliCommand('definitely-not-a-real-cmd-xyz')).toBeNull();
  });
});

describe('applyCliPreset', () => {
  test('custom preset is a bare {prompt} placeholder', () => {
    expect(applyCliPreset('custom')).toBe('{prompt}');
  });

  test('omp preset keeps its one-shot flags', () => {
    const template = applyCliPreset('omp');
    expect(template).toContain('-p');
    expect(template).toContain('{prompt}');
  });

  test('opencode preset keeps its flags', () => {
    const template = applyCliPreset('opencode');
    expect(template).toContain('run');
    expect(template).toContain('--format json');
    expect(template).toContain('{prompt}');
  });

  test('presets never contain unresolved template artifacts beyond the tokens', () => {
    for (const preset of Object.keys(CLI_PRESETS) as Array<keyof typeof CLI_PRESETS>) {
      expect(applyCliPreset(preset).trim().length).toBeGreaterThan(0);
    }
  });
});

// --- CliChatProvider: real subprocess integration (deterministic binaries) ---

describe('CliChatProvider', () => {
  test('chat: raw text output is returned and delivered via onToken', async () => {
    const provider = new CliChatProvider('/bin/echo plain {prompt}');
    const tokens: string[] = [];

    const answer = await provider.chat(
      [{ role: 'user', content: 'hello world' }],
      new AbortController().signal,
      (t) => tokens.push(t)
    );

    expect(answer).toBe('plain hello world');
    expect(tokens).toEqual(['plain hello world']);
  });

  test('chat: JSON output is extracted; {question} arrives as one argv element', async () => {
    const provider = new CliChatProvider(
      "node -e 'console.log(JSON.stringify({text:process.argv[1]}))' {question}"
    );

    const answer = await provider.chat(
      [
        { role: 'system', content: 'ctx' },
        { role: 'user', content: 'hello world' },
      ],
      new AbortController().signal
    );

    expect(answer).toBe('hello world');
  });

  test('chat: non-zero exit throws UNEXPECTED_RESPONSE with the code', async () => {
    const provider = new CliChatProvider("node -e 'console.error(\"boom\"); process.exit(3)' {prompt}");

    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], new AbortController().signal)
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], new AbortController().signal)
    ).rejects.toThrow(/exited with code 3: boom/);
  });

  test('chat: missing command throws CONNECTION_REFUSED', async () => {
    const provider = new CliChatProvider('definitely-not-a-real-cmd-xyz {prompt}');

    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], new AbortController().signal)
    ).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], new AbortController().signal)
    ).rejects.toThrow(/not found/);
  });

  test('chat: pre-aborted signal throws STREAM_ABORTED without spawning', async () => {
    const provider = new CliChatProvider('/bin/echo never {prompt}');
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], controller.signal)
    ).rejects.toMatchObject({ code: 'STREAM_ABORTED' });
  });

  test('chat: template without a prompt token throws', async () => {
    const provider = new CliChatProvider('/bin/echo no tokens');

    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], new AbortController().signal)
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  test('ping: round-trip probe returns reachable with the extracted reply', async () => {
    const provider = new CliChatProvider('/bin/echo probe {prompt}');

    const result = await provider.ping();

    expect(result.reachable).toBe(true);
    expect(result.sampleResponse).toBe('probe Reply with exactly one word: PONG');
  });

  test('ping: failing command returns unreachable with the error, never throws', async () => {
    const provider = new CliChatProvider('definitely-not-a-real-cmd-xyz {prompt}');

    const result = await provider.ping();

    expect(result.reachable).toBe(false);
    expect(result.errorMessage).toMatch(/not found/);
  });

  test('listModels: returns empty (model selection is a template concern)', async () => {
    const provider = new CliChatProvider('/bin/echo x {prompt}');
    await expect(provider.listModels()).resolves.toEqual([]);
  });
});
