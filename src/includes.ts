import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { expandIncludes, parse, type CarveExtension, type Document, type IncludeResolver, type IncludeResult, type IncludeSite, type LintWarning } from '@markup-carve/carve';
import { fileSystemResolver } from '@markup-carve/carve/node';
import { documentPathRefusal, hiddenPathRefusal, type Workspace } from './workspace.js';

export interface IncludeRequest { includeRootIndex?: number; sourcePath?: string }

export interface IncludeWarningReport { rule: string; message: string; line: number; column: number; file?: string }
export interface IncludeDependencyReport { path: string; resolved: boolean }
export interface IncludeReport {
  rootIndex: number;
  warnings: IncludeWarningReport[];
  dependencies: IncludeDependencyReport[];
  suppressedWarnings: number;
}

export interface IncludeScope { rootIndex: number; root: string; sourcePath?: string; allowedPaths?: ReadonlySet<string>; replacements?: ReadonlyMap<string, string> }

/**
 * The containment root a tool call may expand includes under.
 *
 * Roots come from the server's own `--root` configuration, so document text
 * cannot name one and the process working directory can never become one.
 * Without `includeRootIndex` there is no root, and every `{{ path }}` stays
 * literal.
 */
export function includeScope(workspace: Workspace | undefined, request: IncludeRequest): IncludeScope | undefined {
  const { includeRootIndex, sourcePath } = request;
  if (includeRootIndex === undefined) {
    if (sourcePath !== undefined) throw new Error('sourcePath requires includeRootIndex; without a root, includes stay literal.');
    return undefined;
  }
  if (!workspace) throw new Error('Include expansion needs a configured workspace root. Start carve-mcp with --root.');
  const root = workspace.roots[includeRootIndex];
  if (!root) throw new Error(`Unknown root index ${includeRootIndex}. Configure a root when starting carve-mcp.`);
  if (sourcePath === undefined) return { rootIndex: includeRootIndex, root: root.real };
  if (isAbsolute(sourcePath)) throw new Error('sourcePath must be relative to the configured root.');
  const normalized = sourcePath.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => segment === '..')) throw new Error('sourcePath must stay inside the configured root.');
  return { rootIndex: includeRootIndex, root: root.real, sourcePath: normalized };
}

/**
 * Report an include target by its path inside the root.
 *
 * The resolver identifies a file by its canonical absolute path, which names
 * the server's own layout. A client may be remote and the document untrusted,
 * so an identity that cannot be expressed inside the root is dropped rather
 * than sent.
 */
function contained(root: string, id: string): string | undefined {
  if (!isAbsolute(id)) return id;
  const path = relative(root, id);
  if (!path || isAbsolute(path) || path.split(sep)[0] === '..') return undefined;
  return path.split(sep).join('/');
}

/**
 * The engine resolver behind the same document policy `carve_read_file` applies.
 *
 * The policy is checked on the path as written and on the canonical target, so
 * neither `{{ .env }}` nor a `docs/env.md -> ../.env` symlink is read, and only
 * a regular file is opened: reading a FIFO would block the process. Anything
 * the engine resolver would refuse anyway (missing, outside the root,
 * absolute) is left to it so its denial classes stay intact.
 */
/**
 * Source files (any extension) a resolver may hand out for `@code` includes.
 *
 * The resolver cannot see the directive's mode, so it admits a non-document
 * file, records it in `admitted`, and the expansion is re-run with `denied`
 * naming every such file the engine spliced as Carve instead.
 */
interface SourceFilePolicy { denied: ReadonlySet<string>; admitted: Set<string> }

export function policyResolver(root: string, allowedPaths?: ReadonlySet<string>, replacements?: ReadonlyMap<string, string>, sourceFiles?: SourceFilePolicy): IncludeResolver {
  const inner = fileSystemResolver(root);
  return (includePath, ctx) => {
    if (isAbsolute(includePath)) return inner(includePath, ctx);
    const parent = ctx.stack[ctx.stack.length - 1];
    const base = parent ? dirname(resolve(root, parent)) : root;
    const requested = resolve(base, includePath);
    let real: string;
    try { real = realpathSync(requested); }
    catch { return inner(includePath, ctx); }
    const lexical = contained(root, requested);
    const canonical = contained(root, real);
    if (lexical === undefined || canonical === undefined) return inner(includePath, ctx);
    if (allowedPaths && (!allowedPaths.has(lexical) || !allowedPaths.has(canonical))) return { source: null, id: includePath, denial: 'denied' };
    if (hiddenPathRefusal(lexical) || hiddenPathRefusal(canonical)) return { source: null, id: includePath, denial: 'denied' };
    const sourceFile = documentPathRefusal(lexical) !== undefined || documentPathRefusal(canonical) !== undefined;
    if (sourceFile && (!sourceFiles || sourceFiles.denied.has(real))) return { source: null, id: includePath, denial: 'denied' };
    try { if (!statSync(real).isFile()) return { source: null, id: includePath, denial: 'denied' }; }
    catch { return { source: null, id: includePath, denial: 'denied' }; }
    if (sourceFile) sourceFiles!.admitted.add(real);
    const resolved = inner(includePath, ctx);
    const replacement = replacements?.get(real);
    if (replacement === undefined || resolved === null) return resolved;
    if (typeof resolved === 'string') return replacement;
    return resolved.source === null ? resolved : { ...resolved, source: replacement };
  };
}

