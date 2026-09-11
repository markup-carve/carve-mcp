import { McpServer, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import { createRequire } from 'node:module';
import { KNOWN_LINT_PLATFORMS, RenderLossError } from '@markup-carve/carve';
import * as z from 'zod/v4';
import { applyReversibleStructuredAstPatch, applyStructuredAstPatch, createReversibleStructuredAstPatch, createStructuredAstPatch, format as formatCarve, lint, MAX_AST_PATCH_OPERATIONS, MAX_SEMANTIC_EDIT_STEPS, MAX_SOURCE_BYTES, migrate, parse, planSemanticAstEdit, render, selectAstNodes, type SemanticAstEdit, type SemanticAstEditStep } from './tools.js';
import { authoringGuide, ruleIds, ruleIndexMarkdown, ruleMarkdown } from './resources.js';
import { lintRuleMarkdown, lintRuleNames } from './lint-rules.js';
import { prepareWorkspace, type WorkspaceOptions } from './workspace.js';
import { reviewWorkspace } from './project.js';
import { writerPrompts } from './prompts.js';
import type { ToolObserver } from './telemetry.js';
import { prepareWorkspaceEdits, unifiedDiff } from './edits.js';
import { createSourcePatch } from './source-patch.js';
import { diagnoseAndFix } from './diagnostics.js';
import { buildReferenceGraph } from './reference-graph.js';
import { compatibilityMatrix } from './compatibility.js';
import { toolEnabled, type ToolProfile } from './tool-profile.js';

const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as { version: string };

const sourceSchema = z.string().describe(`Document source (maximum ${MAX_SOURCE_BYTES} UTF-8 bytes)`);
const sourceEditOutput = z.object({ start: z.number().int().min(0).describe('Inclusive UTF-8 byte offset'), end: z.number().int().min(0).describe('Exclusive UTF-8 byte offset'), replacement: z.string(),
  kind: z.enum(['formatting', 'syntax-migration', 'quick-fix', 'refactor']), code: z.string().min(1) }).strict();
const sourcePatchOutput = z.object({ version: z.literal(1), sourceFingerprint: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/),
  sourceBytes: z.number().int().min(0), edits: z.array(sourceEditOutput),
  unresolved: z.array(sourceEditOutput.extend({ message: z.string().min(1) })) }).strict();
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
const diagnosticFixOutput = lintOutput.extend({
  fixes: z.array(z.object({ id: z.string(), rule: z.string(), message: z.string(), applicability: z.enum(['automatic', 'writer-review']), edit: sourceEditOutput.nullable() }).strict()),
  appliedFixIds: z.array(z.string()), value: z.string(), remainingWarningCount: z.number().int(), remainingValid: z.boolean(),
  patch: sourcePatchOutput, undoPatch: sourcePatchOutput,
}).loose();
const renderOutput = z.object({ value: z.string(), losses: z.array(z.unknown()), totalLosses: z.number().int(), truncated: z.boolean() }).loose();
const parseOutput = z.object({ type: z.string(), children: z.array(z.unknown()), srcByteLength: z.number().int() }).loose();
const patchChangeOutput = z.object({ kind: z.enum(['add', 'remove', 'replace']), path: z.string(), target: z.string(), summary: z.string() }).loose();
const astPatchCreateOutput = z.object({ operations: z.array(z.unknown()), operationCount: z.number().int(), changes: z.array(patchChangeOutput), changeCount: z.number().int() }).loose();
const astPatchApplyOutput = z.object({ ast: z.unknown(), source: z.string() }).loose();
const reversiblePatchSchema = z.object({ version: z.number().int().min(0).max(255),
  forward: z.array(z.unknown()).max(MAX_AST_PATCH_OPERATIONS), inverse: z.array(z.unknown()).max(MAX_AST_PATCH_OPERATIONS),
  beforeFingerprint: z.string(), afterFingerprint: z.string(), changes: z.array(patchChangeOutput).optional() }).strict();
const reversibleAstPatchOutput = z.object({ version: z.number().int(), forward: z.array(z.unknown()), inverse: z.array(z.unknown()),
  beforeFingerprint: z.string(), afterFingerprint: z.string(), changes: z.array(patchChangeOutput) }).loose();
