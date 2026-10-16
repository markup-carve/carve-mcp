import { dirname, extname, posix, resolve } from 'node:path';
import GithubSlugger from 'github-slugger';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { LintPlatform, LintWarning } from '@markup-carve/carve';
import { AST_CHILD_FIELDS } from './ast-fields.js';
import { expandDocument } from './includes.js';
import { format as formatCarve, lint, parse } from './tools.js';
import type { Workspace } from './workspace.js';

export interface ProjectWarning {
  rule: 'missing-local-file' | 'broken-local-anchor' | 'invalid-local-target' | 'unreadable-document' | 'include-warning' | 'incomplete-scan';
  code: 'CARVE_PROJECT_MISSING_FILE' | 'CARVE_PROJECT_BROKEN_ANCHOR' | 'CARVE_PROJECT_INVALID_TARGET' | 'CARVE_PROJECT_UNREADABLE_DOCUMENT' | 'CARVE_PROJECT_INCLUDE_WARNING' | 'CARVE_PROJECT_INCOMPLETE_SCAN';
  severity: 'error' | 'warning';
  message: string;
  suggestion: string;
  path: string;
  target?: string;
  line: number;
  column: number;
}

const CARVE_EXTENSIONS = new Set(['.crv', '.carve']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const DOCUMENT_EXTENSIONS = new Set(['.crv', '.carve', '.md', '.markdown', '.txt', '.html', '.htm', '.djot']);
const ANCHOR_EXTENSIONS = new Set(['.crv', '.carve', '.md', '.markdown', '.djot']);
const LINK = /!?(?:\[[^\]\n]*\])\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const MAX_PROJECT_BYTES = 25_000_000;

const PROJECT_DIAGNOSTICS = {
  'missing-local-file': { code: 'CARVE_PROJECT_MISSING_FILE', severity: 'error', suggestion: 'Fix the destination or add the missing document.' },
  'broken-local-anchor': { code: 'CARVE_PROJECT_BROKEN_ANCHOR', severity: 'error', suggestion: 'Update the fragment to match an ID in the destination document.' },
  'invalid-local-target': { code: 'CARVE_PROJECT_INVALID_TARGET', severity: 'error', suggestion: 'Fix the local link destination before publishing.' },
  'unreadable-document': { code: 'CARVE_PROJECT_UNREADABLE_DOCUMENT', severity: 'warning', suggestion: 'Make the file readable UTF-8 text or exclude it from the review.' },
  'include-warning': { code: 'CARVE_PROJECT_INCLUDE_WARNING', severity: 'error', suggestion: 'Fix the include target or line range before publishing.' },
  'incomplete-scan': { code: 'CARVE_PROJECT_INCOMPLETE_SCAN', severity: 'error', suggestion: 'Increase the review limit or reduce the workspace scope.' },
} as const;

function projectWarning(rule: ProjectWarning['rule'], warning: Omit<ProjectWarning, 'rule' | 'code' | 'severity' | 'suggestion'>): ProjectWarning {
  return { rule, ...PROJECT_DIAGNOSTICS[rule], ...warning };
}

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

type MarkdownNode = {
  type: string; value?: string; url?: string; identifier?: string;
  position?: { start: { offset?: number } };
  children?: MarkdownNode[];
};

function markdownWalk(source: string, visit: (node: MarkdownNode, definitions: Map<string, string>) => void): void {
  const root = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MarkdownNode;
  const definitions = new Map<string, string>();
  const walk = (node: MarkdownNode, collect: boolean): void => {
    if (collect && node.type === 'definition' && node.identifier && node.url) {
      definitions.set(node.identifier.toLowerCase(), node.url);
    }
    if (!collect) visit(node, definitions);
    for (const child of node.children ?? []) walk(child, collect);
  };
  walk(root, true);
  walk(root, false);
}

function headingText(nodes: MarkdownNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'html') return '';
    if (node.children) return headingText(node.children);
    return node.value ?? '';
  }).join('');
}

