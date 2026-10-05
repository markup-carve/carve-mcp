import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { getBlocks, sha256Text } from './blocks.js';
import { createServer } from './server.js';

const crlf = '# Héllo 😀\r\n\r\nPära 😀 one\r\n\r\n{#steps}\r\n-   item 😀\r\n-   two\r\n\r\n## Sub\r\n\r\nx\r\n\r\n{#next}\r\n# Next\r\n\r\ntail';

function bytesOf(source: string, start: number, end: number): string {
  return Buffer.from(source, 'utf8').subarray(start, end).toString('utf8');
}

describe('source blocks', () => {
  it('reports UTF-8 byte ranges that slice the exact source text', () => {
    const result = getBlocks(crlf, { kind: 'node-type', value: 'paragraph' });
    expect(result.sha256).toBe(sha256Text(crlf));
    expect(result.sourceBytes).toBe(Buffer.byteLength(crlf));
    expect(result.blocks.map(({ source }) => source)).toEqual(['Pära 😀 one', 'item 😀', 'two', 'x', 'tail']);
    for (const block of result.blocks) expect(bytesOf(crlf, block.start, block.end)).toBe(block.source);
    expect(result.blocks[0]).toMatchObject({ start: 17, end: 31, startLine: 3, endLine: 3 });
    expect(result.blocks[0]).not.toHaveProperty('node');
  });

  it('keeps the author spacing and leaves the attribute line outside the node', () => {
    const [list] = getBlocks(crlf, { kind: 'id', value: 'steps' }).blocks;
    expect(list).toMatchObject({ type: 'list', identity: 'steps', source: '-   item 😀\r\n-   two' });
  });

  it('extends a heading to its section, stopping before the next peer heading', () => {
    const [section] = getBlocks(crlf, { kind: 'heading-id', value: 'Héllo-😀' }, { scope: 'section' }).blocks;
    expect(section!.source).toBe('# Héllo 😀\r\n\r\nPära 😀 one\r\n\r\n{#steps}\r\n-   item 😀\r\n-   two\r\n\r\n## Sub\r\n\r\nx');
    expect(section).toMatchObject({ startLine: 1, endLine: 11 });
    const [last] = getBlocks(crlf, { kind: 'id', value: 'next' }, { scope: 'section' }).blocks;
    expect(last!.source).toBe('# Next\r\n\r\ntail');
  });

  it('bounds a section to the container holding the heading', () => {
    const source = '::: note\n# Inner\n\nInside\n:::\n\nOutside\n';
    const [section] = getBlocks(source, { kind: 'heading-id', value: 'Inner' }, { scope: 'section' }).blocks;
    expect(section!.source).toBe('# Inner\n\nInside');
  });

  it('refuses a section on anything but a heading and returns the AST only on request', () => {
    expect(() => getBlocks(crlf, { kind: 'id', value: 'steps' }, { scope: 'section' })).toThrow(/requires a heading/);
    const [block] = getBlocks(crlf, { kind: 'id', value: 'steps' }, { includeAst: true }).blocks;
    expect(block).toMatchObject({ node: { type: 'list' } });
    expect(getBlocks(crlf, { kind: 'id', value: 'missing' })).toMatchObject({ matchCount: 0, blocks: [] });
  });

  it('reads a section among very many sibling headings', () => {
    const source = '# A\n\n'.repeat(130_000);
    const result = getBlocks(source, { kind: 'ast-path', value: '/children/1' }, { scope: 'section' });
    expect(result.blocks[0]).toMatchObject({ source: '# A', start: 5, end: 8 });
  }, 30_000);

  it('counts a leading BOM in the offsets', () => {
    const source = '﻿# A\n\nB';
    const [block] = getBlocks(source, { kind: 'node-type', value: 'paragraph' }).blocks;
    expect(block).toMatchObject({ start: 8, end: 9, source: 'B' });
  });
});

describe('document tools on workspace files', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => Promise.all(closeables.splice(0).map((item) => item.close())));

  async function connect(roots?: string[]) {
    const server = await createServer(roots ? { roots } : undefined);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('reads a block by path, keeping the file hash and a leading BOM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-'));
    const content = '﻿# Title\r\n\r\nFirst 😀\r\n';
    await writeFile(join(root, 'doc.crv'), content);
    await writeFile(join(root, 'doc.md'), content);
    const client = await connect([root]);
    const called = await client.callTool({ name: 'carve_get_block', arguments: { rootIndex: 0, path: 'doc.crv', selector: { kind: 'node-type', value: 'paragraph' } } });
    expect(called.content).toEqual([{ type: 'text', text: 'Found 1 matching block.' }]);
    expect(called.structuredContent).toMatchObject({ sha256: sha256Text(content), blocks: [{ source: 'First 😀', start: 14, end: 24 }] });
    const both = await client.callTool({ name: 'carve_get_block', arguments: { source: '# x', rootIndex: 0, path: 'doc.crv', selector: { kind: 'node-type', value: 'paragraph' } } });
    expect(both).toMatchObject({ isError: true, structuredContent: { error: expect.stringMatching(/not both/) } });
    const markdown = await client.callTool({ name: 'carve_get_block', arguments: { rootIndex: 0, path: 'doc.md', selector: { kind: 'node-type', value: 'paragraph' } } });
    expect(markdown).toMatchObject({ isError: true, structuredContent: { error: expect.stringMatching(/\.crv or \.carve/) } });
  });

  it('plans and previews edits from a path and omits the AST unless asked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'carve-mcp-'));
    await writeFile(join(root, 'doc.crv'), '# Before\n');
    const client = await connect([root]);
    const planned = await client.callTool({ name: 'carve_plan_ast_edit', arguments: { rootIndex: 0, path: 'doc.crv', selector: { kind: 'heading-id', value: 'Before' }, edit: { kind: 'replace-text', text: 'After' } } });
    const plan = planned.structuredContent as { reversiblePatch: unknown; sha256: string };
    expect(plan.sha256).toBe(sha256Text('# Before\n'));
    const applied = await client.callTool({ name: 'carve_apply_reversible_ast_patch', arguments: { rootIndex: 0, path: 'doc.crv', patch: plan.reversiblePatch } });
    expect(applied.structuredContent).toMatchObject({ source: '{#Before}\n# After\n', sha256: plan.sha256 });
    expect(applied.structuredContent).not.toHaveProperty('ast');
    const withAst = await client.callTool({ name: 'carve_apply_reversible_ast_patch', arguments: { source: '# Before\n', patch: plan.reversiblePatch, includeAst: true } });
    expect(withAst.structuredContent).toMatchObject({ ast: { type: 'document' } });
    expect(withAst.structuredContent).not.toHaveProperty('sha256');
  });

  it('keeps source required and the path fields unadvertised without a root', async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.filter(({ name }) => ['carve_get_block', 'carve_plan_ast_edit', 'carve_apply_reversible_ast_patch'].includes(name));
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.inputSchema.required).toContain('source');
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('rootIndex');
    }
  });
});
