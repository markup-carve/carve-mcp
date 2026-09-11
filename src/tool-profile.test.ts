import { describe, expect, it } from 'vitest';
import { TOOL_PROFILES, toolEnabled, toolNames } from './tool-profile.js';

describe('tool profiles', () => {
  it('keeps all as the complete backward-compatible default', () => {
    expect(TOOL_PROFILES).toEqual(['review', 'convert', 'structure', 'workspace', 'all']);
    expect(toolNames('all')).toHaveLength(21);
    expect(toolEnabled('all', 'carve_future_tool')).toBe(true);
  });
  it('exposes focused, useful capability groups', () => {
    expect(toolNames('review')).toEqual(['carve_lint', 'carve_diagnose_and_fix', 'carve_format', 'carve_render', 'carve_check_targets']);
    expect(toolNames('convert')).toEqual(['carve_lint', 'carve_render', 'carve_check_targets', 'carve_migrate']);
    expect(toolNames('structure')).toContain('carve_plan_ast_edit');
    expect(toolNames('workspace')).toContain('carve_reference_graph');
  });
});
