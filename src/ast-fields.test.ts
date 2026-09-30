import { readFileSync } from 'node:fs';
import { astNodePaths, type AstJsonDocument } from '@markup-carve/carve';
import { describe, expect, it } from 'vitest';
import { AST_CHILD_FIELDS } from './ast-fields.js';
import { selectAstNodes } from './tools.js';

/**
 * The walk is keyed by field name, so a field it does not name hides everything
 * under it from `carve_select_ast_nodes`, `carve_plan_ast_edit` and the node
 * previews. `ruby.pairs` went unnamed for two engine releases that way
 * (carve-mcp#60), and naming the fields one report at a time is what let it.
 *
 * Two checks stand against that, both reading the installed engine:
 *
 * - The fixture below puts a text node in all twenty positions, and every path
 *   the engine's exported `astNodePaths` reports has to be selectable. That
 *   catches a field the walk drops, and it compares against the engine's own
 *   schema-driven walk rather than against a list written here.
 * - The field list has to equal the engine's, both the schema-generated
 *   `NODE_FIELDS` and the ordered `CHILD_FIELDS` its walk uses. That catches a
 *   field the engine grows which no fixture here covers yet. Both are
 *   module-local in the engine's dist, so they are read out of the file and a
 *   literal that cannot be found is a failure, not a pass.
 *
 * `astNodePaths` cannot drive the walk itself: it takes a whole document, while
 * `nodeText` walks a single node and the reference graph walks a parse result.
 */
const ENGINE_WIRE_FIELDS = new URL('../node_modules/@markup-carve/carve/dist/wire-fields.js', import.meta.url);
const ENGINE_SIDECARS = new URL('../node_modules/@markup-carve/carve/dist/ast-sidecars.js', import.meta.url);
const RUST_SERVER = new URL('../rust/src/server.rs', import.meta.url);

function literal(url: URL, pattern: RegExp): string[] {
  const found = pattern.exec(readFileSync(url, 'utf8'))?.[1];
  expect(found, `no match for ${pattern} in ${url.pathname}`).toBeTypeOf('string');
  return [...found!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!);
}

const text = (value: string) => ({ type: 'text', value });

/** One text node per field the schema puts nodes in, named after the field. */
const covered = {
  type: 'document',
  srcByteLength: 0,
  children: [
    { type: 'admonition', kind: 'note', title: [text('TITLE')], children: [{ type: 'paragraph', children: [text('CHILDREN')] }] },
    { type: 'list', ordered: false, tight: true, items: [{ type: 'list_item', children: [{ type: 'paragraph', children: [text('ITEMS')] }] }] },
    {
      type: 'table',
      rows: [{
        type: 'table_row',
        cells: [
          { type: 'table_cell', header: false, children: [text('CELLS')] },
          { type: 'table_cell', header: false, blocks: [{ type: 'paragraph', children: [text('BLOCKS')] }] },
        ],
      }],
    },
    { type: 'figure', target: { type: 'paragraph', children: [text('TARGET')] }, caption: [text('CAPTION')], shortCaption: [text('SHORTCAPTION')] },
    {
      type: 'block_extension',
      name: 'org.example.diagram',
      fallback: { type: 'paragraph', children: [text('FALLBACK')] },
      payload: { format: 'text/plain', value: 'x' },
    },
    {
      type: 'paragraph',
      children: [
        { type: 'inline_footnote', inline: [text('INLINE')] },
        { type: 'inline_extension', name: 'org.example.badge', content: [text('CONTENT')] },
        {
          type: 'citation_group',
          raw: '[@key]',
          items: [{ type: 'citation', key: 'key', suppressAuthor: false, prefix: [text('PREFIX')], locator: [text('LOCATOR')], suffix: [text('SUFFIX')] }],
        },
        { type: 'substitution', old: [text('OLD')], new: [text('NEW')] },
        { type: 'ruby', pairs: [{ base: [text('BASE')], annotation: [text('ANNOTATION')] }] },
      ],
    },
  ],
};

const positions = [
  'TITLE', 'CHILDREN', 'ITEMS', 'CELLS', 'BLOCKS', 'TARGET', 'CAPTION', 'SHORTCAPTION',
  'FALLBACK', 'INLINE', 'CONTENT', 'PREFIX', 'LOCATOR', 'SUFFIX', 'OLD', 'NEW', 'BASE', 'ANNOTATION',
];

describe('the AST child-field list', () => {
  it('names every field the engine schema puts nodes in', () => {
    const schemaFields = literal(ENGINE_WIRE_FIELDS, /NODE_FIELDS = \[([^\]]+)\]/);
    expect([...AST_CHILD_FIELDS].sort()).toStrictEqual([...schemaFields].sort());
  });

  it("matches the order of the engine's own walk", () => {
    const engineOrder = literal(ENGINE_SIDECARS, /CHILD_FIELDS = \[([^\]]+)\]/);
    expect([...AST_CHILD_FIELDS]).toStrictEqual(engineOrder);
  });

  it('is spelled the same way in the Rust server', () => {
    expect(literal(RUST_SERVER, /const AST_CHILD_FIELDS: \[&str; \d+\] = \[([\s\S]+?)\];/)).toStrictEqual([...AST_CHILD_FIELDS]);
  });

  it('declares the Rust array at its own length', () => {
    const declared = /const AST_CHILD_FIELDS: \[&str; (\d+)\]/.exec(readFileSync(RUST_SERVER, 'utf8'))?.[1];
    expect(Number(declared)).toBe(AST_CHILD_FIELDS.length);
  });
});

describe('selection over a document using every node position', () => {
  for (const path of astNodePaths(covered as unknown as AstJsonDocument).filter((candidate) => candidate !== '')) {
    it(`reaches the engine's node at ${path}`, () => {
      expect(selectAstNodes(covered, { kind: 'ast-path', value: path }).matchCount).toBe(1);
    });
  }

  for (const [index, position] of positions.entries()) {
    it(`previews the text under ${position.toLowerCase()}`, () => {
      const matches = selectAstNodes(covered, { kind: 'node-type', value: 'text' }).matches;
      expect(matches[index]?.preview).toBe(position);
    });
  }

  it('finds one text node per position and no others', () => {
    expect(selectAstNodes(covered, { kind: 'node-type', value: 'text' }).matchCount).toBe(positions.length);
  });
});
