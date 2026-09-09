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
export const MAX_AST_SELECTOR_MATCHES = 100;
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

export type AstSelector = { kind: 'heading-id' | 'footnote-label' | 'node-type'; value: string };
const AST_CHILD_FIELDS = ['children', 'items', 'rows', 'cells', 'inline', 'content', 'caption', 'shortCaption', 'title'] as const;

function pointer(path: string, part: string): string {
  return `${path}/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function nodeText(value: unknown, maximum = 121): string {
  let output = '';
  const append = (text: string): void => {
    const remaining = maximum - Array.from(output).length;
    if (remaining > 0) output += Array.from(text).slice(0, remaining).join('');
  };
  const visit = (item: unknown): void => {
    if (Array.from(output).length >= maximum || !item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach((child, index) => { if (index > 0) append(' '); visit(child); });
      return;
    }
    const record = item as Record<string, unknown>;
    if (record.type === 'text' && typeof record.value === 'string') append(record.value);
    for (const field of AST_CHILD_FIELDS) if (Object.hasOwn(record, field)) visit(record[field]);
  };
  visit(value);
  return output;
}

function humanText(value: string, maximum = 80): string {
  return Array.from(value.replace(/[\p{White_Space}\p{Cc}\uFEFF]+/gu, ' ').trim()).slice(0, maximum).join('');
}

function nodeIdentity(record: Record<string, unknown>): string | undefined {
  if (record.type === 'heading') {
    const attrs = record.attrs as Record<string, unknown> | undefined;
    if (typeof attrs?.id === 'string') return attrs.id;
  }
  if (record.type === 'footnote' && typeof record.label === 'string') return record.label;
  return undefined;
}

function astNodes(ast: AstJsonDocument) {
  const nodes: Array<{ path: string; node: Record<string, unknown> }> = [];
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((child, index) => visit(child, pointer(path, String(index)))); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.type === 'string') nodes.push({ path, node: record });
    for (const key of AST_CHILD_FIELDS) if (Object.hasOwn(record, key)) visit(record[key], pointer(path, key));
  };
  visit(ast, '');
  return nodes;
}

export function selectAstNodes(value: unknown, selector: AstSelector) {
  const ast = validateAst(value, 'AST');
  if (!selector.value) throw new Error('Selector value must not be empty.');
  if (Array.from(selector.value).length > 256) throw new Error('Selector value may contain at most 256 characters.');
  const selected = astNodes(ast).filter(({ node }) => {
    if (selector.kind === 'heading-id') return node.type === 'heading' && nodeIdentity(node) === selector.value;
    if (selector.kind === 'footnote-label') return node.type === 'footnote' && nodeIdentity(node) === selector.value;
    return node.type === selector.value;
  });
  const truncated = selected.length > MAX_AST_SELECTOR_MATCHES;
  const matches = selected.slice(0, MAX_AST_SELECTOR_MATCHES).map(({ path, node }) => {
    const fullPreview = humanText(nodeText(node, 121), 121);
    const preview = Array.from(fullPreview).slice(0, 120).join('');
    const identity = nodeIdentity(node);
    const displayIdentity = identity === undefined ? '' : humanText(identity);
    return {
    path, type: String(node.type), ...(displayIdentity ? { identity: displayIdentity } : {}),
    preview, previewTruncated: Array.from(fullPreview).length > 120,
  }; });
  const output = { selector, matchCount: selected.length, matches, truncated };
  validateStructuredPayload(output, 'AST selector result');
  return output;
}

function explainOperations(ast: AstJsonDocument, operations: AstPatchOperation[]) {
  const nodes = astNodes(ast).sort((left, right) => right.path.length - left.path.length);
  return operations.map((operation) => {
    const ancestors = nodes.filter(({ path }) => path === '' || operation.path === path || operation.path.startsWith(`${path}/`));
    const owner = ancestors.find(({ node }) => nodeIdentity(node) !== undefined)
      ?? ancestors.find(({ node }) => node.type !== 'text') ?? ancestors[0];
    const ownerType = String(owner?.node.type ?? 'document');
    const identity = owner ? humanText(nodeIdentity(owner.node) ?? '') : '';
    const target = identity ? `${ownerType} “${identity}”` : ownerType;
    const field = operation.path.split('/').at(-1)?.replaceAll('~1', '/').replaceAll('~0', '~') || 'document';
    let kind = operation.op;
    let summary = `${operation.op === 'add' ? 'Added' : operation.op === 'remove' ? 'Removed' : 'Changed'} ${field} on ${target}.`;
    const previous = valueAtPointer(ast, operation.path);
    if (operation.op === 'replace' && Array.isArray(previous) && Array.isArray(operation.value) && previous.length !== operation.value.length
      && (isSubsequence(previous, operation.value) || isSubsequence(operation.value, previous))) {
      const added = operation.value.length > previous.length;
      const count = Math.abs(operation.value.length - previous.length);
      kind = added ? 'add' : 'remove';
      summary = `${added ? 'Added' : 'Removed'} ${count} item${count === 1 ? '' : 's'} in ${target}.`;
    }
    if (field === 'value' && owner) summary = `Changed text in ${target}.`;
    return { kind, path: operation.path, target, summary };
  });
}

function isSubsequence(shorter: unknown[], longer: unknown[]): boolean {
  if (shorter.length > longer.length) return false;
  let index = 0;
  for (const value of longer) {
    if (index < shorter.length && semanticAstEqual(shorter[index], value)) index += 1;
  }
  return index === shorter.length;
}

function semanticAstEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => semanticAstEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const ignored = new Set(['pos', 'srcByteLength']);
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => !ignored.has(key)).sort();
  const rightKeys = Object.keys(rightRecord).filter((key) => !ignored.has(key)).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]
    && semanticAstEqual(leftRecord[key], rightRecord[key]));
}

function valueAtPointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  let current = value;
  for (const part of path.slice(1).split('/').map((item) => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
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
  const changes = explainOperations(beforeAst, operations);
  const output = { operations, operationCount: operations.length, changes, changeCount: changes.length };
  validateStructuredPayload(output, 'AST patch result');
  return output;
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
  changes?: Array<{ kind: string; path: string; target: string; summary: string }>;
}

export function createReversibleStructuredAstPatch(before: unknown, after: unknown): ReversibleStructuredAstPatch {
  const beforeAst = validateAst(before, 'Before AST');
  const afterAst = validateAst(after, 'After AST');
  const forward = createStructuredAstPatch(beforeAst, afterAst).operations;
  const inverse = createStructuredAstPatch(afterAst, beforeAst).operations;
  const patch = { version: 1 as const, forward, inverse,
    beforeFingerprint: astFingerprint(beforeAst), afterFingerprint: astFingerprint(afterAst),
    changes: explainOperations(beforeAst, forward) };
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
  if (Object.keys(patch).some((key) => !['version', 'forward', 'inverse', 'beforeFingerprint', 'afterFingerprint', 'changes'].includes(key))) {
    throw new Error('Reversible patch has an unknown property.');
  }
  if (patch.version !== 1) throw new Error('Unsupported reversible patch version.');
  if (!Array.isArray(patch.forward) || !Array.isArray(patch.inverse)) throw new Error('Reversible patch requires forward and inverse operations.');
  if (patch.changes !== undefined && !Array.isArray(patch.changes)) throw new Error('Reversible patch change explanations must be an array.');
  for (const change of patch.changes ?? []) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('Patch change explanation must be an object.');
    const record = change as Record<string, unknown>;
    if (!['add', 'remove', 'replace'].includes(String(record.kind)) || typeof record.path !== 'string'
      || typeof record.target !== 'string' || typeof record.summary !== 'string') throw new Error('Patch change explanation is invalid.');
  }
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
