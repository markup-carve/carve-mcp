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

export type AstSelector = { kind: 'heading-id' | 'footnote-label' | 'node-type' | 'ast-path'; value: string };
export type SemanticAstEdit =
  | { kind: 'replace-text'; text: string }
  | { kind: 'rename-heading-id'; id: string }
  | { kind: 'delete-node' }
  | { kind: 'replace-node'; node: unknown }
  | { kind: 'insert-before' | 'insert-after'; node: unknown };
export type SemanticAstEditStep = { selector: AstSelector; edit: SemanticAstEdit };
export const MAX_SEMANTIC_EDIT_STEPS = 100;
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
  const selected = matchingAstNodes(ast, selector);
  const truncated = selected.length > MAX_AST_SELECTOR_MATCHES;
  const matches = selected.slice(0, MAX_AST_SELECTOR_MATCHES).map(({ path, node }) => astMatch(path, node));
  const output = { selector, matchCount: selected.length, matches, truncated };
  validateStructuredPayload(output, 'AST selector result');
  return output;
}

function matchingAstNodes(ast: AstJsonDocument, selector: AstSelector) {
  if (!selector.value) throw new Error('Selector value must not be empty.');
  const maximum = selector.kind === 'ast-path' ? 4096 : 256;
  if (Array.from(selector.value).length > maximum) throw new Error(`Selector value may contain at most ${maximum} characters.`);
  return astNodes(ast).filter(({ path, node }) => {
    if (selector.kind === 'ast-path') return path === selector.value;
    if (selector.kind === 'heading-id') return node.type === 'heading' && nodeIdentity(node) === selector.value;
    if (selector.kind === 'footnote-label') return node.type === 'footnote' && nodeIdentity(node) === selector.value;
    return node.type === selector.value;
  });
}

function astMatch(path: string, node: Record<string, unknown>) {
    const fullPreview = humanText(nodeText(node, 121), 121);
    const preview = Array.from(fullPreview).slice(0, 120).join('');
    const identity = nodeIdentity(node);
    const displayIdentity = identity === undefined ? '' : humanText(identity);
    return {
      path, type: String(node.type), ...(displayIdentity ? { identity: displayIdentity } : {}),
      preview, previewTruncated: Array.from(fullPreview).length > 120,
    };
}

