import { once } from 'node:events';
import { request } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer, MAX_HTTP_BODY_BYTES } from './http.js';

describe('HTTP transport', () => {
  const servers: ReturnType<typeof createHttpServer>[] = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.shutdown())));

  async function running(token?: string, metrics = false) {
    const server = createHttpServer({ host: '127.0.0.1', port: 0, token, metrics });
    servers.push(server);
    server.server.listen(0, '127.0.0.1');
    await once(server.server, 'listening');
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP address');
    return `http://127.0.0.1:${address.port}`;
  }

  function raw(url: string, headers: Record<string, string>, body = ''): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(url, { method: body ? 'POST' : 'GET', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  function chunked(url: string, bytes: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.write(Buffer.alloc(Math.floor(bytes / 2)));
      req.end(Buffer.alloc(Math.ceil(bytes / 2)));
    });
  }

  it('serves health and protects MCP with a bearer token', async () => {
    const base = await running('secret');
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401);
  });

  it('requires authentication off loopback', () => {
    expect(() => createHttpServer({ host: '0.0.0.0', port: 3000 })).toThrow(/bearer token/);
    expect(() => createHttpServer({ host: '0.0.0.0', port: 3000, token: 'secret' })).toThrow(/ALLOWED_HOSTS/);
  });

  it('rejects invalid hosts, origins, and oversized requests', async () => {
    const base = await running();
    expect(await raw(`${base}/health`, { host: 'evil.example' })).toBe(403);
    expect((await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect(await raw(`${base}/mcp`, { 'content-length': String(MAX_HTTP_BODY_BYTES + 1) }, '{}')).toBe(413);
    expect(await chunked(`${base}/mcp`, MAX_HTTP_BODY_BYTES + 1)).toBe(413);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('requires a token when HTTP workspace writes are enabled', () => {
    expect(() => createHttpServer({
      host: '127.0.0.1', port: 3000, workspace: { roots: ['/tmp'], allowWrite: true },
    })).toThrow(/bearer token/);
  });

  it('serves real MCP requests through the official HTTP client', async () => {
    const base = await running('secret');
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer secret' } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('carve_lint');
    await client.close();
  });

  it('exposes opt-in aggregate metrics without source content', async () => {
    const base = await running('secret', true);
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const client = new Client({ name: 'metrics-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer secret' } },
    });
    await client.connect(transport);
    await client.callTool({ name: 'carve_lint', arguments: { source: 'private words' } });
    await client.close();
    const response = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer secret' } });
    const body = await response.text();
    expect(body).toContain('carve_mcp_tool_calls_total{tool="carve_lint"} 1');
    expect(body).not.toContain('private words');
  });
});
