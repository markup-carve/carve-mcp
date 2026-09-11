export const TOOL_PROFILES = ['review', 'convert', 'structure', 'workspace', 'all'] as const;
export type ToolProfile = typeof TOOL_PROFILES[number];

const DOCUMENT_TOOLS = [
  'carve_lint', 'carve_diagnose_and_fix', 'carve_format', 'carve_render',
  'carve_check_targets', 'carve_parse', 'carve_create_ast_patch',
  'carve_apply_ast_patch', 'carve_select_ast_nodes', 'carve_plan_ast_edit',
  'carve_create_reversible_ast_patch', 'carve_apply_reversible_ast_patch',
  'carve_migrate',
] as const;

const WORKSPACE_TOOLS = [
  'carve_read_file', 'carve_list_files', 'carve_review_workspace',
  'carve_reference_graph', 'carve_prepare_edit',
  'carve_prepare_workspace_edits', 'carve_workspace_info', 'carve_write_file',
] as const;

const PROFILE_TOOLS: Record<ToolProfile, ReadonlySet<string>> = {
  review: new Set(['carve_lint', 'carve_diagnose_and_fix', 'carve_format', 'carve_render', 'carve_check_targets']),
  convert: new Set(['carve_lint', 'carve_render', 'carve_check_targets', 'carve_migrate']),
  structure: new Set(['carve_lint', 'carve_parse', 'carve_create_ast_patch', 'carve_apply_ast_patch',
    'carve_select_ast_nodes', 'carve_plan_ast_edit', 'carve_create_reversible_ast_patch', 'carve_apply_reversible_ast_patch']),
  workspace: new Set([...WORKSPACE_TOOLS, 'carve_lint', 'carve_diagnose_and_fix', 'carve_format', 'carve_render', 'carve_check_targets']),
  all: new Set([...DOCUMENT_TOOLS, ...WORKSPACE_TOOLS]),
};

export function parseToolProfile(value: string): ToolProfile {
  if (!TOOL_PROFILES.includes(value as ToolProfile)) {
    throw new Error(`Tool profile must be one of: ${TOOL_PROFILES.join(', ')}.`);
  }
  return value as ToolProfile;
}

export function toolEnabled(profile: ToolProfile, name: string): boolean {
  if (profile === 'all') return true;
  return PROFILE_TOOLS[profile].has(name);
}

export function toolNames(profile: ToolProfile): string[] {
  return [...PROFILE_TOOLS[profile]];
}
