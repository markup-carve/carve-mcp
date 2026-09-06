import { McpServer, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import { createRequire } from 'node:module';
import { KNOWN_LINT_PLATFORMS, RenderLossError } from '@markup-carve/carve';
import * as z from 'zod/v4';
import { format as formatCarve, lint, MAX_SOURCE_BYTES, migrate, parse, render } from './tools.js';
import { authoringGuide, ruleIds, ruleIndexMarkdown, ruleMarkdown } from './resources.js';
import { lintRuleMarkdown, lintRuleNames } from './lint-rules.js';
import { prepareWorkspace, type WorkspaceOptions } from './workspace.js';
import { reviewWorkspace } from './project.js';
import { writerPrompts } from './prompts.js';
import type { ToolObserver } from './telemetry.js';

const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as { version: string };

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

const warningOutput = z.object({
  rule: z.string(), message: z.string(), line: z.number().int(), column: z.number().int(),
  start: z.number().int(), end: z.number().int(), resourceUri: z.string(), data: z.record(z.string(), z.unknown()).optional(),
}).loose();
const lintOutput = z.object({ valid: z.boolean(), warningCount: z.number().int(), warnings: z.array(warningOutput) }).loose();
const renderOutput = z.object({ value: z.string(), losses: z.array(z.unknown()), totalLosses: z.number().int(), truncated: z.boolean() }).loose();
const parseOutput = z.object({ type: z.string(), children: z.array(z.unknown()), srcByteLength: z.number().int() }).loose();
const migrateOutput = z.object({ value: z.string(), report: z.object({ schemaVersion: z.number().int(), sourceFormat: z.string(), diagnostics: z.array(z.unknown()) }).loose() }).loose();
const readOutput = z.object({ rootIndex: z.number().int(), path: z.string(), content: z.string(), sha256: z.string(), bytes: z.number().int() }).loose();
const listOutput = z.object({ rootIndex: z.number().int(), files: z.array(z.string()), truncated: z.boolean(), maxDepth: z.number().int(), limit: z.number().int() }).loose();
const workspaceInfoOutput = z.object({ roots: z.array(z.object({ rootIndex: z.number().int() })), allowWrite: z.boolean() }).loose();
const writeOutput = z.object({ rootIndex: z.number().int(), path: z.string(), dryRun: z.boolean(), created: z.boolean(), currentSha256: z.string().nullable(), sha256: z.string(), bytes: z.number().int() }).loose();
const editOutput = z.object({ rootIndex: z.number().int(), path: z.string(), expectedSha256: z.string(), changed: z.boolean(), proposedContent: z.string(), losses: z.array(z.unknown()), totalLosses: z.number().int(), truncated: z.boolean() }).loose();
const reviewOutput = z.object({ rootIndex: z.number().int(), valid: z.boolean(), filesDiscovered: z.number().int(), filesChecked: z.number().int(), warningCount: z.number().int(), ruleCounts: z.record(z.string(), z.number().int()), summary: z.object({ bySeverity: z.object({ error: z.number().int(), warning: z.number().int() }), nextActions: z.array(z.string()) }), files: z.array(z.unknown()), projectWarnings: z.array(z.unknown()), truncated: z.boolean(), totalBytes: z.number().int() }).loose();

function summary(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.warningCount === 'number') return record.warningCount === 0 ? 'No issues found.' : `Found ${record.warningCount} issue${record.warningCount === 1 ? '' : 's'}.`;
    if (Array.isArray(record.files)) return `Found ${record.files.length} document file${record.files.length === 1 ? '' : 's'}.`;
    if (typeof record.proposedContent === 'string') return record.changed ? `Formatting would change ${String(record.path)}.` : `${String(record.path)} is already canonical.`;
    if (typeof record.content === 'string' && typeof record.path === 'string') return `Read ${record.path}.`;
    if (typeof record.dryRun === 'boolean' && typeof record.path === 'string') return record.dryRun ? `Previewed the write to ${record.path}; no file changed.` : `Wrote ${record.path}.`;
    if (record.type === 'document') return 'Parsed the document successfully.';
    if (typeof record.value === 'string') return 'Produced the requested output.';
  }
  return 'Completed successfully.';
}

