import { describe, expect, it } from 'vitest';
import { SafeMetrics } from './telemetry.js';
import { createServer } from './server.js';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

describe('privacy-safe metrics', () => {
  it('aggregates only bounded operation metadata', () => {
    const metrics = new SafeMetrics();
    metrics.observe({ tool: 'carve_lint', status: 'ok', durationMs: 7 });
    metrics.observe({ tool: 'carve_lint', status: 'error', durationMs: 3 });
    const output = metrics.prometheus();
    expect(output).toContain('carve_mcp_tool_calls_total{tool="carve_lint"} 2');
    expect(output).toContain('carve_mcp_tool_errors_total{tool="carve_lint"} 1');
    expect(output).not.toContain('source');
  });

  it('does not let a broken observer fail a tool call', async () => {
    const server = await createServer(undefined, () => { throw new Error('observer failed'); });
    const client = new Client({ name: 'telemetry-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'carve_lint', arguments: { source: '# Fine' } });
    expect(result.isError).not.toBe(true);
    await Promise.all([client.close(), server.close()]);
  });
});
