#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { parseArgs } from './args.js';
import { createHttpServer } from './http.js';

const { roots, allowWrite, http, host, port } = parseArgs(process.argv.slice(2));
if (http) {
  const token = process.env.CARVE_MCP_TOKEN;
  const allowedHosts = process.env.CARVE_MCP_ALLOWED_HOSTS?.split(',').map((value) => value.trim()).filter(Boolean);
  const httpServer = createHttpServer({ host, port, token, allowedHosts, workspace: { roots, allowWrite } });
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
const server = await createServer({ roots, allowWrite });
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
