// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('http') as typeof import('http');
import type * as nodeHttp from 'http';
import { nodeStreamPost } from './nodeHttp';

describe('nodeStreamPost', () => {
  let server: nodeHttp.Server;
  let receivedHeaders: Record<string, string | string[] | undefined> = {};
  let baseUrl: string;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write(JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n');
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  test('merges caller-supplied headers into the request', async () => {
    await nodeStreamPost({
      url: `${baseUrl}/api/chat`,
      body: '{}',
      signal: new AbortController().signal,
      headers: { Authorization: 'Bearer sekret' },
      onLine: () => {},
    });

    expect(receivedHeaders['authorization']).toBe('Bearer sekret');
  });

  test('sends no Authorization header when none is supplied', async () => {
    await nodeStreamPost({
      url: `${baseUrl}/api/chat`,
      body: '{}',
      signal: new AbortController().signal,
      onLine: () => {},
    });

    expect(receivedHeaders['authorization']).toBeUndefined();
  });
});
