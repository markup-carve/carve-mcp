import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { format, lint, MAX_SOURCE_BYTES, migrate, parse, render } from './tools.js';

const source = z.string().describe(`Document source (maximum ${MAX_SOURCE_BYTES} UTF-8 bytes)`);

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function safe<T extends unknown[]>(fn: (...args: T) => unknown) {
  return async (...args: T) => {
    try { return result(fn(...args)); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...result({ error: message }), isError: true };
    }
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'carve-mcp', version: '0.1.0' });

  server.registerTool('carve_lint', {
    description: 'Check Carve source for author-facing problems and silent degradation.',
    inputSchema: z.object({ source, platforms: z.array(z.enum(['github'])).default([]) }),
  }, safe(({ source, platforms }) => lint(source, platforms)));

  server.registerTool('carve_format', {
    description: 'Format Carve source canonically and report any lossy raw-format nodes.',
    inputSchema: z.object({ source }),
  }, safe(({ source }) => format(source)));

  server.registerTool('carve_render', {
    description: 'Render Carve to HTML, Markdown, plain text, ANSI terminal text, or canonical Carve, with loss reporting.',
    inputSchema: z.object({ source, target: z.enum(['html', 'markdown', 'plain', 'ansi', 'carve']) }),
  }, safe(({ source, target }) => render(source, target)));

  server.registerTool('carve_parse', {
    description: 'Parse and resolve Carve into its position-aware interchange AST.',
    inputSchema: z.object({ source }),
  }, safe(({ source }) => parse(source)));

  server.registerTool('carve_migrate', {
    description: 'Migrate HTML, Markdown, or Djot source to Carve with fidelity diagnostics.',
    inputSchema: z.object({ source, format: z.enum(['html', 'markdown', 'djot']) }),
  }, safe(({ source, format }) => migrate(source, format)));

  return server;
}