/** Rewrite every `pos.file` to its root-relative path, dropping one outside the root. */
function relativizePositions(doc: Document, root: string): void {
  const pending: unknown[] = [doc];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const record = value as Record<string, unknown>;
    const pos = record.pos as Record<string, unknown> | undefined;
    if (pos && typeof pos === 'object' && typeof pos.file === 'string') {
      const file = contained(root, pos.file);
      if (file === undefined) delete pos.file;
      else pos.file = file;
    }
    for (const [key, child] of Object.entries(record)) if (key !== 'pos' && child && typeof child === 'object') pending.push(child);
  }
}

/** Re-runs allowed before a document's source-file includes all fall back to the plain document policy. */
const MAX_SOURCE_FILE_PASSES = 4;

/**
 * Expand under the document policy, admitting a file of any extension only as a `@code` block.
 *
 * A source file the document also splices as Carve is refused in both modes,
 * since the resolver cannot tell the two directives apart.
 */
function expandAdmitted(source: string, extensions: CarveExtension[], scope: IncludeScope): { expanded: IncludeResult; resolver: IncludeResolver } {
  const denied = new Set<string>();
  for (let pass = 0; pass <= MAX_SOURCE_FILE_PASSES; pass++) {
    const sourceFiles = pass < MAX_SOURCE_FILE_PASSES ? { denied, admitted: new Set<string>() } : undefined;
    const resolver = policyResolver(scope.root, scope.allowedPaths, scope.replacements, sourceFiles);
    const expanded = expandIncludes(parse(source, { extensions, positions: true }), source, {
      resolve: resolver,
      ...(scope.sourcePath ? { sourcePath: scope.sourcePath } : {}),
      extensions,
      collectIncluded: true,
    });
    const spliced = (expanded.included ?? []).filter((entry) => entry.mode === 'carve' && sourceFiles?.admitted.has(entry.file));
    if (spliced.length === 0) return { expanded, resolver };
    for (const entry of spliced) denied.add(entry.file);
  }
  throw new Error('unreachable: the last pass admits no source file');
}

export function expandDocument(source: string, extensions: CarveExtension[], scope: IncludeScope): { doc: Document; includes: IncludeReport } {
  const { expanded } = expandAdmitted(source, extensions, scope);
  relativizePositions(expanded.doc, scope.root);
  const warnings = expanded.warnings.map((warning) => {
    // `detail` carries the resolver's own error text and is never forwarded.
    const file = warning.file === undefined ? undefined : contained(scope.root, warning.file);
    return { rule: warning.rule, message: warning.message, line: warning.line, column: warning.column, ...(file ? { file } : {}) };
  });
  const dependencies: IncludeDependencyReport[] = [];
  for (const dependency of expanded.dependencies) {
    const path = contained(scope.root, dependency.id);
    if (path && !dependencies.some((seen) => seen.path === path)) dependencies.push({ path, resolved: dependency.resolved });
  }
  return { doc: expanded.doc, includes: { rootIndex: scope.rootIndex, warnings, dependencies, suppressedWarnings: expanded.suppressedWarnings } };
}

export type IncludedLintWarning = Omit<LintWarning, 'includedBy'> & { includedBy?: Array<Omit<IncludeSite, 'file'> & { file?: string }> };

/**
 * UTF-16 span of the directive token at a 1-based line and codepoint column.
 *
 * The engines disagree on the unit of an include site's offsets, so both
 * servers derive them from the position and the file text instead.
 */
export function directiveSpan(text: string, line: number, column: number): { start: number; end: number } {
  let index = 0;
  for (let current = 1; current < line; current++) {
    const next = text.slice(index).search(/\r\n|[\r\n]/);
    if (next < 0) { index = text.length; break; }
    index += next + (text.startsWith('\r\n', index + next) ? 2 : 1);
  }
  for (let step = 1; step < column && index < text.length; step++) index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  const close = text.startsWith('{{', index) ? text.indexOf('}}', index + 2) : -1;
  return { start: index, end: close < 0 ? index : close + 2 };
}

/**
 * Lint `source` and the content its includes pull in, under the policy the render tools use.
 *
 * A finding inside an included file carries that file's root-relative `file`
 * and the directive chain that reached it; its positions are in that file.
 */
export function lintWithIncludes(source: string, scope: IncludeScope, lintOne: (source: string, includes: { resolve: IncludeResolver; sourcePath?: string }) => LintWarning[]): IncludedLintWarning[] {
  const { resolver } = expandAdmitted(source, [], scope);
  const warnings = lintOne(source, { resolve: resolver, ...(scope.sourcePath ? { sourcePath: scope.sourcePath } : {}) });
  const texts = new Map<string, string>();
  const textOf = (id: string | undefined): string | undefined => {
    if (id === undefined || !isAbsolute(id)) return source;
    if (contained(scope.root, id) === undefined) return undefined;
    if (!texts.has(id)) {
      try { texts.set(id, readFileSync(id, 'utf8')); } catch { return undefined; }
    }
    return texts.get(id);
  };
  const span = (id: string | undefined, line: number, column: number) => {
    const text = textOf(id);
    return text === undefined ? { start: 0, end: 0 } : directiveSpan(text, line, column);
  };
  return warnings.map((warning) => {
    const { file, includedBy, ...rest } = warning;
    const positioned = rest.rule.startsWith('include-') ? { ...rest, ...span(file, rest.line, rest.column) } : rest;
    if (!includedBy) return positioned;
    const relative = file === undefined ? undefined : contained(scope.root, file);
    return {
      ...positioned,
      ...(relative ? { file: relative } : {}),
      includedBy: includedBy.map(({ file: site, line, column }) => {
        const path = site === undefined ? undefined : contained(scope.root, site);
        return { line, column, ...span(site, line, column), ...(path ? { file: path } : {}) };
      }),
    };
  });
}
