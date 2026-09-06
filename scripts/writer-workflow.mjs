import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = mkdtempSync(join(tmpdir(), 'carve-mcp-writer-workflow-'));
mkdirSync(join(root, 'docs'));
writeFileSync(join(root, 'index.crv'), '# Home\n\n[Guide](docs/guide.crv#Missing)\n');
writeFileSync(join(root, 'docs', 'guide.crv'), '# Guide   ');
const client = new Client({ name: 'writer-workflow-check', version: '1.0.0' });

try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js', '--root', root, '--allow-write'], stderr: 'pipe' }));
  const review = await client.callTool({ name: 'carve_review_workspace', arguments: { rootIndex: 0 } });
  assert.equal(review.isError, undefined);
  assert.equal(review.structuredContent.valid, false);
  assert.ok(review.structuredContent.projectWarnings.some(({ code }) => code === 'CARVE_PROJECT_BROKEN_ANCHOR'));
  const preview = await client.callTool({ name: 'carve_prepare_edit', arguments: { rootIndex: 0, path: 'docs/guide.crv' } });
  assert.equal(readFileSync(join(root, 'docs', 'guide.crv'), 'utf8'), '# Guide   ');
  const { proposedContent, expectedSha256 } = preview.structuredContent;
  const write = await client.callTool({ name: 'carve_write_file', arguments: {
    rootIndex: 0, path: 'docs/guide.crv', content: proposedContent, expectedSha256, dryRun: false,
  } });
  assert.equal(write.isError, undefined);
  assert.equal(readFileSync(join(root, 'docs', 'guide.crv'), 'utf8'), proposedContent);
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}
