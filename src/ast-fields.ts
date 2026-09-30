/**
 * Every field the AST schema puts nodes in, in the order a document reads
 * them, so a walk keyed by field name reaches all of them.
 *
 * Spelled once here rather than in each walk. The names and the order are the
 * engine's own `CHILD_FIELDS` from `dist/ast-sidecars.js`, which drives the
 * exported `astNodePaths` and takes its positions from the schema-generated
 * `NODE_POSITION_KIND`. `ast-fields.test.ts` compares both.
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
