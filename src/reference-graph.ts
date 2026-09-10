import { dirname, extname, posix } from 'node:path';
import { parse } from './tools.js';
import type { Workspace } from './workspace.js';

const CARVE_EXTENSIONS = new Set(['.crv', '.carve']);
const AST_CHILD_FIELDS = ['children', 'items', 'rows', 'cells', 'inline', 'content', 'caption', 'shortCaption', 'title'] as const;
const MAX_GRAPH_BYTES = 25_000_000;

type GraphKind = 'heading' | 'footnote' | 'abbreviation' | 'link' | 'image';
interface Location { path: string; line: number; column: number; start: number; end: number }
interface Definition extends Location { id: string; kind: Exclude<GraphKind, 'link' | 'image'> }
interface Reference extends Location { id: string; kind: GraphKind; targetPath: string; targetId?: string }

function location(path: string, node: Record<string, unknown>): Location {
  const pos = (node.pos ?? {}) as Record<string, unknown>;
  return { path, line: Number(pos.startLine ?? 1), column: Number(pos.startColumn ?? 1), start: Number(pos.startOffset ?? 0), end: Number(pos.endOffset ?? 0) };
}

function linkTarget(from: string, href: string): { path: string; id?: string } | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(href)) return null;
  const [rawPath, id] = href.split('#', 2);
  if (!rawPath) return { path: from, id };
  const path = posix.normalize(posix.join(dirname(from).replaceAll('\\', '/'), rawPath));
  if (path === '..' || path.startsWith('../')) return null;
  return { path, id };
}

function collect(path: string, ast: unknown): { definitions: Definition[]; references: Reference[] } {
  const definitions: Definition[] = [];
  const references: Reference[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    const at = location(path, node);
    const attrs = (node.attrs ?? {}) as Record<string, unknown>;
    if (node.type === 'heading' && typeof attrs.id === 'string') definitions.push({ ...at, kind: 'heading', id: attrs.id });
    if (node.type === 'footnote' && typeof node.label === 'string') definitions.push({ ...at, kind: 'footnote', id: node.label });
    if (node.type === 'abbreviation_def' && typeof node.abbr === 'string') definitions.push({ ...at, kind: 'abbreviation', id: node.abbr });
    if (node.type === 'heading_ref' && typeof node.target === 'string') references.push({ ...at, kind: 'heading', id: node.target, targetPath: path, targetId: node.target });
    if (node.type === 'footnote_ref' && typeof node.id === 'string') references.push({ ...at, kind: 'footnote', id: node.id, targetPath: path, targetId: node.id });
    if ((node.type === 'link' || node.type === 'image') && typeof (node.href ?? node.src) === 'string') {
      const href = String(node.href ?? node.src);
      const target = linkTarget(path, href);
      references.push({ ...at, kind: node.type, id: href, targetPath: target?.path ?? href, targetId: target?.id });
    }
    for (const field of AST_CHILD_FIELDS) if (Object.hasOwn(node, field)) walk(node[field]);
  };
  walk(ast);
  return { definitions, references };
}

export async function buildReferenceGraph(workspace: Workspace, rootIndex: number, options: { maxDepth?: number; limit?: number } = {}) {
  const listed = await workspace.list(rootIndex, options);
  const definitions: Definition[] = [];
  const references: Reference[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const parsedPaths = new Set<string>();
  let totalBytes = 0;
  let sizeTruncated = false;
  for (const path of listed.files.filter((file) => CARVE_EXTENSIONS.has(extname(file).toLowerCase()))) {
    try {
      const read = await workspace.read(rootIndex, path);
      if (totalBytes + read.bytes > MAX_GRAPH_BYTES) { sizeTruncated = true; break; }
      totalBytes += read.bytes;
      const found = collect(path, parse(read.content));
      parsedPaths.add(path);
      definitions.push(...found.definitions);
      references.push(...found.references);
    } catch (error) {
      errors.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const byLocation = (left: Location, right: Location) => left.path.localeCompare(right.path) || left.start - right.start || left.end - right.end;
  definitions.sort(byLocation);
  references.sort(byLocation);
  const key = (kind: string, path: string, id: string) => `${kind}\0${path}\0${kind === 'heading' ? id : id.toLowerCase()}`;
  const definitionKeys = new Set(definitions.map((item) => key(item.kind, item.path, item.id)));
  const listedFiles = new Set(listed.files);
  const edges = references.map((reference) => {
    const localKind = reference.kind === 'heading' || reference.kind === 'footnote';
    const resolved = localKind ? definitionKeys.has(key(reference.kind, reference.targetPath, reference.targetId ?? reference.id))
      : reference.kind === 'link' ? /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(reference.id)
        || (listedFiles.has(reference.targetPath) && (!reference.targetId
          || (!CARVE_EXTENSIONS.has(extname(reference.targetPath).toLowerCase()) || !parsedPaths.has(reference.targetPath)
            ? null : definitionKeys.has(key('heading', reference.targetPath, reference.targetId)))))
      : /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(reference.id) ? true : null;
    return { ...reference, resolved };
  });
  const used = new Set(edges.filter(({ resolved }) => resolved).map((edge) => key(edge.kind, edge.targetPath, edge.targetId ?? edge.id)));
  const orphans = definitions.filter((definition) => definition.kind === 'footnote' && !used.has(key(definition.kind, definition.path, definition.id)));
  return {
    rootIndex, definitions, references: edges, brokenReferences: edges.filter(({ resolved }) => resolved === false), orphans, errors,
    counts: { definitions: definitions.length, references: edges.length, broken: edges.filter(({ resolved }) => resolved === false).length, orphans: orphans.length },
    truncated: listed.truncated || sizeTruncated, totalBytes,
  };
}
