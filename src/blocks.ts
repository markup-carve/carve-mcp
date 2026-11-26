import { createHash } from 'node:crypto';
import { MAX_AST_SELECTOR_MATCHES, astIdentity, matchingAstNodes, parentArrayLocation, parse, validateSource, validateStructuredPayload, type AstSelector } from './tools.js';

export type BlockScope = 'node' | 'section';

export function sha256Text(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

type Position = { startLine: number; endLine: number; startOffset: number; endOffset: number };

export function position(node: Record<string, unknown>): Position | undefined {
  const pos = node.pos as Partial<Position> | undefined;
  if (!pos || typeof pos.startOffset !== 'number' || typeof pos.endOffset !== 'number') return undefined;
  return pos as Position;
}

// 0.2 engine positions are UTF-8 byte offsets over the source as given, with
// CRLF and a leading BOM intact. Slicing needs UTF-16 indexes, so every offset
// passes through here.
export class SourceOffsets {
  private readonly units = new Map<number, number>();
  private readonly length: number;

  constructor(readonly source: string) {
    let unit = 0;
    let byte = 0;
    for (const character of source) {
      this.units.set(byte, unit);
      const point = character.codePointAt(0)!;
      unit += character.length;
      byte += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    }
    this.units.set(byte, unit);
    this.length = byte;
  }

  get codePoints(): number { return this.length; }
  unit(offset: number): number { return this.units.get(this.checked(offset))!; }
  byte(offset: number): number { return this.checked(offset); }
  slice(start: number, end: number): string { return this.source.slice(this.unit(start), this.unit(end)); }

  private checked(offset: number): number {
    if (!Number.isInteger(offset) || !this.units.has(offset)) throw new Error('AST position lies outside the source.');
    return offset;
  }
}

export interface SourceRange { start: number; end: number; startLine: number; endLine: number }

// A section runs from its heading to the last node before the next heading of
// the same or a higher level in the same container. Trailing blank lines and a
// following heading's attribute line stay outside it.
/**
 * A 0.2 block position starts at its attribute lines; the block's own source
 * starts after them, so a replacement keeps the attributes.
 */
export function withoutAttributeLines(pos: Position, node: Record<string, unknown>, offsets: SourceOffsets): Position {
  if (!node.attrs) return pos;
  let start = pos.startOffset;
  let line = pos.startLine;
  for (;;) {
    const rest = offsets.source.slice(offsets.unit(start), offsets.unit(pos.endOffset));
    const match = /^[ \t]*\{[^\n]*\}[ \t]*\r?\n/.exec(rest);
    if (!match || match[0].length >= rest.length) return { ...pos, startOffset: start, startLine: line };
    start += Buffer.byteLength(match[0], 'utf8');
    line += 1;
  }
}

export function nodeRange(ast: Record<string, unknown>, path: string, node: Record<string, unknown>, scope: BlockScope, offsets: SourceOffsets): SourceRange {
  const positioned = position(node);
  if (!positioned) throw new Error(`The selected ${String(node.type)} has no source position.`);
  const own = withoutAttributeLines(positioned, node, offsets);
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
  const blocks = selected.slice(0, MAX_AST_SELECTOR_MATCHES).map(({ path, node }) => ({ path, node, range: nodeRange(ast, path, node, scope, offsets) })).map(({ path, node, range }) => ({
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
