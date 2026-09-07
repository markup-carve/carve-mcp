import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';

describe('writer project workflow', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => Promise.all(closeables.splice(0).map((item) => item.close())));

  it('reviews a folder, previews a safe edit, and applies only the approved hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-workflow-'));
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'index.crv'), '# Home\n\nAsk @writer.\n\n[Guide](docs/guide.crv#Missing)\n[Gone](docs/gone.crv)');
    await writeFile(join(root, 'docs', 'guide.crv'), '# Guide   ');
    const events: Array<{ tool: string; status: string }> = [];
    const server = await createServer({ roots: [root], allowWrite: true, review: { platforms: ['github'] } }, (event) => events.push(event));
    const client = new Client({ name: 'workflow-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const review = await client.callTool({ name: 'carve_review_workspace', arguments: { rootIndex: 0 } });
    expect(review.structuredContent).toMatchObject({
      valid: false,
      ruleCounts: expect.objectContaining({ 'platform-mention-token': 1 }),
      summary: { bySeverity: { error: 2 }, nextActions: expect.arrayContaining([expect.stringContaining('destination')]) },
      projectWarnings: expect.arrayContaining([expect.objectContaining({ code: 'CARVE_PROJECT_BROKEN_ANCHOR', severity: 'error', suggestion: expect.any(String) })]),
      fixPlan: {
        automatic: expect.arrayContaining([expect.objectContaining({ mode: 'automatic-format', paths: expect.any(Array) })]),
        writerReview: expect.arrayContaining([expect.objectContaining({ priority: 1, severity: 'error', mode: 'writer-review' })]),
      },
    });

    const batch = await client.callTool({ name: 'carve_prepare_workspace_edits', arguments: { rootIndex: 0 } });
    expect(batch.structuredContent).toMatchObject({ filesPrepared: 2, filesChanged: 2, errorCount: 0,
      items: expect.arrayContaining([expect.objectContaining({ path: 'docs/guide.crv', unifiedDiff: expect.stringContaining('--- a/docs/guide.crv') })]) });

    const preview = await client.callTool({ name: 'carve_prepare_edit', arguments: { rootIndex: 0, path: 'docs/guide.crv' } });
    const proposal = preview.structuredContent as { proposedContent: string; expectedSha256: string };
    expect(await readFile(join(root, 'docs', 'guide.crv'), 'utf8')).toBe('# Guide   ');
    await client.callTool({ name: 'carve_write_file', arguments: {
      rootIndex: 0, path: 'docs/guide.crv', content: proposal.proposedContent,
      expectedSha256: proposal.expectedSha256, dryRun: false,
    } });
    expect(await readFile(join(root, 'docs', 'guide.crv'), 'utf8')).toBe(proposal.proposedContent);
    expect(events.map(({ tool, status }) => ({ tool, status }))).toEqual([
      { tool: 'carve_review_workspace', status: 'ok' },
      { tool: 'carve_prepare_workspace_edits', status: 'ok' },
      { tool: 'carve_prepare_edit', status: 'ok' },
      { tool: 'carve_write_file', status: 'ok' },
    ]);
    expect(JSON.stringify(events)).not.toContain('Guide');
  });
});
