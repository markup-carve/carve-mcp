import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  AST_VERSION,
  CarveRenderError,
  createWriterRegistry,
  encodeTree,
  formatWithDiagnostics,
  importDocument,
  lint as lintV2,
  parse as parseV2,
  parseWithDiagnostics,
  renderWithDiagnostics,
  stringOffsetOfByte,
  tabsExtensions,
  tabsRenderer,
  validateTree,
  write,
  type Diagnostic,
  type DocumentNode,
  type ExtensionDefinition,
  type ExtensionRenderer,
  type HeadingIds,
  type IncludeConfig,
  type RenderOptions,
} from '@markup-carve/carve/v2';

const require = createRequire(import.meta.url);
const enginePackagePath = require.resolve('@markup-carve/carve/package.json');
const enginePackage = require(enginePackagePath) as { version: string };

/** The engine is the 0.2 API of the pinned `@markup-carve/carve` package. */
export const ENGINE_VERSION = `${enginePackage.version} (v2, AST ${AST_VERSION})`;
export const SPEC_VERSION = '0.2';
export const LINT_PLATFORMS = ['github'] as const;
export type LintPlatform = typeof LINT_PLATFORMS[number];
export type { Diagnostic, DocumentNode, HeadingIds };
export { CarveRenderError };

export interface Warning {
  rule: string;
  message: string;
  severity: Diagnostic['severity'];
  channel: Diagnostic['channel'];
  line: number;
  column: number;
  /** UTF-16 offsets into the text the diagnostic names (the source, or `file`). */
  start: number;
  end: number;
  path?: string;
  file?: string;
}

export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === '\n') { line++; lineStart = index + 1; }
  }
  return { line, column: Array.from(text.slice(lineStart, offset)).length + 1 };
}

/** A diagnostic as the MCP warning shape; `text` is the source its range indexes, if known. */
export function toWarning(diagnostic: Diagnostic, text: string | undefined): Warning {
  const known = text !== undefined && diagnostic.range !== undefined;
  const start = known ? stringOffsetOfByte(text, diagnostic.range!.startOffset) : 0;
  const end = known ? stringOffsetOfByte(text, diagnostic.range!.endOffset) : 0;
  return {
    rule: diagnostic.code, message: diagnostic.message, severity: diagnostic.severity, channel: diagnostic.channel,
    ...(text === undefined ? { line: 1, column: 1 } : lineColumn(text, start)), start, end,
    ...(diagnostic.path !== undefined ? { path: diagnostic.path } : {}),
    ...(diagnostic.file !== undefined ? { file: diagnostic.file } : {}),
  };
}

export function lintDiagnostics(source: string, platforms: readonly LintPlatform[], includes?: IncludeConfig): Diagnostic[] {
  return lintV2(source, { platforms, ...(includes ? { includes } : {}) });
}

/** The 0.1 extensions this server offered; none has a 0.2 definition yet. */
export const UNPORTED_EXTENSIONS = ['autolink', 'semantic-spans', 'wikilinks'] as const;
export type ExtensionName = 'tabs' | typeof UNPORTED_EXTENSIONS[number];

export function extensionOptions(names: readonly ExtensionName[] = []): { extensions: ExtensionDefinition[]; renderers: Record<string, ExtensionRenderer> } {
  const unported = names.find((name): name is typeof UNPORTED_EXTENSIONS[number] => (UNPORTED_EXTENSIONS as readonly string[]).includes(name));
  if (unported) throw new Error(`The ${unported} extension is not available in Carve 0.2 yet; the 0.2 extension API is provisional and has no ${unported} definition.`);
  if (!names.includes('tabs')) return { extensions: [], renderers: {} };
  return { extensions: [...tabsExtensions], renderers: { 'carve.tabs': tabsRenderer } };
}

export interface HtmlResult { html: string; diagnostics: Diagnostic[]; suppressedDiagnostics: number }

export function renderHtml(input: string | DocumentNode, options: RenderOptions): HtmlResult {
  return renderWithDiagnostics(input, options);
}

/** The writer targets of 0.1 that 0.2 reserves for its writer registry. */
export const REGISTRY_TARGETS = { markdown: 'markdown', plain: 'plain-text', ansi: 'ansi' } as const;
export type RegistryTarget = keyof typeof REGISTRY_TARGETS;

const writers = createWriterRegistry();

export function writerAvailable(target: RegistryTarget): boolean {
  return writers.has(REGISTRY_TARGETS[target]);
}

export function writeTarget(target: RegistryTarget, document: DocumentNode, options: { strictLosses?: boolean } = {}) {
  const name = REGISTRY_TARGETS[target];
  if (!writers.has(name)) {
    throw new Error(`The ${name} writer is not available yet in Carve 0.2; the engine reserves the target and registers the writer once it is ported.`);
  }
  return writers.write(name, document, options);
}

export function parseTree(source: string, options: { includes?: IncludeConfig; positions?: boolean; extensions?: readonly ExtensionDefinition[] } = {}): DocumentNode {
  return parseV2(source, options);
}

export function parseTreeWithDiagnostics(source: string, options: { includes?: IncludeConfig; extensions?: readonly ExtensionDefinition[] } = {}) {
  return parseWithDiagnostics(source, options);
}

/** The JSON value of a tree, as `encodeTree` writes it. */
export function treeJson(document: DocumentNode): Record<string, unknown> {
  return JSON.parse(encodeTree(document)) as Record<string, unknown>;
}

export function assertTree(value: unknown): asserts value is DocumentNode {
  validateTree(value);
}

export function writeCarve(document: DocumentNode): string {
  return write(document);
}

export function formatSource(source: string, alignTables: boolean) {
  return formatWithDiagnostics(source, alignTables ? { alignTables: true } : {});
}

export function importHtml(html: string) {
  return importDocument(html, { from: 'html' });
}

const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_BUFFER = 64 * 1024 * 1024;

/** `carve2`, the 0.2 command line of the pinned engine package. */
function carve2Path(): string {
  return join(dirname(enginePackagePath), 'dist', 'cli2.js');
}

export interface Carve2Run { status: number; stdout: string; stderr: string }

/**
 * Run `carve2` on `input` as standard input.
 *
 * Only for the 0.2 calls the library does not export (the upgrade tool and the
 * Markdown and Djot importers); the arguments are fixed by the caller, never
 * taken from a client.
 */
export function runCarve2(args: readonly string[], input: string): Carve2Run {
  const run = spawnSync(process.execPath, [carve2Path(), ...args, '-'], {
    input, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (typeof run.status !== 'number') throw new Error(`carve2 did not finish${run.signal ? ` (${run.signal})` : ''}.`);
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}
