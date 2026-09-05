import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareWorkspace } from './workspace.js';

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
    const workspace = await prepareWorkspace({ roots: [root] });
    await expect(workspace.read(0, '../secret.crv')).rejects.toThrow(/escapes/);
    await expect(workspace.read(0, 'link.crv')).rejects.toThrow(/escapes/);
    await expect(workspace.read(0, 'binary.crv')).rejects.toThrow(/Binary/);
    await expect(workspace.write(0, 'new.crv', '# New')).rejects.toThrow(/disabled/);
  });
});
