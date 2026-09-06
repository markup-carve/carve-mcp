import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareWorkspace } from './workspace.js';
import { reviewWorkspace } from './project.js';

describe('workspace operations', () => {
  it('reads and atomically writes with dry runs and stale-write protection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-'));
    await writeFile(join(root, 'doc.crv'), '# Old');
    const workspace = await prepareWorkspace({ roots: [root], allowWrite: true });
    const read = await workspace.read(0, 'doc.crv');
    expect(read.content).toBe('# Old');
    expect((await workspace.write(0, 'doc.crv', '# New', read.sha256, true)).dryRun).toBe(true);
    expect(await readFile(join(root, 'doc.crv'), 'utf8')).toBe('# Old');
    await workspace.write(0, 'doc.crv', '# New', read.sha256, false);
    await expect(workspace.write(0, 'doc.crv', '# Stale', read.sha256, false)).rejects.toThrow(/changed/);
  });

  it('rejects traversal, symlink escapes, binary data, and disabled writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-'));
    const outside = await mkdtemp(join(tmpdir(), 'carve-mcp-outside-'));
    await writeFile(join(outside, 'secret.crv'), 'secret');
    await symlink(join(outside, 'secret.crv'), join(root, 'link.crv'));
    await writeFile(join(root, 'binary.crv'), Buffer.from([0, 1]));
    await mkdir(join(root, 'vendor'));
    await writeFile(join(root, 'vendor', 'dependency.crv'), '# Dependency');
    const workspace = await prepareWorkspace({ roots: [root] });
    await expect(workspace.read(0, '../secret.crv')).rejects.toThrow(/escapes/);
    await expect(workspace.read(0, 'link.crv')).rejects.toThrow(/escapes/);
    await expect(workspace.read(0, 'binary.crv')).rejects.toThrow(/Binary/);
    await expect(workspace.read(0, 'vendor/dependency.crv')).rejects.toThrow(/dependency/);
    await expect(workspace.write(0, 'new.crv', '# New')).rejects.toThrow(/disabled/);
  });

  it('discovers bounded documents and reviews Carve and local links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-'));
    await mkdir(join(root, 'docs'));
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'index.crv'), '# Home\n\n[good](docs/guide.crv#Guide)\n[bad](docs/missing.crv)\n[anchor](docs/guide.crv#Missing)\n[binary](notes.txt)\n\n```md\n[example](not-real.crv)\n```');
    await writeFile(join(root, 'docs', 'guide.crv'), '# Guide');
    await writeFile(join(root, 'notes.txt'), Buffer.from([0, 1]));
    await writeFile(join(root, '.hidden', 'secret.crv'), '# Secret');
    const workspace = await prepareWorkspace({ roots: [root] });
    expect(await workspace.list(0)).toMatchObject({ files: ['docs/guide.crv', 'index.crv', 'notes.txt'], truncated: false });
    const review = await reviewWorkspace(workspace, 0);
    expect(review.filesChecked).toBe(2);
    expect(review.projectWarnings.map((warning) => warning.rule)).toEqual(['missing-local-file', 'broken-local-anchor', 'unreadable-document']);
  });

  it('can disable project link checks without disabling Carve linting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-'));
    await writeFile(join(root, 'index.crv'), '[missing](gone.crv)\n:::');
    const workspace = await prepareWorkspace({ roots: [root] });
    const review = await reviewWorkspace(workspace, 0, { checkLinks: false });
    expect(review.files[0].warningCount).toBeGreaterThan(0);
    expect(review.projectWarnings).toEqual([]);
  });

  it('applies review exclusions and can disable only anchor checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-'));
    await mkdir(join(root, 'archive'));
    await writeFile(join(root, 'index.crv'), '[missing](gone.crv)\n[anchor](guide.crv#Gone)');
    await writeFile(join(root, 'guide.crv'), '# Guide');
    await writeFile(join(root, 'archive', 'old.crv'), '# Old');
    const workspace = await prepareWorkspace({ roots: [root], review: { exclude: ['archive'] } });
    expect((await workspace.list(0)).files).toEqual(['guide.crv', 'index.crv']);
    const review = await reviewWorkspace(workspace, 0, { checkAnchors: false });
    expect(review.projectWarnings.map(({ rule }) => rule)).toEqual(['missing-local-file']);
  });
});
