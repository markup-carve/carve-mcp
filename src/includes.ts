import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileSystemResolver } from '@markup-carve/carve/v2/node';
import type { ExtensionDefinition, IncludeConfig, IncludeResolver } from '@markup-carve/carve/v2';
import { includeDependencies } from '@markup-carve/carve/v2';
import { lintDiagnostics, parseTreeWithDiagnostics, toWarning, type Diagnostic, type DocumentNode, type LintPlatform, type Warning } from './engine.js';
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
 * The engine resolver behind the same document policy `carve_read_file` applies.
 *
 * The policy is checked on the path as written and on the canonical target,
 * and only a regular file is opened: reading a FIFO would block the process.
 * A file of any other extension is handed out only to a `@code` include.
 */
export function policyResolver(root: string, allowedPaths?: ReadonlySet<string>, replacements?: ReadonlyMap<string, string>): IncludeResolver {
  const inner = fileSystemResolver(root);
  return (request) => {
    if (isAbsolute(request.path)) return { error: 'outside_root' };
    const base = request.from ? dirname(resolve(root, request.from)) : root;
    const requested = resolve(base, request.path);
    let real: string;
    try { real = realpathSync(requested); }
    catch { return inner(request); }
    const lexical = contained(root, requested);
    const canonical = contained(root, real);
    if (lexical === undefined || canonical === undefined) return inner(request);
    if (allowedPaths && (!allowedPaths.has(lexical) || !allowedPaths.has(canonical))) return { error: 'outside_root' };
    if (hiddenPathRefusal(lexical) || hiddenPathRefusal(canonical)) return { error: 'outside_root' };
    const sourceFile = documentPathRefusal(lexical) !== undefined || documentPathRefusal(canonical) !== undefined;
    if (sourceFile && request.options.code === undefined) return { error: 'outside_root' };
    try { if (!statSync(real).isFile()) return { error: 'unreadable' }; }
    catch { return { error: 'unreadable' }; }
    const resolved = inner(request);
    const replacement = replacements?.get(real);
    if (replacement === undefined || 'error' in resolved) return resolved;
    return { ...resolved, text: replacement };
  };
}

export function includeConfig(scope: IncludeScope): IncludeConfig {
  return { resolver: policyResolver(scope.root, scope.allowedPaths, scope.replacements), ...(scope.sourcePath ? { file: scope.sourcePath } : {}) };
}

/** Rewrite every `pos.file` and include `file` to its root-relative path, dropping one outside the root. */
function relativizePositions(doc: unknown, root: string): void {
  const pending: unknown[] = [doc];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const record = value as Record<string, unknown>;
    for (const holder of [record.pos, record.type === 'include' ? record : undefined]) {
      if (holder && typeof holder === 'object' && typeof (holder as Record<string, unknown>).file === 'string') {
        const owner = holder as Record<string, unknown>;
        const file = contained(root, owner.file as string);
        if (file === undefined) delete owner.file;
        else owner.file = file;
      }
    }
    for (const [key, child] of Object.entries(record)) if (key !== 'pos' && child && typeof child === 'object') pending.push(child);
  }
}

function textReader(scope: IncludeScope, source: string) {
  const texts = new Map<string, string | undefined>();
  return (file: string | undefined): string | undefined => {
    if (file === undefined) return source;
    const path = resolve(scope.root, file);
    if (contained(scope.root, path) === undefined) return undefined;
    if (!texts.has(path)) {
      let text: string | undefined;
      try { text = scope.replacements?.get(realpathSync(path)) ?? readFileSync(path, 'utf8'); } catch { text = undefined; }
      texts.set(path, text);
    }
    return texts.get(path);
  };
}

function includeWarning(diagnostic: Diagnostic, scope: IncludeScope, read: (file: string | undefined) => string | undefined): IncludeWarningReport {
  const warning = toWarning(diagnostic, read(diagnostic.file));
  const file = diagnostic.file === undefined ? undefined : contained(scope.root, resolve(scope.root, diagnostic.file));
  return { rule: warning.rule, message: warning.message, line: warning.line, column: warning.column, ...(file ? { file } : {}) };
}

export function expandDocument(source: string, extensions: readonly ExtensionDefinition[], scope: IncludeScope): { doc: DocumentNode; includes: IncludeReport } {
  const { document, diagnostics, suppressedDiagnostics } = parseTreeWithDiagnostics(source, { extensions, includes: includeConfig(scope) });
  relativizePositions(document, scope.root);
  const read = textReader(scope, source);
  const warnings = diagnostics.filter((entry) => entry.code.startsWith('include')).map((entry) => includeWarning(entry, scope, read));
  const dependencies: IncludeDependencyReport[] = [];
  for (const dependency of includeDependencies(document)) {
    const path = contained(scope.root, resolve(scope.root, dependency.file ?? dependency.path));
    if (path && !dependencies.some((seen) => seen.path === path)) dependencies.push({ path, resolved: dependency.read });
  }
  return { doc: document, includes: { rootIndex: scope.rootIndex, warnings, dependencies, suppressedWarnings: suppressedDiagnostics } };
}

export type IncludedLintWarning = Warning;

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
 * A finding inside an included file carries that file's root-relative `file`;
 * its positions are in that file.
 */
export function lintWithIncludes(source: string, scope: IncludeScope, platforms: readonly LintPlatform[]): IncludedLintWarning[] {
  const includes = includeConfig(scope);
  const read = textReader(scope, source);
  const parsed = parseTreeWithDiagnostics(source, { includes });
  const diagnostics = [...lintDiagnostics(source, platforms, includes), ...parsed.diagnostics.filter((entry) => entry.code.startsWith('include'))];
  return diagnostics.map((diagnostic) => {
    const warning = toWarning(diagnostic, read(diagnostic.file));
    const positioned = warning.rule.startsWith('include') ? { ...warning, ...directiveSpan(read(diagnostic.file) ?? '', warning.line, warning.column) } : warning;
    if (diagnostic.file === undefined) return positioned;
    const file = contained(scope.root, resolve(scope.root, diagnostic.file));
    const { file: _dropped, ...rest } = positioned;
    return file ? { ...rest, file } : rest;
  });
}
