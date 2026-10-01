import { describe, expect, it } from 'vitest';
import { TOOL_PROFILES, toolEnabled, toolNames } from './tool-profile.js';

describe('tool profiles', () => {
  it('keeps all as the complete backward-compatible default', () => {
    expect(TOOL_PROFILES).toEqual(['review', 'convert', 'structure', 'workspace', 'all']);
    expect(toolNames('all')).toEqual([
      'carve_lint', 'carve_diagnose_and_fix', 'carve_format', 'carve_render', 'carve_check_targets',
      'carve_parse', 'carve_create_ast_patch', 'carve_apply_ast_patch', 'carve_select_ast_nodes',
      'carve_plan_ast_edit', 'carve_create_reversible_ast_patch', 'carve_apply_reversible_ast_patch', 'carve_migrate',
      'carve_read_file', 'carve_list_files', 'carve_review_workspace', 'carve_reference_graph',
      'carve_prepare_edit', 'carve_prepare_workspace_edits', 'carve_workspace_info', 'carve_write_file',
    ]);
    expect(toolEnabled('all', 'carve_future_tool')).toBe(true);
  });
  it('exposes focused, useful capability groups', () => {
    expect(toolNames('review')).toEqual(['carve_lint', 'carve_diagnose_and_fix', 'carve_format', 'carve_render', 'carve_check_targets']);
    expect(toolNames('convert')).toEqual(['carve_lint', 'carve_render', 'carve_check_targets', 'carve_migrate']);
    expect(toolNames('structure')).toEqual([
      'carve_lint', 'carve_parse', 'carve_create_ast_patch', 'carve_apply_ast_patch',
      'carve_select_ast_nodes', 'carve_plan_ast_edit', 'carve_create_reversible_ast_patch', 'carve_apply_reversible_ast_patch',
    ]);
    expect(toolNames('workspace')).toEqual([
      'carve_read_file', 'carve_list_files', 'carve_review_workspace', 'carve_reference_graph',
      'carve_prepare_edit', 'carve_prepare_workspace_edits', 'carve_workspace_info', 'carve_write_file',
      'carve_lint', 'carve_diagnose_and_fix', 'carve_format', 'carve_render', 'carve_check_targets',
    ]);
  });
});
