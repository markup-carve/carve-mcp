/**
 * Every field the AST schema puts nodes in, in the order a document reads
 * them, so a walk keyed by field name reaches all of them.
 *
 * Spelled once here rather than in each walk. The names and the order are the
 * engine's own `ALL_OWNED_CHILD_FIELDS`, derived in `dist/owned-child-fields.js`
 * from the schema-generated `NODE_POSITION_KIND`, less the `terms` and
 * `definitions` slots that only the engine's internal record shape uses.
 * `ast-fields.test.ts` compares against both the schema field set and that
 * order, and reaches into a definition list to keep the exclusion honest.
 */
export const AST_CHILD_FIELDS = [
  'target',
  'title',
  'children',
  'items',
  'rows',
  'cells',
  'blocks',
  'inline',
  'content',
  'prefix',
  'locator',
  'suffix',
  'old',
  'new',
  'pairs',
  'base',
  'annotation',
  'caption',
  'shortCaption',
  'fallback',
] as const;
