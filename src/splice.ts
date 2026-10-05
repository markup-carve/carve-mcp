import { nodeRange, resolveSourceBlocks, sha256Text, type BlockScope } from './blocks.js';
import { astIdentity, astNodes, lint, MAX_SOURCE_BYTES, parse, validateSource, validateStructuredPayload, type AstSelector } from './tools.js';

// A refusal leaves the document unchanged and tells the caller why in fields
// it can act on, not only in the message.
export class SourceEditRefusal extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) { super(message); }
}

type LintFinding = { line: number; column: number; rule: string; message: string; start: number; end: number; resourceUri: string };

function lintFindings(source: string): LintFinding[] {
  return lint(source).warnings.map(({ line, column, rule, message, start, end }) => (
    { line, column, rule, message, start, end, resourceUri: `carve://lint-rules/${rule}` }));
}

function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function splicePatch(source: string, start: number, end: number, replacement: string, code: string) {
  const bytes = new TextEncoder().encode(source);
  return { version: 1 as const, sourceFingerprint: fnv1a64(bytes), sourceBytes: bytes.length,
    edits: [{ start, end, replacement, kind: 'refactor' as const, code }], unresolved: [] };
}

// Findings outside the edited range must survive at their shifted UTF-16
// offsets; findings inside it are compared by rule only.
function compareFindings(before: LintFinding[], after: LintFinding[], start: number, oldEnd: number, newEnd: number) {
  const delta = newEnd - oldEnd;
  const key = (finding: LintFinding, inside: boolean, shift: number) => inside ? `in:${finding.rule}` : `out:${finding.rule}:${finding.start + shift}:${finding.end + shift}`;
  const place = (finding: LintFinding, end: number, shift: number) => (finding.end <= start ? key(finding, false, 0)
    : finding.start >= end ? key(finding, false, shift) : key(finding, true, 0));
  const pending = new Map<string, LintFinding[]>();
  for (const finding of before) {
    const slot = place(finding, oldEnd, delta);
    pending.set(slot, [...(pending.get(slot) ?? []), finding]);
  }
  const introduced: LintFinding[] = [];
  for (const finding of after) {
    const slot = place(finding, newEnd, 0);
    const matches = pending.get(slot);
    if (matches?.length) matches.shift();
    else introduced.push(finding);
  }
  const order = (left: LintFinding, right: LintFinding) => left.start - right.start || (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0);
  return { introduced: introduced.sort(order), resolved: [...pending.values()].flat().sort(order) };
}

type Located = { path: string; type: string; start: number; end: number; line: number; facts: string };

// The node's own scalar properties and attributes (list tightness, heading
// level, ids, ...), so a node that keeps its type and range but changes
// meaning is still caught.
function facts(node: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(node).sort()
    .filter((key) => key === 'attrs' || (key !== 'pos' && (node[key] === null || typeof node[key] !== 'object')))
    .map((key) => [key, node[key]]));
}

function positioned(ast: unknown): Located[] {
  return astNodes(ast as never).flatMap(({ path, node }) => {
    const pos = node.pos as { startOffset?: number; endOffset?: number; startLine?: number } | undefined;
    if (typeof pos?.startOffset !== 'number' || typeof pos.endOffset !== 'number') return [];
    return [{ path, type: String(node.type), start: pos.startOffset, end: pos.endOffset, line: pos.startLine ?? 0, facts: facts(node) }];
  });
}

