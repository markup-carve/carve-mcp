import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const binary = process.argv[2];
if (!binary) throw new Error('Usage: node scripts/release-binary-smoke.mjs <binary>');
const command = resolve(binary);
await access(command);

const client = new Client({ name: 'release-binary-smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command, stderr: 'pipe' }));
try {
  const tools = await client.listTools();
  const names = tools.tools.map(({ name }) => name).sort();
  const expected = ['carve_format', 'carve_lint', 'carve_migrate', 'carve_parse', 'carve_render'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tool contract: ${names.join(', ')}`);
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