function documentLinks(path: string, source: string): Array<{ raw: string; line: number; column: number }> {
  if (CARVE_EXTENSIONS.has(extname(path).toLowerCase())) {
    const links: Array<{ raw: string; line: number; column: number }> = [];
    const codepoints = Array.from(source);
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (node.type === 'link' && typeof node.href === 'string') {
        const pos = node.pos as { startOffset?: number; endOffset?: number; startLine?: number; startColumn?: number } | undefined;
        const start = pos?.startOffset ?? 0;
        const segment = codepoints.slice(start, pos?.endOffset).join('');
        const marker = node.ref ? -1 : segment.indexOf('](');
        const hrefAt = marker < 0 ? -1 : segment.indexOf(node.href, marker + 2);
        const location = hrefAt < 0 ? { line: pos?.startLine ?? 1, column: pos?.startColumn ?? 1 }
          : lineColumn(source, codepoints.slice(0, start).join('').length + hrefAt);
        links.push({ raw: node.href, ...location });
      }
      for (const field of AST_CHILD_FIELDS) if (Object.hasOwn(node, field)) walk(node[field]);
    };
    walk(parse(source));
    return links;
  }
  if (MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase())) {
    const links: Array<{ raw: string; line: number; column: number }> = [];
    markdownWalk(source, (node, definitions) => {
      const raw = node.type === 'link' ? node.url
        : node.type === 'linkReference' ? definitions.get(node.identifier?.toLowerCase() ?? '') : undefined;
      if (raw) links.push({ raw, ...lineColumn(source, node.position?.start.offset ?? 0) });
    });
    return links;
  }
  const opaque = opaqueRanges(source);
  return [...source.matchAll(LINK)].filter((match) => !match[0].startsWith('!')
    && !opaque.some(([start, end]) => (match.index ?? 0) >= start && (match.index ?? 0) < end))
    .map((match) => ({ raw: match[1]!, ...lineColumn(source, (match.index ?? 0) + match[0].indexOf(match[1]!)) }));
}

// Carve ids compare exactly (carve#2732). Markdown and Djot targets keep the
// fold: their anchors follow their own renderer's slug rule, not Carve's.
function foldsAnchors(path: string): boolean {
  return !CARVE_EXTENSIONS.has(extname(path).toLowerCase());
}

function anchorIds(source: string, fold: boolean): Set<string> {
  return anchorIdsFromTree(parse(source), fold);
}

function markdownAnchorIds(source: string): Set<string> {
  const ids = new Set<string>();
  const slugger = new GithubSlugger();
  markdownWalk(source, (node) => {
    if (node.type === 'heading') ids.add(slugger.slug(headingText(node.children ?? [])));
  });
  return ids;
}

function anchorIdsFromTree(tree: unknown, fold: boolean): Set<string> {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if ((!fold || node.type === 'heading') && node.attrs && typeof node.attrs === 'object') {
      const id = (node.attrs as Record<string, unknown>).id;
      if (typeof id === 'string') ids.add(fold ? id.toLowerCase() : id);
    }
    for (const field of AST_CHILD_FIELDS) if (Object.hasOwn(node, field)) walk(node[field]);
  };
  walk(tree);
  return ids;
}

function localTarget(from: string, raw: string): { path: string; fragment?: string } | { invalid: string } | undefined {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(raw)) return undefined;
  const [encodedPath, encodedFragment] = raw.split('#', 2);
  if (!encodedPath) return undefined;
  let decodedPath: string;
  let fragment: string | undefined;
  try {
    decodedPath = decodeURIComponent(encodedPath);
    fragment = encodedFragment === undefined ? undefined : decodeURIComponent(encodedFragment);
  } catch {
    return { invalid: 'The local link has malformed percent escapes.' };
  }
  const path = posix.normalize(posix.join(dirname(from).replaceAll('\\', '/'), decodedPath));
  if (path === '..' || path.startsWith('../') || decodedPath.startsWith('/')) {
    return { invalid: 'The local link escapes the workspace root.' };
  }
  return { path, fragment };
}