// Every node outside the replaced range must parse again as the same type at
// the same place (shifted past the range), and every ancestor must still span
// the range. An ancestor that ended with the range may lose the replacement's
// trailing whitespace. Untouched text only has to stay inside some text node,
// because adjacent text merges into one node.
function assertSurroundingsUnchanged(before: unknown, after: unknown, target: string, start: number, end: number, delta: number, trailingSpace: number): void {
  const located = positioned(after);
  const texts = located.filter(({ type }) => type === 'text').sort((left, right) => left.start - right.start);
  const textCovers = (from: number, to: number): boolean => {
    let low = 0;
    let high = texts.length - 1;
    let candidate = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (texts[middle]!.start <= from) { candidate = middle; low = middle + 1; } else high = middle - 1;
    }
    return candidate >= 0 && texts[candidate]!.end >= to;
  };
  const found = new Set(located.map(({ type, start: from, end: to, facts: own }) => `${type}:${from}:${to}:${own}`));
  const ends = new Map<string, number[]>();
  for (const { type, start: from, end: to, facts: own } of located) ends.set(`${type}:${from}:${own}`, [...(ends.get(`${type}:${from}:${own}`) ?? []), to]);
  for (const node of positioned(before)) {
    const ancestor = target.startsWith(`${node.path}/`);
    const outside = node.end <= start || node.start >= end;
    if ((!ancestor && !outside) || (node.type === 'text' && !outside)) continue;
    const shift = node.start >= end ? delta : 0;
    const highest = node.end + delta;
    const lowest = node.end === end ? highest - trailingSpace : highest;
    const present = node.type === 'text' ? textCovers(node.start + shift, node.end + shift) : ancestor
      ? (ends.get(`${node.type}:${node.start}:${node.facts}`) ?? []).some((to) => to >= lowest && to <= highest)
      : found.has(`${node.type}:${node.start + shift}:${node.end + shift}:${node.facts}`);
    if (!present) {
      throw new SourceEditRefusal(`The replacement changes how the rest of the document parses: the ${node.type} on line ${node.line} would not survive.`,
        { reason: 'surroundings-changed', nodeType: node.type, line: node.line });
    }
  }
}

export interface ReplaceSourceOptions { scope?: BlockScope; expectedSha256?: string; sha256?: string; includeSource?: boolean }

export function replaceSource(source: string, selector: AstSelector, text: string, options: ReplaceSourceOptions = {}) {
  validateSource(source);
  if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) throw new Error(`Replacement text exceeds the ${MAX_SOURCE_BYTES}-byte limit.`);
  const sha256 = options.sha256 ?? sha256Text(source);
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== sha256) {
    throw new SourceEditRefusal('The source changed since it was read; expectedSha256 does not match.', { reason: 'stale-source', sha256 });
  }
  const scope = options.scope ?? 'node';
  const { ast, offsets, selected } = resolveSourceBlocks(source, selector);
  if (selected.length === 0) throw new Error('Selector did not match any AST node.');
  if (selected.length > 1) throw new Error(`Selector matched ${selected.length} AST nodes; refine it before editing.`);
  const { path, node } = selected[0]!;
  const range = nodeRange(ast, path, node, scope);
  const original = offsets.slice(range.start, range.end);
  if (original === text) throw new Error('The replacement equals the selected source; nothing would change.');
  const result = source.slice(0, offsets.unit(range.start)) + text + source.slice(offsets.unit(range.end));
  validateSource(result);

  const textPoints = Array.from(text).length;
  const after = parse(result) as unknown as Record<string, unknown>;
  const type = String(node.type);
  const replaced = astNodes(after as never).find((candidate) => candidate.path === path)?.node;
  const replacedStart = (replaced?.pos as { startOffset?: number } | undefined)?.startOffset;
  if (replaced?.type !== type || replacedStart !== range.start) {
    throw new SourceEditRefusal(`The replacement no longer parses as the selected ${type}.`,
      { reason: 'node-kind-changed', expected: type, actual: replaced && replacedStart === range.start ? String(replaced.type) : null });
  }
  const trailingSpace = textPoints - Array.from(text.replace(/[ \t\r\n]+$/u, '')).length;
  assertSurroundingsUnchanged(ast, after, path, range.start, range.end, textPoints - (range.end - range.start), trailingSpace);

  const unitStart = offsets.unit(range.start);
  const findings = compareFindings(lintFindings(source), lintFindings(result), unitStart, offsets.unit(range.end), unitStart + text.length);
  if (findings.introduced.length > 0) {
    const listed = findings.introduced.map(({ rule, line }) => `${rule} (line ${line})`).join(', ');
    throw new SourceEditRefusal(`The replacement introduces lint findings: ${listed}.`, { reason: 'new-lint-findings', introduced: findings.introduced });
  }

  const start = offsets.byte(range.start);
  const end = offsets.byte(range.end);
  const identity = astIdentity(node);
  const output = {
    match: { path, type, ...(identity ? { identity } : {}) },
    sha256, resultSha256: sha256Text(result), start, end,
    patch: splicePatch(source, start, end, text, 'replace-source'),
    undoPatch: splicePatch(result, start, start + Buffer.byteLength(text, 'utf8'), original, 'revert-replace-source'),
    lint: { introduced: [] as LintFinding[], resolved: findings.resolved },
    ...(options.includeSource ? { source: result } : {}),
  };
  validateStructuredPayload(output, 'Source replacement');
  return { output, result };
}