function result(value: unknown) {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { result: value };
  return { content: [{ type: 'text' as const, text: summary(structuredContent) }], structuredContent };
}

function observeSafely(observe: ToolObserver | undefined, event: Parameters<ToolObserver>[0]): void {
  try { observe?.(event); } catch { /* Observability must never change tool behavior. */ }
}

function safe<T extends unknown[]>(tool: string, observe: ToolObserver | undefined, fn: (...args: T) => unknown) {
  return async (...args: T) => {
    const started = performance.now();
    try {
      const value = result(await fn(...args));
      observeSafely(observe, { tool, status: 'ok', durationMs: Math.round(performance.now() - started) });
      return value;
    }
    catch (error) {
      observeSafely(observe, { tool, status: 'error', durationMs: Math.round(performance.now() - started) });
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RenderLossError) {
        return { ...result({ error: message, losses: error.losses, totalLosses: error.totalLosses, truncated: error.truncated }), isError: true };
      }
      return { ...result({ error: message }), isError: true };
    }
  };
}

export async function createServer(workspaceOptions?: WorkspaceOptions, observe?: ToolObserver): Promise<McpServer> {
  const server = new McpServer({ name: 'carve-mcp', version: packageVersion });
  if (workspaceOptions?.roots.length) {
    const workspace = await prepareWorkspace(workspaceOptions);
    server.registerTool('carve_read_file', {
      title: 'Read Carve workspace file',
      description: 'Read a UTF-8 text file inside an explicitly configured workspace root.',
      inputSchema: z.object({ rootIndex: z.number().int().min(0), path: z.string().min(1) }).strict(), outputSchema: readOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_read_file', observe, ({ rootIndex, path }) => workspace.read(rootIndex, path)));
    server.registerTool('carve_list_files', {
      title: 'List Carve workspace files',
      description: 'List supported document files inside an explicitly configured root, with bounded recursion and no host paths.',
      inputSchema: z.object({ rootIndex: z.number().int().min(0), maxDepth: z.number().int().min(0).max(25).default(10), limit: z.number().int().min(1).max(2_000).default(500) }).strict(),
      outputSchema: listOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_list_files', observe, ({ rootIndex, maxDepth, limit }) => workspace.list(rootIndex, { maxDepth, limit })));
    server.registerTool('carve_review_workspace', {
      title: 'Review Carve workspace',
      description: 'Lint Carve files and validate explicit local document links and anchors across a bounded workspace scan.',
      inputSchema: z.object({ rootIndex: z.number().int().min(0), maxDepth: z.number().int().min(0).max(25).optional(), limit: z.number().int().min(1).max(2_000).optional(), platforms: z.array(z.enum(KNOWN_LINT_PLATFORMS)).optional() }).strict(),
      outputSchema: reviewOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_review_workspace', observe, ({ rootIndex, maxDepth, limit, platforms }) => reviewWorkspace(workspace, rootIndex, {
      maxDepth: maxDepth ?? workspace.review.maxDepth ?? 10,
      limit: limit ?? workspace.review.limit ?? 500,
      platforms: platforms ?? workspace.review.platforms ?? [],
      checkLinks: workspace.review.checkLinks, checkAnchors: workspace.review.checkAnchors,
    })));
    server.registerTool('carve_prepare_edit', {
      title: 'Preview canonical Carve formatting',
      description: 'Read and canonically format a Carve workspace file, returning a hash-guarded proposal without writing.',
      inputSchema: z.object({ rootIndex: z.number().int().min(0), path: z.string().min(1) }).strict(), outputSchema: editOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_prepare_edit', observe, async ({ rootIndex, path }) => {
      if (!['.crv', '.carve'].some((extension) => path.toLowerCase().endsWith(extension))) throw new Error('Edit previews require a .crv or .carve file.');
      const current = await workspace.read(rootIndex, path);
      const proposal = formatCarve(current.content);
      return { rootIndex, path, expectedSha256: current.sha256, changed: proposal.value !== current.content, proposedContent: proposal.value, losses: proposal.losses, totalLosses: proposal.totalLosses, truncated: proposal.truncated };
    }));
    server.registerTool('carve_workspace_info', {
      title: 'List configured Carve workspace roots',
      description: 'List root indexes and whether writes are enabled. Paths are intentionally not exposed.',
      inputSchema: z.object({}).strict(),
      outputSchema: workspaceInfoOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_workspace_info', observe, () => ({ roots: workspace.roots.map((_, rootIndex) => ({ rootIndex })), allowWrite: workspace.allowWrite })));
    if (workspaceOptions.allowWrite) {
      server.registerTool('carve_write_file', {
        title: 'Write Carve workspace file',
        description: 'Dry-run by default; atomically write UTF-8 text only when dryRun is false. Overwrites require the hash returned by carve_read_file.',
        inputSchema: z.object({ rootIndex: z.number().int().min(0), path: z.string().min(1), content: sourceSchema, expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), dryRun: z.boolean().default(true) }).strict(),
        outputSchema: writeOutput,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      }, safe('carve_write_file', observe, ({ rootIndex, path, content, expectedSha256, dryRun }) => workspace.write(rootIndex, path, content, expectedSha256, dryRun)));
    }
  }

  for (const prompt of writerPrompts) {
    server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.text } }],
    }));
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
    outputSchema: lintOutput,
    annotations: readOnly,
  }, safe('carve_lint', observe, ({ source: document, platforms }) => {
    const output = lint(document, platforms);
    return { ...output, warnings: output.warnings.map((warning) => ({ ...warning, resourceUri: `carve://lint-rules/${warning.rule}` })) };
  }));

  server.registerTool('carve_format', {
    title: 'Format Carve',
    description: 'Format Carve source canonically and report any lossy raw-format nodes.',
    inputSchema: z.object({ source: sourceSchema }),
    outputSchema: renderOutput,
    annotations: readOnly,
  }, safe('carve_format', observe, ({ source: document }) => formatCarve(document)));

  server.registerTool('carve_render', {
    title: 'Render Carve',
    description: 'Render Carve to HTML, Markdown, plain text, or ANSI terminal text, with loss reporting.',
    inputSchema: z.object({ source: sourceSchema, target: z.enum(['html', 'markdown', 'plain', 'ansi']), ...renderSettings }),
    outputSchema: renderOutput,
    annotations: readOnly,
  }, safe('carve_render', observe, ({ source: document, target, asciiHeadingIds, ...settings }) => render(document, target, {
    ...settings, asciiHeadingIds: asciiHeadingIds === 'off' ? false : asciiHeadingIds,
  })));

  server.registerTool('carve_parse', {
    title: 'Parse Carve',
    description: 'Parse and resolve Carve into its position-aware interchange AST.',
    inputSchema: z.object({ source: sourceSchema }),
    outputSchema: parseOutput,
    annotations: readOnly,
  }, safe('carve_parse', observe, ({ source: document }) => parse(document)));

  server.registerTool('carve_migrate', {
    title: 'Migrate to Carve',
    description: 'Migrate HTML, Markdown, or Djot source to Carve with fidelity diagnostics.',
    inputSchema: z.object({ source: sourceSchema, format: z.enum(['html', 'markdown', 'djot']), markdownDialect }),
    outputSchema: migrateOutput,
    annotations: readOnly,
  }, safe('carve_migrate', observe, ({ source: document, format: sourceFormat, markdownDialect }) => migrate(document, sourceFormat, markdownDialect)));

  return server;
}
