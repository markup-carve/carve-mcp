import { createHash, randomUUID } from 'node:crypto';
import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_SOURCE_BYTES } from './tools.js';

export interface WorkspaceOptions { roots: string[]; allowWrite?: boolean }
export interface WorkspaceRoot { configured: string; real: string }

export async function prepareWorkspace(options: WorkspaceOptions): Promise<Workspace> {
  const roots = await Promise.all(options.roots.map(async (configured) => ({
    configured: resolve(configured), real: await realpath(configured),
  })));
  for (const root of roots) {
    if (!(await stat(root.real)).isDirectory()) throw new Error('A configured workspace root is not a directory.');
  }
  const unique = roots.filter((root, index) => roots.findIndex((candidate) => candidate.real === root.real) === index);
  return new Workspace(unique, options.allowWrite ?? false);
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export class Workspace {
  constructor(readonly roots: WorkspaceRoot[], readonly allowWrite: boolean) {}

  private requested(rootIndex: number, path: string): { root: WorkspaceRoot; target: string } {
    const root = this.roots[rootIndex];
    if (!root) throw new Error(`Unknown root index ${rootIndex}. Configure a root when starting carve-mcp.`);
    if (isAbsolute(path)) throw new Error('Workspace paths must be relative.');
    const target = resolve(root.real, path);
    if (!inside(root.real, target)) throw new Error('Path escapes the configured workspace root.');
    const segments = path.split(/[\\/]/);
    if (segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')) {
      throw new Error('Hidden paths and dependency directories are not readable workspace documents.');
    }
    if (!['.crv', '.carve', '.md', '.markdown', '.txt', '.html', '.htm', '.djot'].includes(extname(path).toLowerCase())) {
      throw new Error('Unsupported document extension.');
    }
    return { root, target };
  }

  async read(rootIndex: number, path: string) {
    const { root, target } = this.requested(rootIndex, path);
    let canonical: string;
    try { canonical = await realpath(target); }
    catch { throw new Error(`Workspace file not found: ${path}`); }
    if (!inside(root.real, canonical)) throw new Error('Resolved path escapes the configured workspace root.');
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error('Path is not a regular file.');
    if (info.size > MAX_SOURCE_BYTES) throw new Error(`File exceeds the ${MAX_SOURCE_BYTES}-byte limit.`);
    const bytes = await readFile(canonical);
    if (bytes.includes(0)) throw new Error('Binary files are not supported.');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`Workspace file is not valid UTF-8: ${path}`); }
    return { rootIndex, path, content, sha256: sha256(bytes), bytes: bytes.length };
  }

  async write(rootIndex: number, path: string, content: string, expectedSha256?: string, dryRun = true) {
    if (!this.allowWrite) throw new Error('Workspace writes are disabled. Start carve-mcp with --allow-write to enable them.');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SOURCE_BYTES) throw new Error(`Content exceeds the ${MAX_SOURCE_BYTES}-byte limit.`);
    const { root, target } = this.requested(rootIndex, path);
    const parent = await realpath(dirname(target));
    if (!inside(root.real, parent)) throw new Error('Resolved parent escapes the configured workspace root.');

    let currentSha256: string | null = null;
    let currentMode = 0o600;
    try {
      const canonical = await realpath(target);
      if (!inside(root.real, canonical)) throw new Error('Resolved path escapes the configured workspace root.');
      const currentInfo = await stat(canonical);
      if (!currentInfo.isFile()) throw new Error(`Workspace path is not a regular file: ${path}`);
      currentMode = currentInfo.mode & 0o7777;
      const current = await readFile(canonical);
      currentSha256 = createHash('sha256').update(current).digest('hex');
      if (!dryRun && !expectedSha256) throw new Error('expectedSha256 is required when overwriting a file.');
      if (expectedSha256 && expectedSha256 !== currentSha256) throw new Error('File changed since it was read; expectedSha256 does not match.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (expectedSha256) throw new Error('File no longer exists; expectedSha256 cannot be satisfied.');
    }

    const nextSha256 = sha256(content);
    if (!dryRun) {
      const temporary = resolve(parent, `.${randomUUID()}.carve-mcp.tmp`);
      try {
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await chmod(temporary, currentMode);
        if (currentSha256 !== null) {
          const latest = await readFile(target);
          if (sha256(latest) !== currentSha256) throw new Error('File changed during the write; refusing to replace it.');
        }
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    }
    return { rootIndex, path, dryRun, created: currentSha256 === null, currentSha256, sha256: nextSha256, bytes };
  }
}
