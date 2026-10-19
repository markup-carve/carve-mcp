import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import { format } from './tools.js';

// Copied from markup-carve/carve resources/spec/table-alignment-fixtures.json (4cb3b4cb).
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/table-alignment-fixtures.json', import.meta.url), 'utf8')) as Array<{ name: string; canonical: string; aligned: string }>;

// The pinned carve-js 0.1.12 measures a `\ ` escape at its source width, which
// the spec later ruled against. `it.fails` turns red once the engine bump fixes
// them, so the list cannot outlive the gap.
const PENDING_ENGINE = new Set([
  'non-breaking space escape',
  'two non-breaking space escapes',
  'escape in a header cell beside an inline marker',
  'escape on a continuation line',
]);

describe('carve_format alignTables', () => {
  for (const fixture of fixtures) {
    const run = PENDING_ENGINE.has(fixture.name) ? it.fails : it;
    run(`aligns: ${fixture.name}`, () => {
      expect(format(fixture.canonical, { alignTables: true }).value).toBe(fixture.aligned);
    });
    it(`canonicalizes: ${fixture.name}`, () => {
      expect(format(fixture.aligned).value).toBe(fixture.canonical);
    });
  }

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