const reversibleAstPatchApplyOutput = z.object({ direction: z.enum(['forward', 'inverse']), ast: z.unknown(), source: z.string(), sourcePatch: sourcePatchOutput }).loose();
const astSelector = z.object({ kind: z.enum(['heading-id', 'footnote-label', 'node-type', 'ast-path']), value: z.string().min(1).max(4096) }).strict();
const astSelectionOutput = z.object({ selector: astSelector, matchCount: z.number().int(), matches: z.array(z.object({ path: z.string(), type: z.string(), identity: z.string().optional(), preview: z.string(), previewTruncated: z.boolean() }).loose()), truncated: z.boolean() }).loose();
const semanticEditKind = z.enum(['replace-text', 'rename-heading-id', 'delete-node', 'replace-node', 'insert-before', 'insert-after']);
const semanticEdit = z.object({ kind: semanticEditKind, text: z.string().optional(), id: z.string().optional(), node: z.unknown().optional() }).strict();
const semanticEditStep = z.object({ selector: astSelector, edit: semanticEdit }).strict();
const semanticEditStepOutput = z.object({ selector: astSelector, edit: z.object({ kind: semanticEditKind }).loose(),
  match: z.object({ path: z.string(), type: z.string(), identity: z.string().optional(), preview: z.string(), previewTruncated: z.boolean() }).loose(), notices: z.array(z.string()) }).loose();
const semanticEditPlanOutput = z.object({
  selector: astSelector, edit: z.object({ kind: semanticEditKind }).loose(),
  match: z.object({ path: z.string(), type: z.string(), identity: z.string().optional(), preview: z.string(), previewTruncated: z.boolean() }).loose(),
  notices: z.array(z.string()),
  editCount: z.number().int(), steps: z.array(semanticEditStepOutput),
  reversiblePatch: reversibleAstPatchOutput, sourcePatch: sourcePatchOutput,
}).loose();
const migrateOutput = z.object({ value: z.string(), report: z.object({ schemaVersion: z.number().int(), sourceFormat: z.string(), diagnostics: z.array(z.unknown()) }).loose() }).loose();
const compatibilityOutput = z.object({ compatible: z.boolean(), targetCount: z.number().int(), summary: z.object({ compatible: z.number().int(), warning: z.number().int(), lossy: z.number().int() }), targets: z.array(z.unknown()) }).loose();
const readOutput = z.object({ rootIndex: z.number().int(), path: z.string(), content: z.string(), sha256: z.string(), bytes: z.number().int() }).loose();
const listOutput = z.object({ rootIndex: z.number().int(), files: z.array(z.string()), truncated: z.boolean(), maxDepth: z.number().int(), limit: z.number().int() }).loose();
const workspaceInfoOutput = z.object({ roots: z.array(z.object({ rootIndex: z.number().int() })), allowWrite: z.boolean() }).loose();
const writeOutput = z.object({ rootIndex: z.number().int(), path: z.string(), dryRun: z.boolean(), created: z.boolean(), currentSha256: z.string().nullable(), sha256: z.string(), bytes: z.number().int() }).loose();
const editOutput = z.object({ rootIndex: z.number().int(), path: z.string(), expectedSha256: z.string(), changed: z.boolean(), proposedContent: z.string(), unifiedDiff: z.string(), diffTruncated: z.boolean(), patch: sourcePatchOutput.nullable(), losses: z.array(z.unknown()), totalLosses: z.number().int(), truncated: z.boolean() }).loose();
const batchEditOutput = z.object({ rootIndex: z.number().int(), filesDiscovered: z.number().int(), filesPrepared: z.number().int(), filesChanged: z.number().int(), errorCount: z.number().int(), items: z.array(z.unknown()), truncated: z.boolean(), totalBytes: z.number().int() }).loose();
const reviewOutput = z.object({ rootIndex: z.number().int(), valid: z.boolean(), filesDiscovered: z.number().int(), filesChecked: z.number().int(), warningCount: z.number().int(), ruleCounts: z.record(z.string(), z.number().int()), summary: z.object({ bySeverity: z.object({ error: z.number().int(), warning: z.number().int() }), nextActions: z.array(z.string()) }), fixPlan: z.object({ automatic: z.array(z.unknown()), writerReview: z.array(z.unknown()) }), files: z.array(z.unknown()), projectWarnings: z.array(z.unknown()), truncated: z.boolean(), totalBytes: z.number().int() }).loose();
const referenceGraphOutput = z.object({ rootIndex: z.number().int(), definitions: z.array(z.unknown()), references: z.array(z.unknown()), brokenReferences: z.array(z.unknown()), orphans: z.array(z.unknown()), errors: z.array(z.unknown()), counts: z.object({ definitions: z.number().int(), references: z.number().int(), broken: z.number().int(), orphans: z.number().int() }), truncated: z.boolean(), totalBytes: z.number().int() }).loose();

