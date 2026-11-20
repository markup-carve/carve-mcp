/**
 * Every field the 0.2 tree (contract 2.0) puts nodes in, in reading order, so
 * a walk keyed by field name reaches all of them. `slots` maps a slot name to
 * a node list; `childEntries` flattens it.
 */
export const AST_CHILD_FIELDS = [
  'title',
  'base',
  'annotation',
  'prefix',
  'children',
  'suffix',
  'short',
  'longDescription',
  'pairs',
  'columns',
  'caption',
  'fallback',
  'slots',
] as const;

/** The node-holding fields of `record` as `[pointer segments, value]`, with slots expanded. */
export function childEntries(record: Record<string, unknown>): Array<[string[], unknown]> {
  const entries: Array<[string[], unknown]> = [];
  for (const field of AST_CHILD_FIELDS) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (field === 'slots' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, nodes] of Object.entries(value)) entries.push([[field, name], nodes]);
    } else entries.push([[field], value]);
  }
  return entries;
}
