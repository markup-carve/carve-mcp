import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectConfiguration } from './config.js';

describe('project configuration', () => {
  it('resolves roots beside the file and validates review defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'carve-mcp-config-'));
    const path = join(directory, 'carve-mcp.json');
    await writeFile(path, JSON.stringify({ roots: ['docs'], review: { platforms: ['github'], exclude: ['archive'], checkAnchors: false } }));
    await expect(loadProjectConfiguration(path)).resolves.toEqual({
      roots: [join(directory, 'docs')],
      review: { platforms: ['github'], exclude: ['archive'], checkAnchors: false, checkLinks: undefined, maxDepth: undefined, limit: undefined },
    });
  });

  it('rejects unknown and unsafe values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'carve-mcp-config-'));
    const path = join(directory, 'bad.json');
    await writeFile(path, JSON.stringify({ roots: ['../outside'], surprise: true }));
    await expect(loadProjectConfiguration(path)).rejects.toThrow(/Unknown/);
  });
});
