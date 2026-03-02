// Uses Node.js http/https modules directly — no CORS restrictions, no Origin header.
// Required because Electron's fetch sends `Origin: app://obsidian.md` which local
// LLM servers (LM Studio, etc.) may block via CORS policy.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('http') as typeof import('http');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const https = require('https') as typeof import('https');

export interface StreamPostOptions {
  url: string;
  body: string;
  signal: AbortSignal;
  onLine: (line: string) => void;  // called for each complete newline-delimited chunk
}

/**
 * POST to a URL using Node.js http/https, streaming response line-by-line.
 * Bypasses browser CORS entirely. Works for both NDJSON (Ollama) and SSE (LM Studio).
 */
export function nodeStreamPost(opts: StreamPostOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const { url, body, signal, onLine } = opts;
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        // Reject immediately on HTTP error so callers get a real error instead
        // of silently receiving an empty response.
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          let errBody = '';
          res.on('data', (chunk: Buffer) => { errBody += chunk.toString('utf8'); });
          res.on('end', () => {
            // Try to surface the server's error message if it's JSON
            let detail = errBody.slice(0, 300);
            try {
              const parsed = JSON.parse(errBody);
              detail = parsed?.error?.message ?? parsed?.message ?? detail;
            } catch { /* keep raw body */ }
            reject(new Error(`HTTP ${status}: ${detail}`));
          });
          return;
        }

        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim()) onLine(line);
          }
        });

        res.on('end', () => {
          if (buffer.trim()) onLine(buffer);
          resolve();
        });

        res.on('error', reject);
      }
    );

    req.on('error', (err: Error) => {
      // Distinguish abort from genuine connection error
      if (signal.aborted) {
        reject(Object.assign(new Error('Stream aborted'), { name: 'AbortError' }));
      } else {
        reject(err);
      }
    });

    // Wire AbortSignal to destroy the request
    signal.addEventListener('abort', () => req.destroy(), { once: true });

    req.write(body);
    req.end();
  });
}
