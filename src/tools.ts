import {
  carveToAnsiWithReport,
  carveToAstJson,
  carveToCarveWithReport,
  carveToHtmlWithReport,
  carveToMarkdownWithReport,
  carveToPlainTextWithReport,
  applyAstPatch,
  autolink,
  createAstPatch,
  fromAstJson,
  renderCarve,
  toAstJson,
  semanticSpan,
  wikilinks,
  lintCarve,
  migrateDjot,
  migrateHtml,
  migrateMarkdown,
  type LintPlatform,
  type MigrationResult,
  type RenderResult,
  type CarveExtension,
  type MarkdownDialect,
  type AstJsonDocument,
  type AstPatchOperation,
} from '@markup-carve/carve';
import { createSourcePatch } from './source-patch.js';

export const MAX_SOURCE_BYTES = 1_000_000;
export const MAX_AST_PATCH_OPERATIONS = 1_000;
export type RenderTarget = 'html' | 'markdown' | 'plain' | 'ansi';
export type SourceFormat = 'html' | 'markdown' | 'djot';
export type RenderPreset = 'default' | 'portable' | 'static-html';
export type ExtensionName = 'autolink' | 'semantic-spans' | 'wikilinks';
type AsciiHeadingIdMode = boolean | 'fold' | 'strict';
export interface RenderSettings {
  preset?: RenderPreset;
  asciiHeadingIds?: AsciiHeadingIdMode;
  lowercaseHeadingIds?: boolean;
  strictLosses?: boolean;
  maxRenderLosses?: number;
  smartTypography?: 'glyph' | 'source';
  extensions?: ExtensionName[];
  allowRawHtml?: boolean;
  sanitizeUrls?: boolean;
}

function extensionInstances(names: ExtensionName[] = []): CarveExtension[] {
  return names.map((name) => {
    switch (name) {
      case 'autolink': return autolink();
      case 'semantic-spans': return semanticSpan();
      case 'wikilinks': return wikilinks();
    }
  });
}

function renderOptions(settings: RenderSettings) {
  const portable = settings.preset === 'portable';
  return {
    asciiHeadingIds: settings.asciiHeadingIds ?? (portable ? 'fold' : undefined),
    lowercaseHeadingIds: settings.lowercaseHeadingIds ?? (portable ? true : undefined),
    strictLosses: settings.strictLosses,
    maxRenderLosses: settings.maxRenderLosses,
    smartTypography: settings.smartTypography,
    extensions: extensionInstances(settings.extensions),
    allowRawHtml: settings.allowRawHtml ?? false,
    sanitizeUrls: settings.sanitizeUrls ?? true,
  };
}

export function validateSource(source: string): void {
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(`Source is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES} bytes.`);
  }
}

export function lint(source: string, platforms: LintPlatform[] = []) {
  validateSource(source);
  const warnings = lintCarve(source, { platforms });
  return { valid: warnings.length === 0, warningCount: warnings.length, warnings };
}

export function format(source: string): RenderResult {
  validateSource(source);
  return carveToCarveWithReport(source);
}

export function render(source: string, target: RenderTarget, settings: RenderSettings = {}): RenderResult {
  validateSource(source);
  if (settings.preset === 'static-html' && target !== 'html') {
    throw new Error('The static-html preset is only valid for the HTML target.');
  }
  if (settings.extensions?.includes('semantic-spans') && target !== 'html') {
    throw new Error('The semantic-spans extension is only valid for the HTML target.');
  }
  const options = renderOptions(settings);
  switch (target) {
    case 'html': return carveToHtmlWithReport(source, settings.preset === 'static-html' ? { ...options, mode: 'static' } : options);
    case 'markdown': return carveToMarkdownWithReport(source, options);
    case 'plain': return carveToPlainTextWithReport(source, options);
    case 'ansi': return carveToAnsiWithReport(source, options);
  }
}

export function parse(source: string) {
  validateSource(source);
  return carveToAstJson(source);
}

function validateStructuredPayload(value: unknown, label: string): number {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new Error(`${label} must be JSON-serializable.`); }
  if (serialized === undefined) throw new Error(`${label} must be JSON-serializable.`);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(`${label} is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES} bytes.`);
  }
  return bytes;
}

function validateAst(value: unknown, label: string): AstJsonDocument {
  const bytes = validateStructuredPayload(value, label);
  fromAstJson(value as AstJsonDocument, bytes);
  return value as AstJsonDocument;
}

export function createStructuredAstPatch(before: unknown, after: unknown) {
  const beforeAst = validateAst(before, 'Before AST');
  const afterAst = validateAst(after, 'After AST');
  const operations = createAstPatch(beforeAst, afterAst).sort((left, right) => {
    const leftPoints = Array.from(left.path, (character) => character.codePointAt(0)!);
    const rightPoints = Array.from(right.path, (character) => character.codePointAt(0)!);
    for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
      if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
    }
    return leftPoints.length - rightPoints.length;
  });
  if (operations.length > MAX_AST_PATCH_OPERATIONS) {
    throw new Error(`Patch has ${operations.length} operations; the limit is ${MAX_AST_PATCH_OPERATIONS}.`);
  }
  validateStructuredPayload(operations, 'Patch operations');
  return { operations, operationCount: operations.length };
}

function semanticAst(value: unknown, stripMetadata = true): unknown {
  if (Array.isArray(value)) return value.map((item) => semanticAst(item, stripMetadata));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
    .filter((key) => !stripMetadata || (key !== 'pos' && key !== 'srcByteLength'))
    .map((key) => [key, semanticAst(record[key], stripMetadata && key !== 'keyValues')]));
}

