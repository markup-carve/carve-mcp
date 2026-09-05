#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { parseArgs } from './args.js';

const { roots, allowWrite } = parseArgs(process.argv.slice(2));
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
