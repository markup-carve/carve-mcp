import { McpServer } from '@modelcontextprotocol/server';
import { KNOWN_LINT_PLATFORMS } from '@markup-carve/carve';
import * as z from 'zod/v4';
import { format as formatCarve, lint, MAX_SOURCE_BYTES, migrate, parse, render } from './tools.js';

const sourceSchema = z.string().describe(`Document source (maximum ${MAX_SOURCE_BYTES} UTF-8 bytes)`);
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

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
    title: 'Lint Carve',
    description: 'Check Carve source for author-facing problems and silent degradation.',
    inputSchema: z.object({ source: sourceSchema, platforms: z.array(z.enum(KNOWN_LINT_PLATFORMS)).default([]) }),
    annotations: readOnly,
  }, safe(({ source: document, platforms }) => lint(document, platforms)));

  server.registerTool('carve_format', {
    title: 'Format Carve',
    description: 'Format Carve source canonically and report any lossy raw-format nodes.',
    inputSchema: z.object({ source: sourceSchema }),
    annotations: readOnly,
  }, safe(({ source: document }) => formatCarve(document)));

  server.registerTool('carve_render', {
    title: 'Render Carve',
    description: 'Render Carve to HTML, Markdown, plain text, or ANSI terminal text, with loss reporting.',
    inputSchema: z.object({ source: sourceSchema, target: z.enum(['html', 'markdown', 'plain', 'ansi']) }),
    annotations: readOnly,
  }, safe(({ source: document, target }) => render(document, target)));

  server.registerTool('carve_parse', {
    title: 'Parse Carve',
    description: 'Parse and resolve Carve into its position-aware interchange AST.',
    inputSchema: z.object({ source: sourceSchema }),
    annotations: readOnly,
  }, safe(({ source: document }) => parse(document)));

  server.registerTool('carve_migrate', {
    title: 'Migrate to Carve',
    description: 'Migrate HTML, Markdown, or Djot source to Carve with fidelity diagnostics.',
    inputSchema: z.object({ source: sourceSchema, format: z.enum(['html', 'markdown', 'djot']) }),
    annotations: readOnly,
  }, safe(({ source: document, format: sourceFormat }) => migrate(document, sourceFormat)));

  return server;
}