function astFingerprint(ast: AstJsonDocument): string {
  const bytes = Buffer.from(JSON.stringify(semanticAst(ast)));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export interface ReversibleStructuredAstPatch {
  version: 1;
  forward: AstPatchOperation[];
  inverse: AstPatchOperation[];
  beforeFingerprint: string;
  afterFingerprint: string;
}

export function createReversibleStructuredAstPatch(before: unknown, after: unknown): ReversibleStructuredAstPatch {
  const beforeAst = validateAst(before, 'Before AST');
  const afterAst = validateAst(after, 'After AST');
  const forward = createStructuredAstPatch(beforeAst, afterAst).operations;
  const inverse = createStructuredAstPatch(afterAst, beforeAst).operations;
  const patch = { version: 1 as const, forward, inverse,
    beforeFingerprint: astFingerprint(beforeAst), afterFingerprint: astFingerprint(afterAst) };
  validateStructuredPayload(patch, 'Reversible patch');
  return patch;
}

function validatePatchOperations(operations: unknown[]): asserts operations is AstPatchOperation[] {
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('patch operation must be an object');
    }
    const record = operation as Record<string, unknown>;
    if (typeof record.op !== 'string') throw new Error('patch operation requires a string op');
    if (typeof record.path !== 'string') throw new Error('patch operation requires a string path');
    if (Object.keys(record).some((key) => key !== 'op' && key !== 'path' && key !== 'value')) throw new Error('patch operation has an unknown property');
    const hasValue = Object.hasOwn(record, 'value');
    if ((record.op === 'add' || record.op === 'replace') && !hasValue) throw new Error('patch add and replace require a value');
    if (record.op === 'remove' && hasValue) throw new Error('patch remove must not carry a value');
    if (record.op !== 'add' && record.op !== 'replace' && record.op !== 'remove') throw new Error('unknown patch operation');
  }
}

export function applyStructuredAstPatch(ast: unknown, operations: unknown[]) {
  if (operations.length > MAX_AST_PATCH_OPERATIONS) {
    throw new Error(`Patch has ${operations.length} operations; the limit is ${MAX_AST_PATCH_OPERATIONS}.`);
  }
  validateStructuredPayload(operations, 'Patch operations');
  validatePatchOperations(operations);
  const base = validateAst(ast, 'AST');
  const patched = applyAstPatch(base, operations);
  const normalized = fromAstJson(patched, Buffer.byteLength(JSON.stringify(patched), 'utf8'));
  return { ast: toAstJson(normalized), source: renderCarve(normalized) };
}

function validateReversiblePatch(value: unknown): ReversibleStructuredAstPatch {
  validateStructuredPayload(value, 'Reversible patch');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Reversible patch must be an object.');
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !['version', 'forward', 'inverse', 'beforeFingerprint', 'afterFingerprint'].includes(key))) {
    throw new Error('Reversible patch has an unknown property.');
  }
  if (patch.version !== 1) throw new Error('Unsupported reversible patch version.');
  if (!Array.isArray(patch.forward) || !Array.isArray(patch.inverse)) throw new Error('Reversible patch requires forward and inverse operations.');
  for (const operations of [patch.forward, patch.inverse]) {
    if (operations.length > MAX_AST_PATCH_OPERATIONS) throw new Error(`Patch has ${operations.length} operations; the limit is ${MAX_AST_PATCH_OPERATIONS}.`);
    validatePatchOperations(operations);
  }
  if (typeof patch.beforeFingerprint !== 'string' || typeof patch.afterFingerprint !== 'string'
    || !/^fnv1a64:[0-9a-f]{16}$/.test(patch.beforeFingerprint) || !/^fnv1a64:[0-9a-f]{16}$/.test(patch.afterFingerprint)) {
    throw new Error('Reversible patch requires valid before and after fingerprints.');
  }
  return patch as unknown as ReversibleStructuredAstPatch;
}

export function applyReversibleStructuredAstPatch(source: string, value: unknown, inverse = false) {
  validateSource(source);
  const patch = validateReversiblePatch(value);
  const ast = parse(source);
  const expected = inverse ? patch.afterFingerprint : patch.beforeFingerprint;
  if (astFingerprint(ast) !== expected) throw new Error('patch precondition does not match the document');
  const operations = inverse ? patch.inverse : patch.forward;
  const applied = applyStructuredAstPatch(ast, operations);
  const expectedResult = inverse ? patch.beforeFingerprint : patch.afterFingerprint;
  if (astFingerprint(applied.ast) !== expectedResult) throw new Error('patch postcondition does not match the document');
  const restored = applyStructuredAstPatch(applied.ast, inverse ? patch.forward : patch.inverse);
  if (astFingerprint(restored.ast) !== expected) throw new Error('patch reverse direction does not restore the document');
  return {
    direction: inverse ? 'inverse' as const : 'forward' as const,
    ast: applied.ast,
    source: applied.source,
    sourcePatch: createSourcePatch(source, applied.source, 'refactor', inverse ? 'revert-structured-ast-patch' : 'apply-structured-ast-patch'),
  };
}

export function migrate(source: string, format: SourceFormat, dialect?: MarkdownDialect): MigrationResult {
  validateSource(source);
  if (dialect && format !== 'markdown') {
    throw new Error('markdownDialect is only valid when format is markdown.');
  }
  switch (format) {
    case 'html': return migrateHtml(source);
    case 'markdown': return migrateMarkdown(source, { dialect });
    case 'djot': return migrateDjot(source);
  }
}