export async function reviewWorkspace(
  workspace: Workspace,
  rootIndex: number,
  options: { maxDepth?: number; limit?: number; platforms?: LintPlatform[]; checkLinks?: boolean; checkAnchors?: boolean;
    strict?: boolean; replacements?: ReadonlyMap<string, string> } = {},
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
      readWarnings.push(projectWarning('unreadable-document', { path, line: 1, column: 1,
        message: `Document could not be reviewed: ${error instanceof Error ? error.message : String(error)}` }));
      continue;
    }
    const replacement = options.replacements?.get(path);
    const bytes = replacement === undefined ? read.bytes : Buffer.byteLength(replacement, 'utf8');
    if (totalBytes + bytes > MAX_PROJECT_BYTES) { sizeTruncated = true; break; }
    totalBytes += bytes;
    sources.set(path, replacement ?? read.content);
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
  const includeDependencies: Array<{ path: string; dependency: string; resolved: boolean }> = [];
  const includeAdjustments: Array<{ path: string; rule: string; message: string; line: number; column: number }> = [];
  let unresolvedInclude = false;
  let suppressedIncludeWarnings = false;
  const expandedAnchors = new Map<string, Set<string>>();
  const includeWarningKeys = new Set<string>();
  if (options.strict) {
    const root = workspace.roots[rootIndex]!.real;
    const replacements = new Map([...options.replacements ?? []].map(([path, content]) => [resolve(root, path), content]));
    for (const [path, source] of sources) {
      if (!CARVE_EXTENSIONS.has(extname(path).toLowerCase())) continue;
      let result;
      try { result = expandDocument(source, [], { rootIndex, root, sourcePath: path, allowedPaths: new Set(sources.keys()), replacements }); }
      catch (error) {
        projectWarnings.push(projectWarning('include-warning', { path, line: 1, column: 1,
          message: `Include validation failed: ${error instanceof Error ? error.message : String(error)}` }));
        continue;
      }
      expandedAnchors.set(path, anchorIdsFromTree(result.doc, false));
      for (const warning of result.includes.warnings) {
        if (['include-heading-clamp', 'include-id-rename', 'include-footnote-rename'].includes(warning.rule)) {
          includeAdjustments.push({ path: warning.file ?? path, rule: warning.rule, message: warning.message,
            line: warning.line, column: warning.column });
          continue;
        }
        const key = `${warning.file ?? path}\u0000${warning.line}\u0000${warning.column}\u0000${warning.rule}`;
        if (includeWarningKeys.has(key)) continue;
        includeWarningKeys.add(key);
        projectWarnings.push(projectWarning('include-warning', { path: warning.file ?? path, line: warning.line, column: warning.column,
          message: warning.rule === 'include-unresolved'
            ? `${warning.rule}: ${warning.message} Check the path and review scope (depth, limit, exclusions).`
            : `${warning.rule}: ${warning.message}` }));
      }
      if (result.includes.suppressedWarnings > 0) {
        suppressedIncludeWarnings = true;
        projectWarnings.push(projectWarning('include-warning', { path, line: 1, column: 1,
          message: `${result.includes.suppressedWarnings} additional include warnings were suppressed.` }));
      }
      for (const dependency of result.includes.dependencies) {
        if (!dependency.resolved) unresolvedInclude = true;
        includeDependencies.push({ path, dependency: dependency.path, resolved: dependency.resolved });
      }
    }
  }
  if (options.strict && (listed.truncated || sizeTruncated)) projectWarnings.push(projectWarning('incomplete-scan', { path: '', line: 1, column: 1,
    message: 'Workspace review stopped at a file or byte limit.' }));
  const anchors = new Map<string, Set<string>>();
  if (options.checkLinks !== false && options.checkAnchors !== false) {
    for (const [path, source] of sources) {
      if (MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase())) anchors.set(path, markdownAnchorIds(source));
      else if (ANCHOR_EXTENSIONS.has(extname(path).toLowerCase())) anchors.set(path, expandedAnchors.get(path) ?? anchorIds(source, foldsAnchors(path)));
    }
  }
  for (const [path, source] of sources) {
    if (options.checkLinks === false) break;
    for (const link of documentLinks(path, source)) {
      const target = localTarget(path, link.raw);
      if (!target) continue;
      if ('invalid' in target) {
        projectWarnings.push(projectWarning('invalid-local-target', { path, target: link.raw,
          line: link.line, column: link.column, message: target.invalid }));
        continue;
      }
      if (!DOCUMENT_EXTENSIONS.has(extname(target.path).toLowerCase())) continue;
      const location = { line: link.line, column: link.column };
      if (!discovered.has(target.path)) {
        projectWarnings.push(projectWarning('missing-local-file', { path, target: link.raw, ...location,
          message: `Local link target does not exist in this workspace review: ${target.path}` }));
      } else if (options.checkAnchors !== false && target.fragment && anchors.has(target.path) && !anchors.get(target.path)?.has(foldsAnchors(target.path) ? target.fragment.toLowerCase() : target.fragment)) {
        projectWarnings.push(projectWarning('broken-local-anchor', { path, target: link.raw, ...location,
          message: `Local link anchor does not exist in ${target.path}: #${target.fragment}` }));
      }
    }
  }
  projectWarnings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  for (const warning of projectWarnings) ruleCounts.set(warning.rule, (ruleCounts.get(warning.rule) ?? 0) + 1);
  const bySeverity = {
    error: projectWarnings.filter((warning) => warning.severity === 'error').length,
    warning: warningCount + projectWarnings.filter((warning) => warning.severity === 'warning').length,
  };
  const nextActions = warningCount > 0
    ? ['Review the reported Carve lint diagnostics, starting with reader-visible problems.']
    : [];
  for (const warning of projectWarnings) {
    if (!nextActions.includes(warning.suggestion) && nextActions.length < 5) nextActions.push(warning.suggestion);
  }
  const automaticPaths: string[] = [];
  const lossPaths: string[] = [];
  for (const [path, source] of sources) {
    if (!CARVE_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const formatted = formatCarve(source);
    if (formatted.value === source) continue;
    (formatted.totalLosses === 0 ? automaticPaths : lossPaths).push(path);
  }
  const writerReview = [...ruleCounts].map(([rule, count]) => {
    const project = projectWarnings.find((warning) => warning.rule === rule);
    return {
      rule, code: project?.code ?? rule, severity: project?.severity ?? 'warning', count, mode: 'writer-review' as const,
      paths: undefined as string[] | undefined,
      action: project?.suggestion ?? `Review the ${rule} diagnostics and choose the smallest reader-focused correction.`,
    };
  });
  if (lossPaths.length) writerReview.push({
    rule: 'format-loss', code: 'CARVE_PROJECT_FORMAT_LOSS', severity: 'warning', count: lossPaths.length, mode: 'writer-review' as const,
    paths: lossPaths, action: 'Inspect formatting losses before accepting canonical output.',
  });
  writerReview.sort((left, right) => (left.severity === right.severity ? left.rule.localeCompare(right.rule) : left.severity === 'error' ? -1 : 1));

  return {
    rootIndex,
    valid: warningCount + projectWarnings.length === 0 && !(options.strict && (listed.truncated || sizeTruncated)),
    filesDiscovered: listed.files.length,
    filesChecked: files.length,
    warningCount: warningCount + projectWarnings.length,
    summary: { bySeverity, nextActions },
    fixPlan: {
      automatic: automaticPaths.length ? [{ kind: 'canonical-format', mode: 'automatic-format', paths: automaticPaths,
        action: 'Preview canonical formatting; it requires no writer judgment and reports no losses.' }] : [],
      writerReview: writerReview.map((group, index) => ({ priority: index + 1, ...group })),
    },
    ruleCounts: Object.fromEntries([...ruleCounts].sort(([a], [b]) => a.localeCompare(b))),
    files,
    projectWarnings,
    truncated: listed.truncated || sizeTruncated,
    totalBytes,
    checks: { localLint: true, localLinks: options.checkLinks !== false, anchors: options.checkLinks !== false && options.checkAnchors !== false,
      includes: options.strict === true, suppressedIncludeWarnings,
      complete: !(listed.truncated || sizeTruncated || readWarnings.length > 0 || unresolvedInclude || suppressedIncludeWarnings) },
    includeDependencies,
    includeAdjustments,
    filesRead: [...sources.keys()],
    scope: { maxDepth: listed.maxDepth, limit: listed.limit, excluded: workspace.review.exclude ?? [] },
  };
}
