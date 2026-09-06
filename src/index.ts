#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { parseArgs } from './args.js';
import { createHttpServer } from './http.js';
import { loadProjectConfiguration } from './config.js';

let parsed: ReturnType<typeof parseArgs>;
let project: Awaited<ReturnType<typeof loadProjectConfiguration>> = {};
try {
  parsed = parseArgs(process.argv.slice(2));
  if (parsed.config) project = await loadProjectConfiguration(parsed.config);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const { roots: cliRoots, allowWrite, http, host, port } = parsed;
const roots = [...new Set([...(project.roots ?? []), ...cliRoots])];
if (allowWrite && roots.length === 0) {
  console.error('--allow-write requires at least one configured root.');
  process.exit(2);
}
const workspace = { roots, allowWrite, review: project.review };
const observe = process.env.CARVE_MCP_LOG_LEVEL === 'info'
  ? (event: { tool: string; status: string; durationMs: number }) => console.error(JSON.stringify({ level: 'info', event: 'tool_call', ...event }))
  : undefined;
if (http) {
  const token = process.env.CARVE_MCP_TOKEN;
  const allowedHosts = process.env.CARVE_MCP_ALLOWED_HOSTS?.split(',').map((value) => value.trim()).filter(Boolean);
  const httpServer = createHttpServer({ host, port, token, allowedHosts, workspace, observe, metrics: process.env.CARVE_MCP_METRICS === '1' });
  httpServer.server.on('error', (error) => {
    console.error(`carve-mcp HTTP server error: ${error.message}`);
    process.exitCode = 1;
  });
  httpServer.server.listen(port, host, () => {
    const address = httpServer.server.address();
    const actualPort = address && typeof address !== 'string' ? address.port : port;
    console.error(`carve-mcp listening on http://${host}:${actualPort}/mcp`);
  });
  const close = () => void httpServer.shutdown().catch((error: unknown) => {
    console.error(`carve-mcp shutdown error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} else {
const server = await createServer(workspace, observe);
const transport = new StdioServerTransport();
transport.onerror = (error) => {
  console.error(`carve-mcp transport error: ${error.message}`);
  process.exitCode = 1;
};
await server.connect(transport);

function shutdown(): void {
  void server.close().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`carve-mcp shutdown error: ${message}`);
    process.exitCode = 1;
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
}
