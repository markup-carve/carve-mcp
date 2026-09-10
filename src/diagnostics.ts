import type { LintPlatform } from '@markup-carve/carve';
import { lint } from './tools.js';
import { createSourcePatch } from './source-patch.js';

type Warning = ReturnType<typeof lint>['warnings'][number];

function automaticEdit(source: string, warning: Warning, unclosedCount: number) {
  const start = Buffer.byteLength(source.slice(0, warning.start));
  const end = Buffer.byteLength(source.slice(0, warning.end));
  if (warning.rule === 'bidi-control-in-source') {
    return { start, end, replacement: '', kind: 'quick-fix' as const, code: warning.rule };
  }
  if (warning.rule === 'unclosed-container-fence' && unclosedCount === 1) {
    const marker = source.slice(warning.start).match(/^:+/)?.[0];
    if (!marker) return null;
    const prefix = source.endsWith('\n') ? '' : '\n';
    return { start: Buffer.byteLength(source), end: Buffer.byteLength(source), replacement: `${prefix}${marker}\n`, kind: 'quick-fix' as const, code: warning.rule };
  }
  return null;
}

function applyEdits(source: string, edits: Array<{ start: number; end: number; replacement: string }>): string {
  let bytes = Buffer.from(source);
  const ordered = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
  for (let index = 0; index < ordered.length; index += 1) {
    const edit = ordered[index]!;
    const next = ordered[index + 1];
    if (edit.start < 0 || edit.end < edit.start || edit.end > bytes.length) throw new Error('Quick-fix range is outside the source.');
    if (next && next.end > edit.start) throw new Error('Selected quick fixes overlap.');
    bytes = Buffer.concat([bytes.subarray(0, edit.start), Buffer.from(edit.replacement), bytes.subarray(edit.end)]);
  }
  return bytes.toString('utf8');
}

export function diagnoseAndFix(source: string, platforms: LintPlatform[] = [], applyFixIds: string[] = []) {
  if (applyFixIds.length > 100) throw new Error('applyFixIds must contain at most 100 items.');
  const diagnosed = lint(source, platforms);
  const unclosedCount = diagnosed.warnings.filter(({ rule }) => rule === 'unclosed-container-fence').length;
  const fixes = diagnosed.warnings.map((warning, index) => {
    const id = `${warning.rule}:${warning.start}:${warning.end}:${index}`;
    const edit = automaticEdit(source, warning, unclosedCount);
    return {
      id,
      rule: warning.rule,
      message: warning.message,
      applicability: edit ? 'automatic' as const : 'writer-review' as const,
      edit,
    };
  });
  const requested = new Set(applyFixIds);
  const unknown = [...requested].filter((id) => !fixes.some((fix) => fix.id === id));
  if (unknown.length) throw new Error(`Unknown fix id: ${unknown[0]}`);
  const selected = fixes.filter((fix) => requested.has(fix.id));
  const unavailable = selected.find((fix) => !fix.edit);
  if (unavailable) throw new Error(`Fix ${unavailable.id} requires writer review and cannot be applied automatically.`);
  const value = applyEdits(source, selected.flatMap((fix) => fix.edit ? [fix.edit] : []));
  const remaining = lint(value, platforms);
  if (selected.length > 0 && remaining.warningCount > diagnosed.warningCount) throw new Error('Selected quick fixes made diagnostics worse; refusing the patch.');
  return {
    valid: diagnosed.valid,
    warningCount: diagnosed.warningCount,
    warnings: diagnosed.warnings,
    fixes,
    appliedFixIds: selected.map(({ id }) => id),
    value,
    remainingWarningCount: remaining.warningCount,
    remainingValid: remaining.valid,
    patch: createSourcePatch(source, value, 'quick-fix', 'diagnostic-fixes'),
    undoPatch: createSourcePatch(value, source, 'quick-fix', 'undo-diagnostic-fixes'),
  };
}
