import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from './http.js';
import { createServer } from './server.js';
import { parseErrorFilter } from './stdio.js';
import { MAX_PARSE_OUTPUT_BYTES, parseForTool } from './tools.js';

describe('tool error text', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => { await Promise.all(closeables.splice(0).map((item) => item.close())); });

  it('carries the error message instead of a success summary', async () => {
    const server = await createServer();
    const client = new Client({ name: 'robustness-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const called = await client.callTool({ name: 'carve_render', arguments: { source: 'x', target: 'plain', preset: 'static-html' } });
    expect(called.isError).toBe(true);
    const text = (called.content as Array<{ text: string }>)[0]!.text;
    expect(text).toBe('The static-html preset is only valid for the HTML target.');
    expect(text).not.toMatch(/success/i);
  });
});

describe('carve_parse output size', () => {
  const paragraph = 'Some *strong* and /em/ text with a [link](https://x.org) here.\n\n';

  it('omits positions on request', () => {
    const ast = parseForTool('Hi *x*\n', undefined, false);
    expect(JSON.stringify(ast)).not.toContain('"pos"');
    expect(JSON.stringify(parseForTool('Hi *x*\n'))).toContain('"pos"');
  });

  it('refuses a result past the cap with a clear error, and positions: false fits', () => {
    const source = paragraph.repeat(Math.floor(900_000 / paragraph.length));
    expect(() => parseForTool(source)).toThrow(new RegExp(`limit is ${MAX_PARSE_OUTPUT_BYTES} bytes.*positions: false`));
    expect(Buffer.byteLength(JSON.stringify(parseForTool(source, undefined, false)))).toBeLessThanOrEqual(MAX_PARSE_OUTPUT_BYTES);
  });
});

describe('malformed JSON-RPC input', () => {
  it('answers an unparsable stdio line with -32700 and passes valid lines through', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const filtered = input.pipe(parseErrorFilter(output));
    const forwarded: Buffer[] = [];
    filtered.on('data', (chunk: Buffer) => forwarded.push(chunk));
    input.write('not json\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0",');
    input.end('"id":2,"method":"ping"}\n');
    await once(filtered, 'end');
    expect(Buffer.concat(forwarded).toString()).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    const replies = output.read()?.toString().trim().split('\n').map((line: string) => JSON.parse(line));
    expect(replies).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }]);
  });

  it('answers a malformed HTTP body with a JSON-RPC parse error', async () => {
    const server = createHttpServer({ host: '127.0.0.1', port: 0 });
    server.server.listen(0, '127.0.0.1');
    await once(server.server, 'listening');
    try {
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('No TCP address');
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: '{"jsonrpc":',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    } finally {
      await server.shutdown();
    }
  });
});
