import { dirname, extname, posix } from 'node:path';
import type { LintPlatform, LintWarning } from '@markup-carve/carve';
import { lint, parse } from './tools.js';
import type { Workspace } from './workspace.js';

export interface ProjectWarning {
  rule: 'missing-local-file' | 'broken-local-anchor' | 'unreadable-document';
  message: string;
  path: string;
  target?: string;
  line: number;
  column: number;
}

const CARVE_EXTENSIONS = new Set(['.crv', '.carve']);
const DOCUMENT_EXTENSIONS = new Set(['.crv', '.carve', '.md', '.markdown', '.txt', '.html', '.htm', '.djot']);
const ANCHOR_EXTENSIONS = new Set(['.crv', '.carve', '.md', '.markdown', '.djot']);
const LINK = /!?(?:\[[^\]\n]*\])\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const MAX_PROJECT_BYTES = 25_000_000;

function opaqueRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let fence: '`' | '~' | undefined;
  for (const line of source.split(/(?<=\n)/)) {
    const trimmed = line.trimStart();
    const marker = trimmed.startsWith('```') ? '`' : trimmed.startsWith('~~~') ? '~' : undefined;
    if (fence || marker) ranges.push([offset, offset + line.length]);
    if (marker && !fence) fence = marker;
    else if (marker === fence) fence = undefined;
    offset += line.length;
  }
  for (const match of source.matchAll(/`+[^`\n]*`+/g)) ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  return ranges;
}

function lineColumn(source: string, offset: number) {
  const before = source.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function headingIds(source: string): Set<string> {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.type === 'heading' && node.attrs && typeof node.attrs === 'object') {
      const id = (node.attrs as Record<string, unknown>).id;
      if (typeof id === 'string') ids.add(id.toLowerCase());
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(parse(source));
  return ids;
}

function localTarget(from: string, raw: string): { path: string; fragment?: string } | undefined {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(raw)) return undefined;
  const [rawPath, fragment] = raw.split('#', 2);
  if (!rawPath || rawPath.includes('%')) return undefined;
  const path = posix.normalize(posix.join(dirname(from).replaceAll('\\', '/'), rawPath));
  if (path === '..' || path.startsWith('../')) return undefined;
  return { path, fragment: fragment?.includes('%') ? undefined : fragment };
}

export async function reviewWorkspace(
  workspace: Workspace,
  rootIndex: number,
  options: { maxDepth?: number; limit?: number; platforms?: LintPlatform[] } = {},
) {
  const listed = await workspace.list(rootIndex, options);
  const discovered = new Set(listed.files);
  const sources = new Map<string, string>();
  const readWarnings: ProjectWarning[] = [];
  let totalBytes = 0;
  let sizeTruncated = false;
  for (const path of listed.files) {
    let read;
    try { read = await workspace.read(rootIndex, path); }
    catch (error) {
      readWarnings.push({ rule: 'unreadable-document', path, line: 1, column: 1,
        message: `Document could not be reviewed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (totalBytes + read.bytes > MAX_PROJECT_BYTES) { sizeTruncated = true; break; }
    totalBytes += read.bytes;
    sources.set(path, read.content);
  }

  const files = [];
  const ruleCounts = new Map<string, number>();
  let warningCount = 0;
  for (const [path, source] of sources) {
    if (!CARVE_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const result = lint(source, options.platforms ?? []);
    const warnings = result.warnings.map((warning: LintWarning) => ({
      ...warning, resourceUri: `carve://lint-rules/${warning.rule}`,
    }));
    for (const warning of warnings) ruleCounts.set(warning.rule, (ruleCounts.get(warning.rule) ?? 0) + 1);
    warningCount += warnings.length;
    files.push({ path, valid: warnings.length === 0, warningCount: warnings.length, warnings });
  }

  const projectWarnings: ProjectWarning[] = [...readWarnings];
  const anchors = new Map<string, Set<string>>();
  for (const [path, source] of sources) {
    if (ANCHOR_EXTENSIONS.has(extname(path).toLowerCase())) anchors.set(path, headingIds(source));
  }
  for (const [path, source] of sources) {
    const opaque = opaqueRanges(source);
    for (const match of source.matchAll(LINK)) {
      if (opaque.some(([start, end]) => (match.index ?? 0) >= start && (match.index ?? 0) < end)) continue;
      if (match[0].startsWith('!')) continue;
      const target = localTarget(path, match[1]);
      if (!target) continue;
      if (!DOCUMENT_EXTENSIONS.has(extname(target.path).toLowerCase())) continue;
      const location = lineColumn(source, (match.index ?? 0) + match[0].indexOf(match[1]));
      if (!discovered.has(target.path)) {
        projectWarnings.push({ rule: 'missing-local-file', path, target: match[1], ...location,
          message: `Local link target does not exist in this workspace review: ${target.path}` });
      } else if (target.fragment && anchors.has(target.path) && !anchors.get(target.path)?.has(target.fragment.toLowerCase())) {
        projectWarnings.push({ rule: 'broken-local-anchor', path, target: match[1], ...location,
          message: `Local link anchor does not exist in ${target.path}: #${target.fragment}` });
      }
    }
  }
  projectWarnings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  for (const warning of projectWarnings) ruleCounts.set(warning.rule, (ruleCounts.get(warning.rule) ?? 0) + 1);

  return {
    rootIndex,
    valid: warningCount + projectWarnings.length === 0,
    filesDiscovered: listed.files.length,
    filesChecked: files.length,
    warningCount: warningCount + projectWarnings.length,
    ruleCounts: Object.fromEntries([...ruleCounts].sort(([a], [b]) => a.localeCompare(b))),
    files,
    projectWarnings,
    truncated: listed.truncated || sizeTruncated,
    totalBytes,
  };
}
