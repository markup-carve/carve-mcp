import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const binary = process.argv[2];
if (!binary) throw new Error('Usage: node scripts/release-binary-smoke.mjs <binary>');
const command = resolve(binary);
await access(command);
const fullContract = process.argv.includes('--full');
if (fullContract) {
  const version = execFileSync(command, ['--version'], { encoding: 'utf8' });
  if (!/^carve-mcp-rs \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s*$/.test(version)) {
    throw new Error(`Unexpected version output: ${version}`);
  }
  const expectedVersion = process.env.RELEASE_TAG?.replace(/^v/, '');
  if (expectedVersion && version.trim() !== `carve-mcp-rs ${expectedVersion}`) {
    throw new Error(`Released binary reports ${version.trim()}, expected ${expectedVersion}.`);
  }
}

const client = new Client({ name: 'release-binary-smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command, stderr: 'pipe' }));
try {
  const tools = await client.listTools();
  const names = tools.tools.map(({ name }) => name).sort();
  const expected = ['carve_format', 'carve_lint', 'carve_migrate', 'carve_parse', 'carve_render'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tool contract: ${names.join(', ')}`);
  }
  if (fullContract) {
    const resources = await client.listResources();
    if (!resources.resources.some(({ uri }) => uri === 'carve://guide')) {
      throw new Error('Released binary is missing the authoring guide resource.');
    }
    const guide = await client.readResource({ uri: 'carve://guide' });
    if (!guide.contents.some((item) => item.text?.includes('Carve authoring quick start'))) {
      throw new Error('Released binary failed an authoring guide request.');
    }
  }
  const lint = await client.callTool({ name: 'carve_lint', arguments: { source: '# Release smoke' } });
  if (lint.isError) throw new Error('Released binary failed a lint request.');
  const render = await client.callTool({
    name: 'carve_render', arguments: { source: '# Release smoke', target: 'html' },
  });
  if (render.isError || !(render.content ?? []).some((item) => item.type === 'text' && item.text.includes('Release smoke'))) {
    throw new Error('Released binary failed a render request.');
  }
} finally {
  await client.close();
}
