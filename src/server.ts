import { McpServer, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import { KNOWN_LINT_PLATFORMS } from '@markup-carve/carve';
import * as z from 'zod/v4';
import { format as formatCarve, lint, MAX_SOURCE_BYTES, migrate, parse, render } from './tools.js';
import { authoringGuide, ruleIds, ruleIndexMarkdown, ruleMarkdown } from './resources.js';
import { lintRuleMarkdown, lintRuleNames } from './lint-rules.js';

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

  server.registerResource('carve-authoring-guide', 'carve://guide', {
    title: 'Carve authoring quick start',
    description: 'Concise, human-facing guidance for common Carve writing tasks.',
    mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: authoringGuide }] }));

  server.registerResource('carve-rule-index', 'carve://rules', {
    title: 'Normative Carve rule index',
    description: 'Versioned map of the normative rule categories and lookup resource.',
    mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: ruleIndexMarkdown() }] }));

  server.registerResource('carve-rule', new ResourceTemplate('carve://rules/{ruleId}', {
    list: undefined,
    complete: { ruleId: (value) => ruleIds.filter((id) => id.startsWith(value.toUpperCase())) },
  }), {
    title: 'Carve rule',
    description: 'A normative rule summary selected by stable rule ID.',
    mimeType: 'text/markdown',
  }, async (uri, variables) => {
    const ruleId = String(variables.ruleId);
    const text = ruleMarkdown(ruleId);
    if (!text) throw new ResourceNotFoundError(uri.href, `Unknown Carve rule ID: ${ruleId.slice(0, 100)}`);
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
  });

  server.registerResource('carve-lint-rule', new ResourceTemplate('carve://lint-rules/{ruleName}', {
    list: undefined,
    complete: { ruleName: (value) => lintRuleNames.filter((name) => name.startsWith(value.toLowerCase())) },
  }), {
    title: 'Carve lint diagnostic',
    description: 'An author-facing explanation selected by the stable diagnostic name returned by carve_lint.',
    mimeType: 'text/markdown',
  }, async (uri, variables) => {
    const ruleName = String(variables.ruleName);
    const text = lintRuleMarkdown(ruleName);
    if (!text) throw new ResourceNotFoundError(uri.href, `Unknown Carve lint rule: ${ruleName.slice(0, 100)}`);
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
  });

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
