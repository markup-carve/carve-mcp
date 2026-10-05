import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Text } from './blocks.js';
import { createServer } from './server.js';
import { replaceSource, SourceEditRefusal } from './splice.js';

function applyPatch(source: string, patch: { edits: Array<{ start: number; end: number; replacement: string }> }): string {
  const bytes = Buffer.from(source, 'utf8');
  const [edit] = patch.edits;
  return Buffer.concat([bytes.subarray(0, edit!.start), Buffer.from(edit!.replacement, 'utf8'), bytes.subarray(edit!.end)]).toString('utf8');
}

function refusal(run: () => unknown): SourceEditRefusal {
  try { run(); }
  catch (error) { if (error instanceof SourceEditRefusal) return error; throw error; }
  throw new Error('expected a refusal');
}

const messy = '# Title\r\n\r\nFirst\tparagraph 😀.\r\n\r\n-   one\r\n-   two\r\n\r\n> quoted é\r\n> line\r\n\r\n::: note\r\nInside.\r\n:::\r\n\r\nLast line without newline';

describe('byte-exact source replacement', () => {
  it.each([
    ['a top-level paragraph', '/children/1', 'Changed\tpara 😀 with *style*.'],
    ['a list item paragraph', '/children/2/items/1/children/0', 'deux é'],
    ['a block quote paragraph', '/children/3/children/0', 'quoted again'],
    ['an admonition paragraph', '/children/4/children/0', 'Inside, edited.'],
    ['the last paragraph without a newline', '/children/5', 'Final 😀'],
  ])('replaces %s and leaves every other byte alone', (_label, path, text) => {
    const { output, result } = replaceSource(messy, { kind: 'ast-path', value: path }, text);
    const before = Buffer.from(messy, 'utf8');
    const after = Buffer.from(result, 'utf8');
    expect(after.subarray(0, output.start)).toEqual(before.subarray(0, output.start));
    expect(after.subarray(output.start + Buffer.byteLength(text))).toEqual(before.subarray(output.end));
    expect(after.subarray(output.start, output.start + Buffer.byteLength(text)).toString('utf8')).toBe(text);
    expect(applyPatch(messy, output.patch)).toBe(result);
    expect(applyPatch(result, output.undoPatch)).toBe(messy);
    expect(output).toMatchObject({ sha256: sha256Text(messy), resultSha256: sha256Text(result), lint: { introduced: [] } });
  });

  it('reports UTF-8 byte offsets, not code points or UTF-16 units', () => {
    const { output, result } = replaceSource('😀 é\n\nTarget', { kind: 'ast-path', value: '/children/1' }, 'Zïel');
    expect(output).toMatchObject({ start: 9, end: 15 });
    expect(output.undoPatch.edits[0]).toMatchObject({ start: 9, end: 14, replacement: 'Target' });
    expect(result).toBe('😀 é\n\nZïel');
  });

  it('replaces a heading section and keeps the next heading attribute line', () => {
    const source = '# A\n\nIntro\n\n## B\n\nOld body\n\nMore\n\n{#c}\n## C\n\nTail\n';
    const { result } = replaceSource(source, { kind: 'heading-id', value: 'B' }, '## B\n\nNew body', { scope: 'section' });
    expect(result).toBe('# A\n\nIntro\n\n## B\n\nNew body\n\n{#c}\n## C\n\nTail\n');
  });

  it('refuses a stale source, a changed node kind, and swallowed surroundings', () => {
    expect(refusal(() => replaceSource(messy, { kind: 'ast-path', value: '/children/1' }, 'x', { expectedSha256: '0'.repeat(64) })).details)
      .toMatchObject({ reason: 'stale-source', sha256: sha256Text(messy) });
    expect(refusal(() => replaceSource(messy, { kind: 'ast-path', value: '/children/1' }, '## Now a heading')).details)
      .toEqual({ reason: 'node-kind-changed', expected: 'paragraph', actual: 'heading' });
    expect(refusal(() => replaceSource(messy, { kind: 'ast-path', value: '/children/1' }, 'Para\n\n```')).details)
      .toMatchObject({ reason: 'surroundings-changed', nodeType: 'list' });
  });

  it('refuses an inline edit that splits its paragraph, but allows a trailing line break at a block end', () => {
    expect(refusal(() => replaceSource('*bold* tail', { kind: 'ast-path', value: '/children/0/children/0' }, '*new*\n\n')).details)
      .toMatchObject({ reason: 'surroundings-changed', nodeType: 'paragraph' });
    expect(refusal(() => replaceSource('*bold* tail', { kind: 'ast-path', value: '/children/0/children/0' }, '*new* `')).details)
      .toMatchObject({ reason: 'surroundings-changed', nodeType: 'text' });
    expect(replaceSource('*bold* tail', { kind: 'ast-path', value: '/children/0/children/0' }, '*new*').result).toBe('*new* tail');
    expect(refusal(() => replaceSource('*bold*\n\nTail', { kind: 'ast-path', value: '/children/0/children/0' }, '*new*\n\nExtra')).details)
      .toMatchObject({ reason: 'surroundings-changed', nodeType: 'paragraph' });
    expect(refusal(() => replaceSource('- a\n- b', { kind: 'ast-path', value: '/children/0/items/0/children/0' }, 'a2\n')).details)
      .toMatchObject({ reason: 'surroundings-changed', nodeType: 'list' });
    expect(refusal(() => replaceSource('Old\n\n# Next', { kind: 'ast-path', value: '/children/0' }, 'New\n\n{#changed}')).details)
      .toMatchObject({ reason: 'surroundings-changed', nodeType: 'heading' });
    expect(replaceSource('- a\n- b\n\nAfter\n', { kind: 'ast-path', value: '/children/0/items/1/children/0' }, 'b2\n').result).toBe('- a\n- b2\n\n\nAfter\n');
  });

  it('refuses new lint findings but tolerates ones that were already there', () => {
    expect(refusal(() => replaceSource('Text[^a]\n\n[^a]: Note\n', { kind: 'ast-path', value: '/children/0' }, 'No reference')).details)
      .toMatchObject({ reason: 'new-lint-findings', introduced: [{ rule: 'unused-footnote-definition', line: 3 }] });
    expect(replaceSource(':::\nBody', { kind: 'node-type', value: 'paragraph' }, 'Changed').output.lint).toEqual({ introduced: [], resolved: [] });
    const fixed = replaceSource('See </#gone>.\n\n# Here', { kind: 'ast-path', value: '/children/0' }, 'See </#Here>.');
    expect(fixed.output.lint.resolved).toEqual([expect.objectContaining({ rule: expect.any(String), line: 1 })]);
  });

  it('refuses ambiguous selectors and no-op replacements', () => {
    expect(() => replaceSource(messy, { kind: 'node-type', value: 'paragraph' }, 'x')).toThrow(/matched 6 AST nodes/);
    expect(() => replaceSource(messy, { kind: 'ast-path', value: '/children/5' }, 'Last line without newline')).toThrow(/nothing would change/);
  });
});

