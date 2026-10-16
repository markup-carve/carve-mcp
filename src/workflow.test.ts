import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import { render } from './tools.js';
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

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
    const strictReview = await client.callTool({ name: 'carve_review_workspace', arguments: { rootIndex: 0, strict: true } });
    expect(strictReview.structuredContent).toMatchObject({
      checks: { localLint: true, localLinks: true, anchors: true, includes: true, complete: true },
      filesRead: ['docs/guide.crv', 'index.crv'],
      includeDependencies: [],
      versions: { engine: expect.any(String), mcp: version },
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
      { tool: 'carve_review_workspace', status: 'ok' },
      { tool: 'carve_prepare_workspace_edits', status: 'ok' },
      { tool: 'carve_prepare_edit', status: 'ok' },
      { tool: 'carve_write_file', status: 'ok' },
    ]);
    expect(JSON.stringify(events)).not.toContain('Guide');
  });

  it('keeps BOM bytes and link syntax through read, preview, write, and undo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-bom-'));
    const unchanged = '\uFEFF# Title\n';
    const formatted = '\uFEFF# Title\r\n\r\n\\[a](https://example.com) \\<https://example.com>   \r\n\r\n[link](https://example.com){.keep #link-id}\r\n\r\n{#next}\r\n# Next\r\n';
    await writeFile(join(root, 'unchanged.crv'), unchanged);
    await writeFile(join(root, 'formatted.crv'), formatted);
    const server = await createServer({ roots: [root], allowWrite: true });
    const client = new Client({ name: 'bom-workflow-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const review = (await client.callTool({ name: 'carve_review_workspace', arguments: { rootIndex: 0 } })).structuredContent as {
      fixPlan: { automatic: Array<{ paths: string[] }> };
    };
    expect(review.fixPlan.automatic).toEqual([expect.objectContaining({ paths: ['formatted.crv'] })]);

    for (const [path, original, changed] of [
      ['unchanged.crv', unchanged, false],
      ['formatted.crv', formatted, true],
    ] as const) {
      const args = { rootIndex: 0, path };
      const originalBytes = Buffer.from(original);
      const read = (await client.callTool({ name: 'carve_read_file', arguments: args })).structuredContent as { content: string; sha256: string; bytes: number };
      expect(read.content).toBe(original);
      expect(read.bytes).toBe(originalBytes.length);

      const preview = (await client.callTool({ name: 'carve_prepare_edit', arguments: args })).structuredContent as {
        changed: boolean; proposedContent: string; expectedSha256: string;
        patch: { sourceBytes: number; edits: Array<{ start: number; end: number; replacement: string }> };
      };
      const batch = (await client.callTool({ name: 'carve_prepare_workspace_edits', arguments: { rootIndex: 0, paths: [path], includeContent: true } })).structuredContent as {
        items: Array<{ changed: boolean; patch: { sourceBytes: number; edits: unknown[] } }>;
      };
      expect(preview.changed).toBe(changed);
      expect(batch.items[0]).toMatchObject({ changed, patch: preview.patch });
      expect(preview.patch.sourceBytes).toBe(originalBytes.length);
      expect(preview.expectedSha256).toBe(read.sha256);
      expect(await readFile(join(root, path))).toEqual(originalBytes);

      const proposedBytes = Buffer.from(preview.proposedContent);
      let patched = originalBytes;
      for (const edit of [...preview.patch.edits].reverse()) {
        patched = Buffer.concat([patched.subarray(0, edit.start), Buffer.from(edit.replacement), patched.subarray(edit.end)]);
      }
      expect(patched).toEqual(proposedBytes);
      expect(proposedBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

      const dryRun = await client.callTool({ name: 'carve_write_file', arguments: { ...args, content: preview.proposedContent, expectedSha256: read.sha256 } });
      expect(dryRun.isError).not.toBe(true);
      expect(await readFile(join(root, path))).toEqual(originalBytes);
      const written = await client.callTool({ name: 'carve_write_file', arguments: { ...args, content: preview.proposedContent, expectedSha256: read.sha256, dryRun: false } });
      expect(written.isError).not.toBe(true);
      expect(await readFile(join(root, path))).toEqual(proposedBytes);

      if (changed) {
        expect(preview.proposedContent).toContain('\\[a](https://example.com) \\<https://example.com>');
        expect(preview.proposedContent).toContain('[link](https://example.com){.keep #link-id}');
        const html = render(preview.proposedContent, 'html').value;
        expect(html).toContain('[a](https://example.com) &lt;https://example.com&gt;');
        expect(html).toContain('class="keep" id="link-id"');
        expect(html).toContain('id="next"');
      }

      const writtenHash = (written.structuredContent as { sha256: string }).sha256;
      const undone = await client.callTool({ name: 'carve_write_file', arguments: { ...args, content: original, expectedSha256: writtenHash, dryRun: false } });
      expect(undone.isError).not.toBe(true);
      expect(await readFile(join(root, path))).toEqual(originalBytes);
    }
  });
});
