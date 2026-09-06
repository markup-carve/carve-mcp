import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { createServer } from './server.js';
import type { WorkspaceOptions } from './workspace.js';
import { SafeMetrics, type ToolObserver } from './telemetry.js';

export const MAX_HTTP_BODY_BYTES = 7 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 32;
const REQUESTS_PER_MINUTE = 60;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export interface HttpOptions {
  host: string; port: number; token?: string; allowedHosts?: string[]; workspace?: WorkspaceOptions;
  metrics?: boolean; observe?: ToolObserver;
}

export interface HttpServer {
  server: ReturnType<typeof createNodeServer>;
  shutdown(): Promise<void>;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function digest(value: string): Buffer { return createHash('sha256').update(value).digest(); }

function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return timingSafeEqual(digest(match?.[1] ?? ''), digest(token));
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (!Number.isFinite(declared) || declared < 0) throw new Error('invalid-body');
  if (declared > MAX_HTTP_BODY_BYTES) throw new Error('request-too-large');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_HTTP_BODY_BYTES) throw new Error('request-too-large');
    chunks.push(value);
  }
  if (chunks.length === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid-body'); }
}

function send(res: ServerResponse, status: number, value: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers });
  res.end(value);
}

function requestIp(req: IncomingMessage): string { return req.socket?.remoteAddress ?? 'unknown'; }

export function createHttpServer(options: HttpOptions): HttpServer {
  if ((!isLoopback(options.host) || options.workspace?.allowWrite === true) && !options.token) {
    throw new Error('A bearer token is required for non-loopback binds and HTTP workspace writes.');
  }
  if (!isLoopback(options.host) && (!options.allowedHosts || options.allowedHosts.length === 0)) {
    throw new Error('CARVE_MCP_ALLOWED_HOSTS is required for non-loopback binds.');
  }

  const allowedHosts = options.allowedHosts?.length ? options.allowedHosts : LOCAL_HOSTS;
  const validateHost = hostHeaderValidation(allowedHosts);
  const validateOrigin = originValidation(allowedHosts);
  const metrics = new SafeMetrics();
  const observe: ToolObserver = (event) => { metrics.observe(event); options.observe?.(event); };
  const handler = createMcpHandler(() => createServer(options.workspace, observe), {
    onerror: (error) => console.error(JSON.stringify({ level: 'error', event: 'mcp_error', errorType: error.name })),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => console.error(JSON.stringify({ level: 'error', event: 'transport_error', errorType: error.name })),
  });
  const rate = new Map<string, { minute: number; count: number }>();
  let rateMinute = Math.floor(Date.now() / 60_000);
  let active = 0;

  const server = createNodeServer(async (req, res) => {
    const started = Date.now();
    const remoteAddress = requestIp(req);
    res.once('finish', () => console.error(JSON.stringify({
      level: 'info', method: req.method, path: new URL(req.url ?? '/', 'http://localhost').pathname, status: res.statusCode,
      durationMs: Date.now() - started, remoteAddress,
    })));
    let counted = false;
    try {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        return send(res, 200, req.method === 'HEAD' ? '' : 'ok');
      }
      if (options.metrics && req.url === '/metrics' && req.method === 'GET') {
        if (!authorized(req.headers.authorization, options.token)) {
          return send(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
        }
        return send(res, 200, metrics.prometheus(), { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      }
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') return send(res, 404, 'Not found');
      const minute = Math.floor(Date.now() / 60_000);
      if (minute !== rateMinute) {
        rate.clear();
        rateMinute = minute;
      }
      const prior = rate.get(remoteAddress);
      const entry = prior?.minute === minute ? prior : { minute, count: 0 };
      entry.count += 1;
      if (rate.size >= 10_000 && !prior) rate.delete(rate.keys().next().value as string);
      rate.set(remoteAddress, entry);
      if (entry.count > REQUESTS_PER_MINUTE) return send(res, 429, 'Too many requests', { 'retry-after': '60' });
      if (!authorized(req.headers.authorization, options.token)) {
        return send(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
      }
      if (active >= MAX_CONCURRENT_REQUESTS) return send(res, 503, 'Server busy', { 'retry-after': '1' });
      active += 1;
      counted = true;

      const parsedBody = req.method === 'GET' || req.method === 'HEAD' ? undefined : await parseBody(req);
      if (options.token) {
        (req as IncomingMessage & { auth?: AuthInfo }).auth = { token: 'authenticated', clientId: 'bearer-token', scopes: [] };
      }
      await nodeHandler(req, res, parsedBody);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else if (error instanceof Error && error.message === 'request-too-large') {
        req.resume();
        send(res, 413, 'Request too large', { connection: 'close' });
      } else if (error instanceof Error && error.message === 'invalid-body') send(res, 400, 'Invalid JSON request body');
      else {
        console.error(JSON.stringify({ level: 'error', event: 'request_error', errorType: error instanceof Error ? error.name : 'UnknownError' }));
        send(res, 500, 'Internal server error');
      }
    } finally {
      if (counted) active -= 1;
    }
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  let shuttingDown: Promise<void> | undefined;
  return {
    server,
    shutdown() {
      shuttingDown ??= (async () => {
        await handler.close();
        server.closeIdleConnections();
        if (!server.listening) return;
        const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        const force = setTimeout(() => server.closeAllConnections(), 5_000);
        try { await closed; } finally { clearTimeout(force); }
      })();
      return shuttingDown;
    },
  };
}
