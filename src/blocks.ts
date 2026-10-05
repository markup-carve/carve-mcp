import { createHash } from 'node:crypto';
import { MAX_AST_SELECTOR_MATCHES, astIdentity, matchingAstNodes, parentArrayLocation, parse, validateSource, validateStructuredPayload, type AstSelector } from './tools.js';

export type BlockScope = 'node' | 'section';

export function sha256Text(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

type Position = { startLine: number; endLine: number; startOffset: number; endOffset: number };

function position(node: Record<string, unknown>): Position | undefined {
  const pos = node.pos as Partial<Position> | undefined;
  if (!pos || typeof pos.startOffset !== 'number' || typeof pos.endOffset !== 'number') return undefined;
  return pos as Position;
}

// Engine positions count Unicode code points over the source as given, with
// CRLF and a leading BOM intact. Slicing and patches need UTF-16 indexes and
// UTF-8 bytes, so every offset passes through here.
export class SourceOffsets {
  private readonly units: number[] = [];
  private readonly bytes: number[] = [];

  constructor(readonly source: string) {
    let unit = 0;
    let byte = 0;
    for (const character of source) {
      this.units.push(unit);
      this.bytes.push(byte);
      const point = character.codePointAt(0)!;
      unit += character.length;
      byte += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    }
    this.units.push(unit);
    this.bytes.push(byte);
  }

  get codePoints(): number { return this.units.length - 1; }
  unit(point: number): number { return this.units[this.checked(point)]!; }
  byte(point: number): number { return this.bytes[this.checked(point)]!; }
  slice(start: number, end: number): string { return this.source.slice(this.unit(start), this.unit(end)); }

  private checked(point: number): number {
    if (!Number.isInteger(point) || point < 0 || point > this.codePoints) throw new Error('AST position lies outside the source.');
    return point;
  }
}

export interface SourceRange { start: number; end: number; startLine: number; endLine: number }

// A section runs from its heading to the last node before the next heading of
// the same or a higher level in the same container. Trailing blank lines and a
// following heading's attribute line stay outside it.
export function nodeRange(ast: Record<string, unknown>, path: string, node: Record<string, unknown>, scope: BlockScope): SourceRange {
  const own = position(node);
  if (!own) throw new Error(`The selected ${String(node.type)} has no source position.`);
  if (scope === 'node') return { start: own.startOffset, end: own.endOffset, startLine: own.startLine, endLine: own.endLine };
  if (node.type !== 'heading') throw new Error('scope "section" requires a heading.');
  const location = parentArrayLocation(ast as never, path);
  if (!location) throw new Error('The selected heading is not inside a container.');
  const level = Number(node.level);
  const siblingPosition = (value: unknown) => (value && typeof value === 'object' ? position(value as Record<string, unknown>) : undefined);
  let boundary = Number.POSITIVE_INFINITY;
  for (const value of location.parent) {
    const pos = siblingPosition(value);
    const record = value as Record<string, unknown>;
    if (pos && record.type === 'heading' && Number(record.level) <= level && pos.startOffset > own.startOffset) boundary = Math.min(boundary, pos.startOffset);
  }
  let last = own;
  for (const value of location.parent) {
    const pos = siblingPosition(value);
    if (pos && pos.startOffset >= own.startOffset && pos.startOffset < boundary && pos.endOffset > last.endOffset) last = pos;
  }
  return { start: own.startOffset, end: last.endOffset, startLine: own.startLine, endLine: last.endLine };
}

export function resolveSourceBlocks(source: string, selector: AstSelector) {
  validateSource(source);
  const ast = parse(source) as unknown as Record<string, unknown>;
  return { ast, offsets: new SourceOffsets(source), selected: matchingAstNodes(ast as never, selector) };
}

function identityField(node: Record<string, unknown>) {
  const identity = astIdentity(node);
  return identity ? { identity } : {};
}

export function getBlocks(source: string, selector: AstSelector, options: { scope?: BlockScope; includeAst?: boolean; sha256?: string } = {}) {
  const scope = options.scope ?? 'node';
  const { ast, offsets, selected } = resolveSourceBlocks(source, selector);
  const blocks = selected.slice(0, MAX_AST_SELECTOR_MATCHES).map(({ path, node }) => ({ path, node, range: nodeRange(ast, path, node, scope) })).map(({ path, node, range }) => ({
    path, type: String(node.type), ...identityField(node),
    start: offsets.byte(range.start), end: offsets.byte(range.end), startLine: range.startLine, endLine: range.endLine,
    source: offsets.slice(range.start, range.end),
    ...(options.includeAst ? { node } : {}),
  }));
  const output = {
    sha256: options.sha256 ?? sha256Text(source), sourceBytes: offsets.byte(offsets.codePoints),
    matchCount: selected.length, blocks, truncated: selected.length > MAX_AST_SELECTOR_MATCHES,
  };
  validateStructuredPayload(output, 'Block result');
  return output;
}