function summary(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.warningCount === 'number') return record.warningCount === 0 ? 'No issues found.' : `Found ${record.warningCount} issue${record.warningCount === 1 ? '' : 's'}.`;
    if (typeof record.filesPrepared === 'number') return `Prepared ${record.filesPrepared} file preview${record.filesPrepared === 1 ? '' : 's'}; ${record.filesChanged} would change.`;
    if (Array.isArray(record.files)) return `Found ${record.files.length} document file${record.files.length === 1 ? '' : 's'}.`;
    if (typeof record.proposedContent === 'string') return record.changed ? `Formatting would change ${String(record.path)}.` : `${String(record.path)} is already canonical.`;
    if (typeof record.content === 'string' && typeof record.path === 'string') return `Read ${record.path}.`;
    if (typeof record.dryRun === 'boolean' && typeof record.path === 'string') return record.dryRun ? `Previewed the write to ${record.path}; no file changed.` : `Wrote ${record.path}.`;
    if (record.type === 'document') return 'Parsed the document successfully.';
    if (typeof record.matchCount === 'number') return `Found ${record.matchCount} matching AST node${record.matchCount === 1 ? '' : 's'}.`;
    if (record.sourcePatch && record.match && record.edit) return typeof record.editCount === 'number' && record.editCount > 1
      ? `Planned ${record.editCount} atomic semantic edits; no file was changed.`
      : `Planned ${String((record.edit as Record<string, unknown>).kind)} for one matching AST node; no file was changed.`;
    if (typeof record.operationCount === 'number') return `Created ${record.operationCount} AST patch operation${record.operationCount === 1 ? '' : 's'}.`;
    if (Array.isArray(record.forward) && Array.isArray(record.inverse)) return `Created a reversible AST patch with ${record.forward.length} forward and ${record.inverse.length} inverse operations.`;
    if (record.sourcePatch && typeof record.direction === 'string') return `${record.direction === 'inverse' ? 'Reverted' : 'Applied'} the AST patch and prepared a stale-guarded source edit.`;
    if (record.ast && typeof record.source === 'string') return 'Applied the AST patch and produced canonical Carve source.';
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

