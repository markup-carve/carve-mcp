import { childEntries } from './ast-fields.js';
import {
  CarveRenderError, assertTree, extensionOptions, formatSource, importHtml, lintDiagnostics, parseTree, renderHtml,
  runCarve2, toWarning, treeJson, writeCarve, writeTarget,
  type Diagnostic, type DocumentNode, type ExtensionName, type HeadingIds, type LintPlatform, type RegistryTarget, type Warning,
} from './engine.js';
import { applyAstPatch, createAstPatch, POSITION_KEYS, withoutPositions as stripPositions, type AstPatchOperation } from './ast-patch.js';
import { createSourcePatch } from './source-patch.js';
import { expandDocument, lintWithIncludes, type IncludedLintWarning, type IncludeReport, type IncludeScope } from './includes.js';

export const MAX_SOURCE_BYTES = 1_000_000;
export const MAX_AST_PATCH_OPERATIONS = 1_000;
export const MAX_AST_SELECTOR_MATCHES = 100;
/**
 * Deepest tree the Carve writer is handed, counted in typed AST nodes.
 *
 * The writer's cost grows steeply with nesting (a 230-level loose list took
 * 18 s and blocked every other request), so depth is refused up front. No
 * real document comes close; the Rust server enforces the same bound.
 */
export const MAX_WRITER_DEPTH = 256;
export type RenderTarget = 'html' | RegistryTarget;
export type SourceFormat = 'html' | 'markdown' | 'gfm' | 'djot' | 'bbcode';
export type RenderPreset = 'default' | 'portable' | 'static-html';
export type { ExtensionName };
/** A tree of contract 2.0 as JSON. */
export type AstJsonDocument = Record<string, unknown> & { type: string; children: unknown[] };
export interface RenderSettings {
  preset?: RenderPreset;
  headingIds?: HeadingIds;
  strictLosses?: boolean;
  maxRenderLosses?: number;
  smartTypography?: boolean;
  extensions?: ExtensionName[];
  allowRawHtml?: boolean;
  sanitizeUrls?: boolean;
}

export interface RenderResult {
  value: string;
  losses: Diagnostic[];
  totalLosses: number;
  truncated: boolean;
  diagnostics: Diagnostic[];
}

function htmlOptions(settings: RenderSettings) {
  const { extensions, renderers } = extensionOptions(settings.extensions);
  return {
    headingIds: settings.headingIds ?? (settings.preset === 'portable' ? 'ascii-lower' as const : undefined),
    strictLosses: settings.strictLosses ?? false,
    ...(settings.smartTypography !== undefined ? { smartTypography: settings.smartTypography } : {}),
    extensions, renderers,
    rawHtml: settings.allowRawHtml ?? false,
    ...(settings.preset === 'static-html' ? { mode: 'static' as const } : {}),
  };
}

/**
 * Split the engine diagnostics into the render losses this server reports.
 *
 * The URL policy always blanks a denied scheme (#78); `sanitizeUrls: false`
 * only stops that denial being reported.
 */
function renderResult(value: string, diagnostics: Diagnostic[], suppressed: number, settings: RenderSettings): RenderResult {
  const all = diagnostics.filter((entry) => entry.channel === 'render-loss'
    && (settings.sanitizeUrls !== false || entry.code !== 'destination-denied'));
  const limit = settings.maxRenderLosses ?? all.length;
  const losses = all.slice(0, limit);
  return { value, losses, totalLosses: all.length, truncated: losses.length < all.length || suppressed > 0, diagnostics };
}

export function validateSource(source: string): void {
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(`Source is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES} bytes.`);
  }
}

export function lint(source: string, platforms: LintPlatform[] = [], scope?: IncludeScope) {
  validateSource(source);
  const warnings: Array<Warning | IncludedLintWarning> = scope
    ? lintWithIncludes(source, scope, platforms)
    : lintDiagnostics(source, platforms).map((diagnostic) => toWarning(diagnostic, source));
  return { valid: warnings.length === 0, warningCount: warnings.length, warnings };
}

