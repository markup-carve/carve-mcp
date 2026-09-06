export interface ToolEvent { tool: string; status: 'ok' | 'error'; durationMs: number }
export type ToolObserver = (event: ToolEvent) => void;

export class SafeMetrics {
  private readonly values = new Map<string, { calls: number; errors: number; durationMs: number }>();

  observe({ tool, status, durationMs }: ToolEvent): void {
    const value = this.values.get(tool) ?? { calls: 0, errors: 0, durationMs: 0 };
    value.calls += 1;
    value.errors += status === 'error' ? 1 : 0;
    value.durationMs += durationMs;
    this.values.set(tool, value);
  }

  prometheus(): string {
    const lines = [
      '# HELP carve_mcp_tool_calls_total Completed MCP tool calls.',
      '# TYPE carve_mcp_tool_calls_total counter',
    ];
    for (const [tool, value] of [...this.values].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`carve_mcp_tool_calls_total{tool="${tool}"} ${value.calls}`);
      lines.push(`carve_mcp_tool_errors_total{tool="${tool}"} ${value.errors}`);
      lines.push(`carve_mcp_tool_duration_milliseconds_total{tool="${tool}"} ${value.durationMs}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
