import { McpServer, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import { KNOWN_LINT_PLATFORMS, RenderLossError } from '@markup-carve/carve';
import * as z from 'zod/v4';
import { format as formatCarve, lint, MAX_SOURCE_BYTES, migrate, parse, render } from './tools.js';
import { authoringGuide, ruleIds, ruleIndexMarkdown, ruleMarkdown } from './resources.js';
import { lintRuleMarkdown, lintRuleNames } from './lint-rules.js';
import { prepareWorkspace, type WorkspaceOptions } from './workspace.js';

const sourceSchema = z.string().describe(`Document source (maximum ${MAX_SOURCE_BYTES} UTF-8 bytes)`);
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const renderSettings = {
  preset: z.enum(['default', 'portable', 'static-html']).default('default').describe('portable lowercases IDs and transliterates where possible; static-html is HTML-only.'),
  asciiHeadingIds: z.enum(['off', 'fold', 'strict']).optional().describe('Heading ID policy; explicit values override the preset.'),
  lowercaseHeadingIds: z.boolean().optional().describe('Lowercase generated heading IDs; explicit values override the preset.'),
  strictLosses: z.boolean().default(false).describe('Fail instead of returning output when a raw-format node would be dropped.'),
  maxRenderLosses: z.number().int().min(0).max(10_000).optional().describe('Maximum detailed losses to return.'),
  smartTypography: z.enum(['glyph', 'source']).optional().describe('Render typographic glyphs or the punctuation the author typed.'),
  extensions: z.array(z.enum(['autolink', 'semantic-spans', 'wikilinks'])).max(3).default([]).describe('Opt-in extensions; semantic-spans is HTML-only.'),
  allowRawHtml: z.boolean().default(false).describe('Pass trusted raw HTML through on HTML output. Disabled by default.'),
  sanitizeUrls: z.boolean().default(true).describe('Block dangerous authored URL schemes. Keep enabled for untrusted input.'),
};
const markdownDialect = z.object({
  highlight: z.boolean().optional(), superscript: z.boolean().optional(), math: z.boolean().optional(),
  inlineFootnotes: z.boolean().optional(), abbreviations: z.boolean().optional(),
  fencedDivs: z.boolean().optional(), attributes: z.boolean().optional(),
}).strict().optional().describe('Opt-in Markdown flavor constructs; valid only for Markdown input.');

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function safe<T extends unknown[]>(fn: (...args: T) => unknown) {
  return async (...args: T) => {
    try { return result(await fn(...args)); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RenderLossError) {
        return { ...result({ error: message, losses: error.losses, totalLosses: error.totalLosses, truncated: error.truncated }), isError: true };
      }
      return { ...result({ error: message }), isError: true };
    }
  };
}

export async function createServer(workspaceOptions?: WorkspaceOptions): Promise<McpServer> {
  const server = new McpServer({ name: 'carve-mcp', version: '0.1.0' });
  if (workspaceOptions?.roots.length) {
    const workspace = await prepareWorkspace(workspaceOptions);
    server.registerTool('carve_read_file', {
      title: 'Read Carve workspace file',
      description: 'Read a UTF-8 text file inside an explicitly configured workspace root.',
      inputSchema: z.object({ rootIndex: z.number().int().min(0), path: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe(({ rootIndex, path }) => workspace.read(rootIndex, path)));
    server.registerTool('carve_workspace_info', {
      title: 'List configured Carve workspace roots',
      description: 'List root indexes and whether writes are enabled. Paths are intentionally not exposed.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe(() => ({ roots: workspace.roots.map((_, rootIndex) => ({ rootIndex })), allowWrite: workspace.allowWrite })));
    if (workspaceOptions.allowWrite) {
      server.registerTool('carve_write_file', {
        title: 'Write Carve workspace file',
        description: 'Dry-run by default; atomically write UTF-8 text only when dryRun is false. Overwrites require the hash returned by carve_read_file.',
        inputSchema: z.object({ rootIndex: z.number().int().min(0), path: z.string().min(1), content: sourceSchema, expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), dryRun: z.boolean().default(true) }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      }, safe(({ rootIndex, path, content, expectedSha256, dryRun }) => workspace.write(rootIndex, path, content, expectedSha256, dryRun)));
    }
  }

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
    inputSchema: z.object({ source: sourceSchema, target: z.enum(['html', 'markdown', 'plain', 'ansi']), ...renderSettings }),
    annotations: readOnly,
  }, safe(({ source: document, target, asciiHeadingIds, ...settings }) => render(document, target, {
    ...settings, asciiHeadingIds: asciiHeadingIds === 'off' ? false : asciiHeadingIds,
  })));

  server.registerTool('carve_parse', {
    title: 'Parse Carve',
    description: 'Parse and resolve Carve into its position-aware interchange AST.',
    inputSchema: z.object({ source: sourceSchema }),
    annotations: readOnly,
  }, safe(({ source: document }) => parse(document)));

  server.registerTool('carve_migrate', {
    title: 'Migrate to Carve',
    description: 'Migrate HTML, Markdown, or Djot source to Carve with fidelity diagnostics.',
    inputSchema: z.object({ source: sourceSchema, format: z.enum(['html', 'markdown', 'djot']), markdownDialect }),
    annotations: readOnly,
  }, safe(({ source: document, format: sourceFormat, markdownDialect }) => migrate(document, sourceFormat, markdownDialect)));

  return server;
}