/** Typed-node nesting depth of a document or AST, stopping once it passes `limit`. */
export function nestingDepth(value: unknown, limit = MAX_WRITER_DEPTH): number {
  let deepest = 0;
  const pending: Array<[unknown, number]> = [[value, 0]];
  while (pending.length > 0) {
    const [item, depth] = pending.pop()!;
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { for (const child of item) pending.push([child, depth]); continue; }
    const record = item as Record<string, unknown>;
    const level = typeof record.type === 'string' ? depth + 1 : depth;
    if (level > deepest) deepest = level;
    if (deepest > limit) return deepest;
    for (const [key, child] of Object.entries(record)) if (key !== 'pos' && child && typeof child === 'object') pending.push([child, level]);
  }
  return deepest;
}

export function assertWriterDepth(value: unknown): void {
  if (nestingDepth(value) > MAX_WRITER_DEPTH) {
    throw new Error(`Document nests deeper than ${MAX_WRITER_DEPTH} AST levels; the Carve writer limit is ${MAX_WRITER_DEPTH}.`);
  }
}

export function format(source: string, options: { alignTables?: boolean } = {}): RenderResult {
  validateSource(source);
  assertWriterDepth(parseTree(source, { positions: false }));
  const formatted = formatSource(source, options.alignTables === true);
  return renderResult(formatted.source, formatted.diagnostics, 0, {});
}

export function render(source: string, target: RenderTarget, settings: RenderSettings = {}, scope?: IncludeScope): RenderResult & { includes?: IncludeReport } {
  validateSource(source);
  if (settings.preset === 'static-html' && target !== 'html') {
    throw new Error('The static-html preset is only valid for the HTML target.');
  }
  const options = htmlOptions(settings);
  // The expanded tree is rendered as it stands, so an include cannot change
  // meaning on the way back through the source form.
  const expanded = scope ? expandDocument(source, options.extensions, scope) : undefined;
  const includes = expanded ? { includes: expanded.includes } : {};
  if (target === 'html') {
    const html = renderHtml(expanded?.doc ?? source, options);
    return { ...renderResult(html.html, html.diagnostics, html.suppressedDiagnostics, settings), ...includes };
  }
  const tree = expanded?.doc ?? parseTree(source, { extensions: options.extensions });
  const written = writeTarget(target, tree, { strictLosses: options.strictLosses });
  return { ...renderResult(written.output, written.diagnostics, 0, settings), ...includes };
}

export function parse(source: string, scope?: IncludeScope): AstJsonDocument & { includes?: IncludeReport } {
  validateSource(source);
  if (!scope) return treeJson(parseTree(source)) as AstJsonDocument;
  const { doc, includes } = expandDocument(source, [], scope);
  return { ...(treeJson(doc) as AstJsonDocument), includes };
}

/** Largest `carve_parse` result returned, in JSON bytes. */
export const MAX_PARSE_OUTPUT_BYTES = 16 * 1024 * 1024;

function withoutPositions(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { pending.push(...item); continue; }
    const record = item as Record<string, unknown>;
    // A string `pos` is an authored attribute such as `{pos=1}`, not a position.
    if (record.pos && typeof record.pos === 'object') delete record.pos;
    for (const child of Object.values(record)) if (child && typeof child === 'object') pending.push(child);
  }
}

/** `carve_parse`: the AST, optionally without positions, refused past the output cap. */
export function parseForTool(source: string, scope?: IncludeScope, positions = true): AstJsonDocument & { includes?: IncludeReport } {
  const ast = parse(source, scope);
  if (!positions) withoutPositions(ast);
  const bytes = Buffer.byteLength(JSON.stringify(ast), 'utf8');
  if (bytes > MAX_PARSE_OUTPUT_BYTES) {
    throw new Error(`carve_parse result is ${bytes} bytes; the limit is ${MAX_PARSE_OUTPUT_BYTES} bytes. Pass positions: false or parse a smaller document.`);
  }
  return ast;
}

