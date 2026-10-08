import { readFileSync } from 'node:fs';
import { astNodePaths, parse, toAstJson, type AstJsonDocument } from '@markup-carve/carve';
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
const RUST_SERVER = new URL('../rust/src/server.rs', import.meta.url);

/**
 * Engine 0.1.10 derives the ordered walk from the schema instead of holding a
 * `CHILD_FIELDS` literal, so the order is imported now rather than scraped out
 * of `ast-sidecars.js`.
 *
 * Its two extra entries belong to the engine's internal record shape, where a
 * definition list carries `terms` and `definitions`. The wire AST this server
 * reads spells the same content as `items` and `children`, which the fixture
 * below proves by reaching into one. Should the wire shape ever move to the
 * record spelling, that fixture fails rather than this exclusion hiding it.
 */
const RECORD_ONLY_FIELDS = ['terms', 'definitions'];

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
    {
      type: 'definition_list',
      items: [
        { type: 'definition_term', children: [text('TERM')] },
        { type: 'definition_description', children: [{ type: 'paragraph', children: [text('DESCRIPTION')] }] },
      ],
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
  'TITLE', 'CHILDREN', 'ITEMS', 'CELLS', 'BLOCKS', 'TERM', 'DESCRIPTION', 'TARGET', 'CAPTION',
  'SHORTCAPTION', 'FALLBACK', 'INLINE', 'CONTENT', 'PREFIX', 'LOCATOR', 'SUFFIX', 'OLD', 'NEW',
  'BASE', 'ANNOTATION',
];

describe('the AST child-field list', () => {
  it('names every field the engine schema puts nodes in', () => {
    const schemaFields = literal(ENGINE_WIRE_FIELDS, /NODE_FIELDS = \[([^\]]+)\]/);
    expect([...AST_CHILD_FIELDS].sort()).toStrictEqual([...schemaFields].sort());
  });

  it("matches the order of the engine's own walk", async () => {
    const { ALL_OWNED_CHILD_FIELDS } = await import(
      '../node_modules/@markup-carve/carve/dist/owned-child-fields.js'
    );

    expect(ALL_OWNED_CHILD_FIELDS, 'the engine no longer exports its ordered walk').toBeInstanceOf(Array);
    const engineOrder = ALL_OWNED_CHILD_FIELDS.filter((field) => !RECORD_ONLY_FIELDS.includes(field));
    expect(engineOrder.length).toBeGreaterThan(0);
    expect([...AST_CHILD_FIELDS]).toStrictEqual(engineOrder);
  });

  it('excludes only fields the wire AST never spells', async () => {
    const { ALL_OWNED_CHILD_FIELDS } = await import(
      '../node_modules/@markup-carve/carve/dist/owned-child-fields.js'
    );

    expect(ALL_OWNED_CHILD_FIELDS.filter((field) => !AST_CHILD_FIELDS.includes(field as never)))
      .toStrictEqual(RECORD_ONLY_FIELDS);
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

describe('what the walk must not treat as a node', () => {
  // `attrs.keyValues` holds strings, and an attribute may be named `type`, so
  // `{type=widget}` puts an object shaped {"type":"widget"} under a node. A walk
  // that called any object with a string `type` a child would offer it for
  // selection and for a delete or replace plan. The field list is what keeps it
  // out, so this pins it rather than leaving it to the list's shape.
  const attributed = toAstJson(parse('[x]{type=widget}')) as unknown as AstJsonDocument;

  it('leaves an attribute named type out of selection', () => {
    expect(selectAstNodes(attributed, { kind: 'node-type', value: 'widget' }).matchCount).toBe(0);
  });

  it('finds no node the engine walk does not report', () => {
    const engine = astNodePaths(attributed).filter((path) => path !== '');
    const found = ['document', 'paragraph', 'span', 'text', 'widget']
      .map((type) => selectAstNodes(attributed, { kind: 'node-type', value: type }).matchCount)
      .reduce((total, count) => total + count, 0);
    expect(found).toBe(engine.length + 1);
  });

  it('reports each node of the covered document once', () => {
    const engine = astNodePaths(covered as unknown as AstJsonDocument);
    const types = [...new Set(engine.map((path) => selectAstNodes(covered, { kind: 'ast-path', value: path || '/' }).matches[0]?.type ?? 'document'))];
    const found = types
      .map((type) => selectAstNodes(covered, { kind: 'node-type', value: type }).matchCount)
      .reduce((total, count) => total + count, 0);
    expect(found).toBe(engine.length);
  });
});
