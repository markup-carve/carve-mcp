import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectAstNodes } from './tools.js';

/**
 * The AST walk has to descend into every field the engine puts children in.
 *
 * `AST_CHILD_FIELDS` is spelled out three times - `src/tools.ts`,
 * `src/reference-graph.ts` and `rust/src/server.rs` - and the engine exports no
 * list to build it from, so nothing but this file notices when the engine grows
 * a field. `ruby` arrived that way: its `pairs` went unwalked from carve 0.1.8
 * onward, and a node nested in a ruby base was invisible to
 * `carve_select_ast_nodes` (markup-carve/carve-mcp#60).
 *
 * The engine keeps the authority as a module-local `CHILD_FIELDS` in
 * `dist/ast-json.js`. Reading it there is not elegant, but it is a real
 * comparison against the code that builds the wire tree, and it fails closed:
 * if the literal cannot be found, that is a failure and not a pass.
 *
 * For the Rust port this is a floor rather than an exact statement. `carve-lang`
 * decodes these fields through typed structs and publishes no list, and its
 * version trails the npm engine, so the npm list is the only machine-readable
 * authority either port has. A field the crate does not emit costs the Rust walk
 * a key lookup that never matches; a field it emits and the list omits is the
 * bug this file exists to catch.
 */
const ENGINE_AST_JSON = new URL('../node_modules/@markup-carve/carve/dist/ast-json.js', import.meta.url);

function engineChildFields(): string[] {
  const source = readFileSync(ENGINE_AST_JSON, 'utf8');
  const literal = /^const CHILD_FIELDS = \[([^\]]+)\];$/m.exec(source)?.[1];
  expect(literal, `no CHILD_FIELDS literal in ${ENGINE_AST_JSON.pathname}`).toBeTypeOf('string');
  return [...literal!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

function declaredFields(path: string, pattern: RegExp): string[] {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const literal = pattern.exec(source)?.[1];
  expect(literal, `no AST_CHILD_FIELDS literal in ${path}`).toBeTypeOf('string');
  return [...literal!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!);
}

describe('AST child fields', () => {
  it('walks every field the installed engine treats as a child field', () => {
    const engine = engineChildFields();
    expect(engine).toContain('pairs');
    expect(engine).toContain('blocks');
    for (const [path, pattern] of [
      ['./tools.ts', /^const AST_CHILD_FIELDS = \[([^\]]+)\] as const;$/m],
      ['./reference-graph.ts', /^const AST_CHILD_FIELDS = \[([^\]]+)\] as const;$/m],
      ['../rust/src/server.rs', /^const AST_CHILD_FIELDS: \[&str; \d+\] = \[([\s\S]+?)\];$/m],
    ] as const) {
      expect(declaredFields(path, pattern), path).toStrictEqual(engine);
    }
  });

  it('declares the Rust array at its own length', () => {
    const source = readFileSync(new URL('../rust/src/server.rs', import.meta.url), 'utf8');
    const declared = Number(/^const AST_CHILD_FIELDS: \[&str; (\d+)\]/m.exec(source)?.[1]);
    expect(declared).toBe(engineChildFields().length);
  });

  it('selects a node nested in a ruby base or annotation', () => {
    // No Carve source spells a ruby, so this arrives the only way it can: a
    // client-supplied AST. Three text nodes, one of them outside the ruby.
    const ast = {
      type: 'document',
      srcByteLength: 0,
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'ruby',
              pairs: [
                { base: [{ type: 'text', value: 'base' }], annotation: [{ type: 'text', value: 'anno' }] },
              ],
            },
            { type: 'text', value: 'after' },
          ],
        },
      ],
    };
    expect(selectAstNodes(ast, { kind: 'node-type', value: 'text' }).matchCount).toBe(3);
    expect(selectAstNodes(ast, { kind: 'node-type', value: 'ruby' }).matchCount).toBe(1);
  });

  it('selects a node inside a table cell that holds blocks', () => {
    // `table_cell` takes exactly one of `children` or `blocks`, and ingest
    // accepts the `blocks` half, so the walk has to follow it.
    const ast = {
      type: 'document',
      srcByteLength: 0,
      children: [
        {
          type: 'table',
          rows: [
            {
              type: 'table_row',
              cells: [
                { type: 'table_cell', header: false, blocks: [{ type: 'paragraph', children: [{ type: 'text', value: 'in cell' }] }] },
              ],
            },
          ],
        },
        { type: 'paragraph', children: [{ type: 'text', value: 'after' }] },
      ],
    };
    expect(selectAstNodes(ast, { kind: 'node-type', value: 'text' }).matchCount).toBe(2);
    expect(selectAstNodes(ast, { kind: 'node-type', value: 'paragraph' }).matchCount).toBe(2);
  });
});