export function validateStructuredPayload(value: unknown, label: string): number {
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
  validateStructuredPayload(value, label);
  try { assertTree(value); }
  catch (error) { throw new Error(`${label} is not a Carve 0.2 tree: ${error instanceof Error ? error.message : String(error)}`); }
  return value as unknown as AstJsonDocument;
}

export type AstSelector = { kind: 'id' | 'heading-id' | 'footnote-label' | 'node-type' | 'ast-path'; value: string };
export type SemanticAstEdit =
  | { kind: 'replace-text'; text: string }
  | { kind: 'rename-heading-id'; id: string }
  | { kind: 'delete-node' }
  | { kind: 'replace-node'; node: unknown }
  | { kind: 'insert-before' | 'insert-after'; node: unknown };
export type SemanticAstEditStep = { selector: AstSelector; edit: SemanticAstEdit };
export const MAX_SEMANTIC_EDIT_STEPS = 100;

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
    for (const [, child] of childEntries(record)) visit(child);
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
    if (typeof record.generatedId === 'string') return record.generatedId;
  }
  if (record.type === 'footnote' && typeof record.key === 'string') return record.key;
  return undefined;
}

function attributeId(record: Record<string, unknown>): string | undefined {
  const attrs = record.attrs as Record<string, unknown> | undefined;
  if (typeof attrs?.id === 'string') return attrs.id;
  return record.type === 'heading' && typeof record.generatedId === 'string' ? record.generatedId : undefined;
}

export function astNodes(ast: AstJsonDocument) {
  const nodes: Array<{ path: string; node: Record<string, unknown> }> = [];
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((child, index) => visit(child, pointer(path, String(index)))); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.type === 'string') nodes.push({ path, node: record });
    for (const [keys, child] of childEntries(record)) visit(child, keys.reduce(pointer, path));
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

export function matchingAstNodes(ast: AstJsonDocument, selector: AstSelector) {
  if (!selector.value) throw new Error('Selector value must not be empty.');
  const maximum = selector.kind === 'ast-path' ? 4096 : 256;
  if (Array.from(selector.value).length > maximum) throw new Error(`Selector value may contain at most ${maximum} characters.`);
  return astNodes(ast).filter(({ path, node }) => {
    if (selector.kind === 'ast-path') return path === selector.value;
    if (selector.kind === 'id') return attributeId(node) === selector.value;
    if (selector.kind === 'heading-id') return node.type === 'heading' && nodeIdentity(node) === selector.value;
    if (selector.kind === 'footnote-label') return node.type === 'footnote' && nodeIdentity(node) === selector.value;
    return node.type === selector.value;
  });
}

export function astIdentity(node: Record<string, unknown>): string {
  const identity = nodeIdentity(node) ?? attributeId(node);
  return identity === undefined ? '' : humanText(identity);
}

function astMatch(path: string, node: Record<string, unknown>) {
    const fullPreview = humanText(nodeText(node, 121), 121);
    const preview = Array.from(fullPreview).slice(0, 120).join('');
    const displayIdentity = astIdentity(node);
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
    const referenced = astNodes(after).some(({ node }) => node.type === 'footnote_ref' && node.key === label);
    if (referenced) throw new Error(`Cannot delete footnote “${humanText(label ?? '')}” while references remain.`);
  }
  const semanticAfter = semanticAst(after) as AstJsonDocument;
  validateStructuredPayload(semanticAfter, 'Edited AST');
  assertWriterDepth(semanticAfter);
  const rendered = writeCarve(validateAst(semanticAfter, 'Edited AST') as unknown as DocumentNode);
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
    const unchanged = nodeText(node.children, Infinity) === edit.text;
    node.children = [{ type: 'text', value: edit.text }];
    // A 0.2 heading derives its ID from its text; keep the old one explicit.
    const id = nodeIdentity(node);
    if (node.type === 'heading' && id !== undefined && !unchanged) node.attrs = { ...(node.attrs as Record<string, unknown> | undefined), id };
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

