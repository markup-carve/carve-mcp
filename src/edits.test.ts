import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareWorkspaceEdits, unifiedDiff } from './edits.js';
import { prepareWorkspace } from './workspace.js';

describe('edit previews', () => {
  it('returns a compact unified diff with context', () => {
    const diff = unifiedDiff('doc.crv', '# Title\n\nBefore   \nEnd', '# Title\n\nBefore\nEnd');
    expect(diff).toEqual({
      value: '--- a/doc.crv\n+++ b/doc.crv\n@@ -1,4 +1,4 @@\n # Title\n \n-Before   \n+Before\n End\n\\ No newline at end of file\n',
      truncated: false,
    });
  });

  it('keeps truncated UTF-8 diffs valid', () => {
    const diff = unifiedDiff('doc.crv', 'ä'.repeat(20), 'changed', 48);
    expect(diff.truncated).toBe(true);
    expect(diff.value).not.toContain('�');
    expect(Buffer.byteLength(diff.value.split('\n... diff truncated ...')[0]!)).toBeLessThanOrEqual(48);
  });

  it('prepares deterministic hash-guarded batch proposals without writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-batch-'));
    await writeFile(join(root, 'b.crv'), '# B   ');
    await writeFile(join(root, 'a.crv'), '# A');
    const workspace = await prepareWorkspace({ roots: [root] });
    const preview = await prepareWorkspaceEdits(workspace, 0, { paths: ['b.crv', 'a.crv', 'b.crv'] });
    expect(preview).toMatchObject({ filesDiscovered: 2, filesPrepared: 2, filesChanged: 2, errorCount: 0 });
    expect(preview.items.map(({ path }) => path)).toEqual(['a.crv', 'b.crv']);
    expect(preview.items[1]).toMatchObject({ status: 'ready', mode: 'automatic-format', changed: true,
      expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/), unifiedDiff: expect.stringContaining('-# B   ') });
    expect(preview.items[1]).not.toHaveProperty('proposedContent');
    expect(await readFile(join(root, 'b.crv'), 'utf8')).toBe('# B   ');
    await expect(prepareWorkspaceEdits(workspace, 0, { paths: ['notes.md'] })).rejects.toThrow(/\.crv/);
  });
});