export async function createServer(workspaceOptions?: WorkspaceOptions, observe?: ToolObserver, toolProfile: ToolProfile = 'all'): Promise<McpServer> {
  const server = new McpServer({ name: 'carve-mcp', version: packageVersion });
  if (workspaceOptions?.roots.length) {
    const workspace = await prepareWorkspace(workspaceOptions);
    if (toolEnabled(toolProfile, 'carve_read_file')) server.registerTool('carve_read_file', {
      title: 'Read Carve workspace file',
      description: 'Read a UTF-8 text file inside an explicitly configured workspace root.',
      inputSchema: z.object({ rootIndex: z.number().int().min(0), path: z.string().min(1) }).strict(), outputSchema: readOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_read_file', observe, ({ rootIndex, path }) => workspace.read(rootIndex, path)));
    if (toolEnabled(toolProfile, 'carve_list_files')) server.registerTool('carve_list_files', {
      title: 'List Carve workspace files',
      description: 'List supported document files inside an explicitly configured root, with bounded recursion and no host paths.',
      inputSchema: z.object({ rootIndex: z.number().int().min(0), maxDepth: z.number().int().min(0).max(25).default(10), limit: z.number().int().min(1).max(2_000).default(500) }).strict(),
      outputSchema: listOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_list_files', observe, ({ rootIndex, maxDepth, limit }) => workspace.list(rootIndex, { maxDepth, limit })));
    if (toolEnabled(toolProfile, 'carve_review_workspace')) server.registerTool('carve_review_workspace', {
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
    if (toolEnabled(toolProfile, 'carve_reference_graph')) server.registerTool('carve_reference_graph', {
      title: 'Build Carve reference graph',
      description: 'Index headings, footnotes, abbreviations, links, and images across bounded Carve workspace files; report resolved edges, broken references, and orphaned definitions.',
      inputSchema: z.object({ rootIndex: z.number().int().min(0), maxDepth: z.number().int().min(0).max(25).optional(), limit: z.number().int().min(1).max(2_000).optional() }).strict(),
      outputSchema: referenceGraphOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_reference_graph', observe, ({ rootIndex, maxDepth, limit }) => buildReferenceGraph(workspace, rootIndex, {
      maxDepth: maxDepth ?? workspace.review.maxDepth ?? 10,
      limit: limit ?? workspace.review.limit ?? 500,
    })));
    if (toolEnabled(toolProfile, 'carve_prepare_edit')) server.registerTool('carve_prepare_edit', {
      title: 'Preview canonical Carve formatting',
      description: 'Read and canonically format a Carve workspace file without writing. A lossless result includes a stale-guarded patch with UTF-8 byte ranges; a lossy writer-review result has patch: null.',
      inputSchema: z.object({ rootIndex: z.number().int().min(0), path: z.string().min(1) }).strict(), outputSchema: editOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_prepare_edit', observe, async ({ rootIndex, path }) => {
      if (!['.crv', '.carve'].some((extension) => path.toLowerCase().endsWith(extension))) throw new Error('Edit previews require a .crv or .carve file.');
      const current = await workspace.read(rootIndex, path);
      const proposal = formatCarve(current.content);
      const patch = proposal.totalLosses === 0
        ? createSourcePatch(current.content, proposal.value, 'formatting', 'canonical-format')
        : null;
      const diff = unifiedDiff(path, current.content, proposal.value);
      return { rootIndex, path, expectedSha256: current.sha256, changed: proposal.value !== current.content, proposedContent: proposal.value,
        unifiedDiff: diff.value, diffTruncated: diff.truncated, patch, losses: proposal.losses, totalLosses: proposal.totalLosses, truncated: proposal.truncated };
    }));
    if (toolEnabled(toolProfile, 'carve_prepare_workspace_edits')) server.registerTool('carve_prepare_workspace_edits', {
      title: 'Preview canonical formatting across a workspace',
      description: 'Prepare bounded formatting proposals and unified diffs without writing. Lossless items include stale-guarded UTF-8 byte patches; lossy writer-review items have patch: null.',
      inputSchema: z.object({
        rootIndex: z.number().int().min(0), paths: z.array(z.string().min(1)).max(100).optional(),
        maxDepth: z.number().int().min(0).max(25).default(10), limit: z.number().int().min(1).max(100).default(100),
        maxDiffBytes: z.number().int().min(1_000).max(200_000).default(100_000),
        includeContent: z.boolean().default(false),
      }).strict(),
      outputSchema: batchEditOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_prepare_workspace_edits', observe, ({ rootIndex, paths, maxDepth, limit, maxDiffBytes, includeContent }) => (
      prepareWorkspaceEdits(workspace, rootIndex, { paths, maxDepth, limit, maxDiffBytes, includeContent })
    )));
    if (toolEnabled(toolProfile, 'carve_workspace_info')) server.registerTool('carve_workspace_info', {
      title: 'List configured Carve workspace roots',
      description: 'List root indexes and whether writes are enabled. Paths are intentionally not exposed.',
      inputSchema: z.object({}).strict(),
      outputSchema: workspaceInfoOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safe('carve_workspace_info', observe, () => ({ roots: workspace.roots.map((_, rootIndex) => ({ rootIndex })), allowWrite: workspace.allowWrite })));
    if (workspaceOptions.allowWrite && toolEnabled(toolProfile, 'carve_write_file')) {
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

  if (toolEnabled(toolProfile, 'carve_lint')) server.registerTool('carve_lint', {
    title: 'Lint Carve',
    description: 'Check Carve source for author-facing problems and silent degradation.',
    inputSchema: z.object({ source: sourceSchema, platforms: z.array(z.enum(KNOWN_LINT_PLATFORMS)).default([]) }),
    outputSchema: lintOutput,
    annotations: readOnly,
  }, safe('carve_lint', observe, ({ source: document, platforms }) => {
    const output = lint(document, platforms);
    return { ...output, warnings: output.warnings.map((warning) => ({ ...warning, resourceUri: `carve://lint-rules/${warning.rule}` })) };
  }));

  if (toolEnabled(toolProfile, 'carve_diagnose_and_fix')) server.registerTool('carve_diagnose_and_fix', {
    title: 'Diagnose and fix Carve',
    description: 'Diagnose Carve source, propose bounded fixes, and optionally apply selected safe fix IDs with forward and undo patches. Writer-review fixes are never applied automatically.',
    inputSchema: z.object({ source: sourceSchema, platforms: z.array(z.enum(KNOWN_LINT_PLATFORMS)).default([]), applyFixIds: z.array(z.string()).max(100).default([]) }).strict(),
    outputSchema: diagnosticFixOutput,
    annotations: readOnly,
  }, safe('carve_diagnose_and_fix', observe, ({ source: document, platforms, applyFixIds }) => {
    const output = diagnoseAndFix(document, platforms, applyFixIds);
    return { ...output, warnings: output.warnings.map((warning) => ({ ...warning, resourceUri: `carve://lint-rules/${warning.rule}` })) };
  }));

  if (toolEnabled(toolProfile, 'carve_format')) server.registerTool('carve_format', {
    title: 'Format Carve',
    description: 'Format Carve source canonically and report any lossy raw-format nodes.',
    inputSchema: z.object({ source: sourceSchema }),
    outputSchema: renderOutput,
    annotations: readOnly,
  }, safe('carve_format', observe, ({ source: document }) => formatCarve(document)));

  if (toolEnabled(toolProfile, 'carve_render')) server.registerTool('carve_render', {
    title: 'Render Carve',
    description: 'Render Carve to HTML, Markdown, plain text, or ANSI terminal text, with loss reporting.',
    inputSchema: z.object({ source: sourceSchema, target: z.enum(['html', 'markdown', 'plain', 'ansi']), ...renderSettings }),
    outputSchema: renderOutput,
    annotations: readOnly,
  }, safe('carve_render', observe, ({ source: document, target, asciiHeadingIds, ...settings }) => render(document, target, {
    ...settings, asciiHeadingIds: asciiHeadingIds === 'off' ? false : asciiHeadingIds,
  })));

  if (toolEnabled(toolProfile, 'carve_check_targets')) server.registerTool('carve_check_targets', {
    title: 'Check Carve publishing targets',
    description: 'Compare one Carve document across HTML, Markdown, plain text, ANSI, GitHub, WordPress, and PDF-stage profiles, returning target-specific warnings, losses, and fallbacks.',
    inputSchema: z.object({ source: sourceSchema, targets: z.array(z.enum(['html', 'markdown', 'plain', 'ansi', 'github', 'wordpress', 'pdf'])).min(1).max(7).default(['html', 'markdown', 'github', 'wordpress', 'pdf']) }).strict(),
    outputSchema: compatibilityOutput,
    annotations: readOnly,
  }, safe('carve_check_targets', observe, ({ source: document, targets }) => compatibilityMatrix(document, targets)));

  if (toolEnabled(toolProfile, 'carve_parse')) server.registerTool('carve_parse', {
    title: 'Parse Carve',
    description: 'Parse and resolve Carve into its position-aware interchange AST.',
    inputSchema: z.object({ source: sourceSchema }),
    outputSchema: parseOutput,
    annotations: readOnly,
  }, safe('carve_parse', observe, ({ source: document }) => parse(document)));

  if (toolEnabled(toolProfile, 'carve_create_ast_patch')) server.registerTool('carve_create_ast_patch', {
    title: 'Create structured AST patch',
    description: 'Compare two PART 12 Carve ASTs and return position-independent add, replace, and remove operations.',
    inputSchema: z.object({
      before: z.unknown().describe(`PART 12 AST before the edit (maximum ${MAX_SOURCE_BYTES} JSON bytes)`),
      after: z.unknown().describe(`PART 12 AST after the edit (maximum ${MAX_SOURCE_BYTES} JSON bytes)`),
    }),
    outputSchema: astPatchCreateOutput,
    annotations: readOnly,
  }, safe('carve_create_ast_patch', observe, ({ before, after }) => createStructuredAstPatch(before, after)));

  if (toolEnabled(toolProfile, 'carve_apply_ast_patch')) server.registerTool('carve_apply_ast_patch', {
    title: 'Apply structured AST patch',
    description: 'Validate and apply structured operations to a PART 12 Carve AST, returning the patched AST and canonical Carve source.',
    inputSchema: z.object({
      ast: z.unknown().describe(`PART 12 base AST (maximum ${MAX_SOURCE_BYTES} JSON bytes)`),
      operations: z.array(z.unknown()).max(MAX_AST_PATCH_OPERATIONS)
        .describe(`Structured patch operations (maximum ${MAX_AST_PATCH_OPERATIONS} operations and ${MAX_SOURCE_BYTES} JSON bytes)`),
    }),
    outputSchema: astPatchApplyOutput,
    annotations: readOnly,
  }, safe('carve_apply_ast_patch', observe, ({ ast, operations }) => applyStructuredAstPatch(ast, operations)));

  if (toolEnabled(toolProfile, 'carve_select_ast_nodes')) server.registerTool('carve_select_ast_nodes', {
    title: 'Find AST nodes by semantic selector',
    description: 'Resolve a heading ID, footnote label, node type, or current AST path to reviewable PART 12 AST paths without silently choosing among multiple matches.',
    inputSchema: z.object({ ast: z.unknown().describe(`PART 12 AST (maximum ${MAX_SOURCE_BYTES} JSON bytes)`), selector: astSelector }),
    outputSchema: astSelectionOutput, annotations: readOnly,
  }, safe('carve_select_ast_nodes', observe, ({ ast, selector }) => selectAstNodes(ast, selector)));

  if (toolEnabled(toolProfile, 'carve_plan_ast_edit')) server.registerTool('carve_plan_ast_edit', {
    title: 'Plan a semantic AST edit',
    description: 'Plan one or more atomic semantic AST edits and return a human-readable, reversible, stale-guarded source patch without writing the document.',
    inputSchema: z.object({ source: sourceSchema, selector: astSelector, edit: semanticEdit,
      then: z.array(semanticEditStep).max(MAX_SEMANTIC_EDIT_STEPS - 1).default([])
        .describe(`Additional atomic edits resolved against the original source (maximum ${MAX_SEMANTIC_EDIT_STEPS} total steps).`) }),
    outputSchema: semanticEditPlanOutput, annotations: readOnly,
  }, safe('carve_plan_ast_edit', observe, ({ source, selector, edit, then }) => planSemanticAstEdit(source, selector, edit as SemanticAstEdit, then as SemanticAstEditStep[])));

  if (toolEnabled(toolProfile, 'carve_create_reversible_ast_patch')) server.registerTool('carve_create_reversible_ast_patch', {
    title: 'Create reversible AST patch',
    description: 'Compare two PART 12 ASTs and return forward and inverse operations with semantic stale-edit fingerprints.',
    inputSchema: z.object({
      before: z.unknown().describe(`PART 12 AST before the edit (maximum ${MAX_SOURCE_BYTES} JSON bytes)`),
      after: z.unknown().describe(`PART 12 AST after the edit (maximum ${MAX_SOURCE_BYTES} JSON bytes)`),
    }), outputSchema: reversibleAstPatchOutput, annotations: readOnly,
  }, safe('carve_create_reversible_ast_patch', observe, ({ before, after }) => createReversibleStructuredAstPatch(before, after)));

  if (toolEnabled(toolProfile, 'carve_apply_reversible_ast_patch')) server.registerTool('carve_apply_reversible_ast_patch', {
    title: 'Preview reversible AST patch as source edits',
    description: 'Verify a reversible AST patch against source, apply or undo it, and return a minimal stale-guarded UTF-8 source edit without writing files.',
    inputSchema: z.object({
      source: sourceSchema,
      patch: reversiblePatchSchema.describe(`Version 1 reversible AST patch (maximum ${MAX_SOURCE_BYTES} JSON bytes and ${MAX_AST_PATCH_OPERATIONS} operations per direction)`),
      inverse: z.boolean().default(false).describe('Apply inverse operations to undo the patch.'),
    }), outputSchema: reversibleAstPatchApplyOutput, annotations: readOnly,
  }, safe('carve_apply_reversible_ast_patch', observe, ({ source, patch, inverse }) => applyReversibleStructuredAstPatch(source, patch, inverse)));

  if (toolEnabled(toolProfile, 'carve_migrate')) server.registerTool('carve_migrate', {
    title: 'Migrate to Carve',
    description: 'Migrate HTML, Markdown, or Djot source to Carve with fidelity diagnostics.',
    inputSchema: z.object({ source: sourceSchema, format: z.enum(['html', 'markdown', 'djot']), markdownDialect }),
    outputSchema: migrateOutput,
    annotations: readOnly,
  }, safe('carve_migrate', observe, ({ source: document, format: sourceFormat, markdownDialect }) => migrate(document, sourceFormat, markdownDialect)));

  return server;
}