export function parentArrayLocation(ast: AstJsonDocument, path: string): { parent: unknown[]; index: number } | undefined {
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
  const ignored = POSITION_KEYS;
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
    .filter((key) => !stripMetadata || !POSITION_KEYS.has(key))
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
  const patched = stripPositions(applyAstPatch(base, operations));
  validateAst(patched, 'Patched AST');
  assertWriterDepth(patched);
  const source = writeCarve(patched as unknown as DocumentNode);
  // Derived fields such as generatedId follow the written source, not the stale values a patch left behind.
  return { ast: stripPositions(treeJson(parseTree(source))) as unknown as typeof patched, source };
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

export interface MigrationDiagnostic { code: string; message: string; severity: 'info' | 'warning' | 'error'; path?: string; line?: number; column?: number }
export interface MigrationResult { value: string; report: { schemaVersion: 3; sourceFormat: SourceFormat; diagnostics: MigrationDiagnostic[] } }

const SEVERITY: Record<string, MigrationDiagnostic['severity']> = { error: 'error', warning: 'warning', hint: 'info', info: 'info' };

export function migrate(source: string, format: SourceFormat): MigrationResult {
  validateSource(source);
  if (format === 'bbcode') throw new Error('BBCode import is not carried over to Carve 0.2.');
  if (format === 'html') {
    const imported = importHtml(source);
    const diagnostics = imported.diagnostics.map((entry) => {
      const record = entry as unknown as Record<string, unknown>;
      return { code: String(record.code), message: String(record.message), severity: SEVERITY[String(record.severity)] ?? 'warning',
        ...(typeof record.path === 'string' ? { path: record.path } : {}) };
    });
    return { value: imported.source, report: { schemaVersion: 3, sourceFormat: format, diagnostics } };
  }
  // Markdown, GFM and Djot import are outside the 0.2 specification (C2-T-003);
  // the engine ships them only as `carve2 import`.
  const run = runCarve2(['import', '--from', format], source);
  if (run.status !== 0) throw new Error(`carve2 import --from ${format} failed: ${run.stderr.trim() || `exit ${run.status}`}`);
  // `carve2 import` writes `<stdin>:LINE:COLUMN: SEVERITY CODE MESSAGE` per diagnostic, also on success.
  const diagnostics = run.stderr.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const entry = /^<stdin>:(\d+):(\d+): (error|warning|hint|info) (\S+) (.*)$/.exec(line);
    if (entry) {
      return { code: entry[4]!, message: entry[5]!, severity: SEVERITY[entry[3]!] ?? 'warning', line: Number(entry[1]), column: Number(entry[2]) };
    }
    const failure = /^carve\[([^\]]+)\]:\s*(.*)$/.exec(line);
    return { code: failure?.[1] ?? 'import-note', message: failure?.[2] ?? line, severity: 'warning' as const };
  });
  return { value: run.stdout, report: { schemaVersion: 3, sourceFormat: format, diagnostics } };
}

export interface UpgradeRecord { [field: string]: unknown }
export interface UpgradeResult { value: string; changed: boolean; check: string; writable: boolean; records: UpgradeRecord[]; engine01: string }

/** `carve_upgrade`: rewrite Carve 0.1 source as 0.2 with `carve2 upgrade`. */
export function upgrade(source: string): UpgradeResult {
  validateSource(source);
  const output = runCarve2(['upgrade'], source);
  const report = runCarve2(['upgrade', '--json'], source);
  if (output.status === 2 || report.status === 2) throw new Error(`carve2 upgrade failed: ${(output.stderr || report.stderr).trim()}`);
  let parsed: { engine01?: string; files?: Array<{ changed?: boolean; check?: string; records?: UpgradeRecord[] }> };
  try { parsed = JSON.parse(report.stdout) as typeof parsed; }
  catch { throw new Error('carve2 upgrade returned no JSON report.'); }
  const file = parsed.files?.[0];
  if (!file) throw new Error('carve2 upgrade returned an empty report.');
  const check = String(file.check ?? 'unknown');
  return { value: output.stdout, changed: file.changed === true, check, writable: check === 'pass' || check === 'explained',
    records: file.records ?? [], engine01: String(parsed.engine01 ?? '') };
}
