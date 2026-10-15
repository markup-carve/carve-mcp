import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { expandIncludes, parse, type CarveExtension, type Document, type IncludeResolver } from '@markup-carve/carve';
import { fileSystemResolver } from '@markup-carve/carve/node';
import { documentPathRefusal, type Workspace } from './workspace.js';

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
export function policyResolver(root: string, allowedPaths?: ReadonlySet<string>, replacements?: ReadonlyMap<string, string>): IncludeResolver {
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
    if (documentPathRefusal(lexical) || documentPathRefusal(canonical)) return { source: null, id: includePath, denial: 'denied' };
    try { if (!statSync(real).isFile()) return { source: null, id: includePath, denial: 'denied' }; }
    catch { return { source: null, id: includePath, denial: 'denied' }; }
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

export function expandDocument(source: string, extensions: CarveExtension[], scope: IncludeScope): { doc: Document; includes: IncludeReport } {
  const doc = parse(source, { extensions, positions: true });
  const expanded = expandIncludes(doc, source, {
    resolve: policyResolver(scope.root, scope.allowedPaths, scope.replacements),
    ...(scope.sourcePath ? { sourcePath: scope.sourcePath } : {}),
    extensions,
  });
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