describe('carve_replace_source over MCP', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => Promise.all(closeables.splice(0).map((item) => item.close())));

  async function connect(options?: { roots: string[]; allowWrite?: boolean }) {
    const server = await createServer(options);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('writes through the guarded path and undoes with the original bytes, BOM included', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-'));
    const content = '﻿# Title\r\n\r\n{#p}\r\nOld 😀 text\r\n';
    await writeFile(join(root, 'doc.crv'), content);
    const client = await connect({ roots: [root], allowWrite: true });
    const block = (await client.callTool({ name: 'carve_get_block', arguments: { rootIndex: 0, path: 'doc.crv', selector: { kind: 'id', value: 'p' } } })).structuredContent as { sha256: string; blocks: Array<{ source: string }> };
    const missingHash = await client.callTool({ name: 'carve_replace_source', arguments: { rootIndex: 0, path: 'doc.crv', selector: { kind: 'id', value: 'p' }, text: 'New', dryRun: false } });
    expect(missingHash).toMatchObject({ isError: true, structuredContent: { error: expect.stringMatching(/expectedSha256 is required/) } });
    const preview = await client.callTool({ name: 'carve_replace_source', arguments: { rootIndex: 0, path: 'doc.crv', selector: { kind: 'id', value: 'p' }, text: 'New é text' } });
    expect(preview.content).toEqual([{ type: 'text', text: 'Prepared a byte-exact replacement for the paragraph source; no file was changed.' }]);
    expect(await readFile(join(root, 'doc.crv'), 'utf8')).toBe(content);
    const written = await client.callTool({ name: 'carve_replace_source', arguments: { rootIndex: 0, path: 'doc.crv', selector: { kind: 'id', value: 'p' }, text: 'New é text', expectedSha256: block.sha256, dryRun: false } });
    expect(written.content).toEqual([{ type: 'text', text: 'Replaced the paragraph source and wrote the file.' }]);
    const after = await readFile(join(root, 'doc.crv'));
    expect(after.toString('utf8')).toBe('﻿# Title\r\n\r\n{#p}\r\nNew é text\r\n');
    const result = written.structuredContent as { resultSha256: string; write: { sha256: string } };
    expect(result.write.sha256).toBe(result.resultSha256);
    const stale = await client.callTool({ name: 'carve_replace_source', arguments: { rootIndex: 0, path: 'doc.crv', selector: { kind: 'id', value: 'p' }, text: 'Again', expectedSha256: block.sha256, dryRun: false } });
    expect(stale).toMatchObject({ isError: true, structuredContent: { reason: 'stale-source' } });
    await client.callTool({ name: 'carve_replace_source', arguments: { rootIndex: 0, path: 'doc.crv', selector: { kind: 'id', value: 'p' }, text: block.blocks[0]!.source, expectedSha256: result.resultSha256, dryRun: false } });
    expect(await readFile(join(root, 'doc.crv'), 'utf8')).toBe(content);
  });

  it('offers dryRun and the destructive annotation only when writes are allowed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-'));
    const cases: Array<[{ roots: string[]; allowWrite?: boolean } | undefined, boolean]> = [[undefined, false], [{ roots: [root] }, false], [{ roots: [root], allowWrite: true }, true]];
    for (const [options, writes] of cases) {
      const client = await connect(options);
      const tool = (await client.listTools()).tools.find(({ name }) => name === 'carve_replace_source')!;
      expect(Object.keys(tool.inputSchema.properties ?? {}).includes('dryRun')).toBe(writes);
      expect(tool.annotations?.readOnlyHint).toBe(!writes);
    }
  });
});
