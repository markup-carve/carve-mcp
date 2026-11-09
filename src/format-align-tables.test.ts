import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import { format } from './tools.js';

// Copied from markup-carve/carve resources/spec/table-alignment-fixtures.json (3d7a9fff).
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/table-alignment-fixtures.json', import.meta.url), 'utf8')) as Array<{ name: string; note?: string; canonical: string; aligned: string }>;

describe('carve_format alignTables', () => {
  // A roundtrip row keeps its GFM separator only under --roundtrip; carve_format
  // writes native |= header cells instead (CARVE-P11-066).
  for (const fixture of fixtures.filter(({ note }) => !note?.startsWith('Roundtrip row'))) {
    it(`aligns: ${fixture.name}`, () => {
      expect(format(fixture.canonical, { alignTables: true }).value).toBe(fixture.aligned);
    });
    it(`canonicalizes: ${fixture.name}`, () => {
      expect(format(fixture.aligned).value).toBe(fixture.canonical);
    });
  }

  it('writes native header cells for an authored separator row', () => {
    expect(format('| A | B |\n|:--|--:|\n| x | right |\n').value).toBe('|={<} A |={>} B |\n| x | right |\n');
    expect(format('| A | B |\n|---|---|\n| x | yy |\n', { alignTables: true }).value).toBe('|= A |= B |\n| x  | yy |\n');
  });

  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => Promise.all(closeables.splice(0).map((item) => item.close())));

  it('is an optional tool argument that defaults to the canonical form', async () => {
    const server = await createServer();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tool = (await client.listTools()).tools.find(({ name }) => name === 'carve_format');
    expect(tool?.inputSchema.properties).toHaveProperty('alignTables', expect.objectContaining({ type: 'boolean', default: false }));
    expect(tool?.inputSchema.required).toEqual(['source']);

    const source = '| a | bb |\n| ccc | d |\n';
    const aligned = await client.callTool({ name: 'carve_format', arguments: { source, alignTables: true } });
    expect(aligned.isError).not.toBe(true);
    expect(aligned.structuredContent).toEqual(expect.objectContaining({ value: '| a   | bb |\n| ccc | d  |\n' }));
    const canonical = await client.callTool({ name: 'carve_format', arguments: { source } });
    expect(canonical.structuredContent).toEqual(expect.objectContaining({ value: source }));
  });
});
