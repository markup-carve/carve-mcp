import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';

describe('MCP server', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => Promise.all(closeables.splice(0).map((item) => item.close())));

  it('advertises and invokes the core tools over MCP', async () => {
    const server = await createServer();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'carve_lint', 'carve_format', 'carve_render', 'carve_parse', 'carve_migrate',
    ]);
    expect(listed.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'carve_lint',
        title: 'Lint Carve',
        annotations: expect.objectContaining({ readOnlyHint: true, openWorldHint: false }),
        inputSchema: expect.objectContaining({ type: 'object' }),
      }),
    ]));

    const called = await client.callTool({
      name: 'carve_render',
      arguments: { source: '# Hello', target: 'html' },
    });
    expect(called.isError).not.toBe(true);
    expect(called.content).toEqual([{ type: 'text', text: 'Produced the requested output.' }]);
    expect(called.structuredContent).toEqual(expect.objectContaining({ value: expect.stringContaining('<h1') }));
    expect(listed.tools.every((tool) => tool.outputSchema?.type === 'object')).toBe(true);
  });

  it('offers a small set of writer-controlled workflows', async () => {
    const server = await createServer();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
      'review-document', 'convert-markdown', 'prepare-for-github',
      'explain-warnings', 'preview-document', 'review-workspace',
    ]);
    const prompt = await client.getPrompt({ name: 'review-document' });
    expect(prompt.messages[0].content).toMatchObject({ type: 'text', text: expect.stringContaining("preserve the author's voice") });
  });

  it('lists and reads versioned authoring resources', async () => {
    const server = await createServer();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listResources();
    expect(listed.resources.map((resource) => resource.uri)).toEqual(['carve://guide', 'carve://rules']);
    const guide = await client.readResource({ uri: 'carve://guide' });
    expect(guide.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: expect.stringContaining('quick start') });
    const rule = await client.readResource({ uri: 'carve://rules/CARVE-P0-001' });
    expect(rule.contents[0]).toMatchObject({ text: expect.stringContaining('A LEADING BYTE ORDER MARK') });
    const lintRule = await client.readResource({ uri: 'carve://lint-rules/unclosed-container-fence' });
    expect(lintRule.contents[0]).toMatchObject({ text: expect.stringContaining('without a closer') });
  });

  it('returns an MCP tool error for oversized input', async () => {
    const server = await createServer();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const called = await client.callTool({
      name: 'carve_lint', arguments: { source: 'x'.repeat(1_000_001) },
    });
    expect(called.isError).toBe(true);
  });
});