export function planSemanticAstEdit(source: string, selector: AstSelector, edit: SemanticAstEdit, then: SemanticAstEditStep[] = []) {
  validateSource(source);
  if (then.length > MAX_SEMANTIC_EDIT_STEPS - 1) throw new Error(`Semantic edit plan may contain at most ${MAX_SEMANTIC_EDIT_STEPS} steps.`);
  const before = parse(source);
  const requests = [{ selector, edit }, ...then];
  validateStructuredPayload(requests, 'Semantic edit steps');
  const resolved = requests.map((request, index) => {
    validateSemanticEditShape(request.edit);
    const matches = matchingAstNodes(before, request.selector);
    const label = requests.length === 1 ? 'Semantic selector' : `Semantic edit step ${index + 1}`;
    if (matches.length === 0) throw new Error(`${label} did not match any AST node.`);
    if (matches.length > 1) throw new Error(`${label} matched ${matches.length} AST nodes; refine it before editing.`);
    return { ...request, match: matches[0]! };
  });
  for (let left = 0; left < resolved.length; left += 1) {
    for (let right = left + 1; right < resolved.length; right += 1) {
      if (pathsOverlap(resolved[left]!.match.path, resolved[right]!.match.path)) {
        throw new Error(`Semantic edit steps ${left + 1} and ${right + 1} target overlapping AST nodes.`);
      }
    }
  }
  const after = structuredClone(before);
  const structural = (step: typeof resolved[number]) => !['replace-text', 'rename-heading-id'].includes(step.edit.kind);
  const ordered = [...resolved.filter((step) => !structural(step)),
    ...resolved.filter(structural).sort((left, right) => compareStructuralPaths(right.match.path, left.match.path))];
  for (const step of ordered) applySemanticEdit(after, step.match.path, step.edit);
  assertNoNewHeadingIdCollisions(before, after);
  if (semanticAstEqual(before, after)) throw new Error('The requested semantic edit would not change the document.');
  for (const step of resolved.filter(({ edit, match }) => edit.kind === 'delete-node' && match.node.type === 'footnote')) {
    const label = nodeIdentity(step.match.node);
    const referenced = astNodes(after).some(({ node }) => node.type === 'footnote_ref' && node.id === label);
    if (referenced) throw new Error(`Cannot delete footnote “${humanText(label ?? '')}” while references remain.`);
  }
  const semanticAfter = semanticAst(after) as AstJsonDocument;
  semanticAfter.srcByteLength = 0;
  const editedBytes = validateStructuredPayload(semanticAfter, 'Edited AST');
  const rendered = renderCarve(fromAstJson(semanticAfter, editedBytes));
  const canonicalAfter = parse(rendered);
  const reversiblePatch = createReversibleStructuredAstPatch(before, canonicalAfter);
  if (reversiblePatch.forward.length === 0) throw new Error('The requested semantic edit would not change the document.');
  const applied = applyReversibleStructuredAstPatch(source, reversiblePatch);
  applyReversibleStructuredAstPatch(applied.source, reversiblePatch, true);
  const sourcePatch = { ...applied.sourcePatch,
    edits: applied.sourcePatch.edits.map((item) => ({ ...item, code: 'semantic-ast-edit' })) };
  const steps = resolved.map((step) => ({ selector: step.selector, edit: { kind: step.edit.kind },
    match: astMatch(step.match.path, step.match.node), notices: semanticEditNotices(step.match.node, step.edit) }));
  const notices = [...new Set(steps.flatMap((step) => step.notices))];
  const output = {
    selector,
    edit: { kind: edit.kind },
    match: steps[0]!.match,
    notices,
    editCount: steps.length,
    steps,
    reversiblePatch,
    sourcePatch,
  };
  validateStructuredPayload(output, 'Semantic edit plan');
  return output;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function compareStructuralPaths(left: string, right: string): number {
  const leftParts = left.split('/');
  const rightParts = right.split('/');
  if (leftParts.length !== rightParts.length) return leftParts.length - rightParts.length;
  const leftParent = leftParts.slice(0, -1).join('/');
  const rightParent = rightParts.slice(0, -1).join('/');
  if (leftParent === rightParent) return Number(leftParts.at(-1)) - Number(rightParts.at(-1));
  return left.localeCompare(right);
}

function headingIdCounts(ast: AstJsonDocument): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { node } of astNodes(ast)) {
    if (node.type !== 'heading') continue;
    const id = nodeIdentity(node);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function assertNoNewHeadingIdCollisions(before: AstJsonDocument, after: AstJsonDocument): void {
  const beforeCounts = headingIdCounts(before);
  for (const [id, count] of headingIdCounts(after)) {
    if (count > 1 && count > (beforeCounts.get(id) ?? 0)) {
      throw new Error(`Heading ID “${humanText(id)}” is already in use.`);
    }
  }
}

function validateSemanticEditShape(edit: SemanticAstEdit): void {
  const allowed: Record<SemanticAstEdit['kind'], string[]> = {
    'replace-text': ['kind', 'text'], 'rename-heading-id': ['kind', 'id'], 'delete-node': ['kind'],
    'replace-node': ['kind', 'node'], 'insert-before': ['kind', 'node'], 'insert-after': ['kind', 'node'],
  };
  const unexpected = Object.keys(edit).filter((key) => !allowed[edit.kind]?.includes(key));
  if (unexpected.length > 0) throw new Error(`${edit.kind} does not accept ${unexpected.join(', ')}.`);
}

function semanticEditNotices(node: Record<string, unknown>, edit: SemanticAstEdit): string[] {
  if (edit.kind !== 'replace-text') return [];
  const formatting = `replace-text replaces inline formatting inside the ${String(node.type)}.`;
  const identity = humanText(nodeIdentity(node) ?? '');
  return identity ? [`Preserved heading ID “${identity}”.`, formatting] : [formatting];
}

function applySemanticEdit(ast: AstJsonDocument, path: string, edit: SemanticAstEdit): void {
  const selected = valueAtPointer(ast, path);
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new Error('Selected AST node no longer exists.');
  const node = selected as Record<string, unknown>;
  if (edit.kind === 'replace-text') {
    if (typeof edit.text !== 'string') throw new Error('replace-text requires text.');
    if (Buffer.byteLength(edit.text, 'utf8') > MAX_SOURCE_BYTES) throw new Error(`Replacement text exceeds the ${MAX_SOURCE_BYTES}-byte limit.`);
    if (/[\r\n\u2028\u2029]/u.test(edit.text)) throw new Error('replace-text accepts one text block and must not contain line breaks.');
    if (node.type !== 'heading' && node.type !== 'paragraph') throw new Error('replace-text supports heading and paragraph nodes.');
    node.children = [{ type: 'text', value: edit.text }];
    return;
  }
  if (edit.kind === 'rename-heading-id') {
    if (typeof edit.id !== 'string') throw new Error('rename-heading-id requires id.');
    if (node.type !== 'heading') throw new Error('rename-heading-id requires a heading node.');
    if (!edit.id || Array.from(edit.id).length > 256) throw new Error('Heading ID must contain 1 to 256 characters.');
    if (humanText(edit.id, 257) !== edit.id) throw new Error('Heading ID must not contain control characters or surrounding or repeated whitespace.');
    node.attrs = { ...((node.attrs && typeof node.attrs === 'object' && !Array.isArray(node.attrs)) ? node.attrs as Record<string, unknown> : {}), id: edit.id };
    return;
  }
  const location = parentArrayLocation(ast, path);
  if (!location) throw new Error(`${edit.kind} requires a node contained in an AST array.`);
  if (edit.kind === 'delete-node') {
    location.parent.splice(location.index, 1);
  } else if (edit.kind === 'replace-node') {
    if (edit.node === undefined) throw new Error('replace-node requires node.');
    validateStructuredPayload(edit.node, 'Replacement node');
    location.parent[location.index] = structuredClone(edit.node);
  } else {
    if (edit.node === undefined) throw new Error(`${edit.kind} requires node.`);
    validateStructuredPayload(edit.node, 'Inserted node');
    location.parent.splice(location.index + (edit.kind === 'insert-after' ? 1 : 0), 0, structuredClone(edit.node));
  }
}

function parentArrayLocation(ast: AstJsonDocument, path: string): { parent: unknown[]; index: number } | undefined {
  const separator = path.lastIndexOf('/');
  if (separator < 0) return undefined;
  const parent = valueAtPointer(ast, path.slice(0, separator));
  const part = path.slice(separator + 1).replaceAll('~1', '/').replaceAll('~0', '~');
  if (!Array.isArray(parent) || !/^(0|[1-9]\d*)$/.test(part)) return undefined;
  const index = Number(part);
  return index < parent.length ? { parent, index } : undefined;
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
