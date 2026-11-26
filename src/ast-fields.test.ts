import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AST_CHILD_FIELDS } from './ast-fields.js';
import { astNodes, parse, type AstJsonDocument } from './tools.js';

/**
 * The walk is keyed by field name, so a field it does not name hides every node
 * under it from `carve_select_ast_nodes`, `carve_plan_ast_edit` and the node
 * previews (carve-mcp#60). Both checks read the installed 0.2 engine.
 */
const NODE_TYPES = new URL('../node_modules/@markup-carve/carve/dist/types/src/ast-nodes.d.ts', import.meta.url);

function engineNodeFields(): string[] {
  const fields = new Set<string>();
  for (const match of readFileSync(NODE_TYPES, 'utf8').matchAll(/^\s+([a-zA-Z]+)\??: (.+);$/gm)) {
    const [, field, type] = match;
    if (field !== 'type' && /(?:Node|Inline|Block)\)?\[\]|Node\[\]>|^CaptionNode$/.test(type!)) fields.add(field!);
  }
  return [...fields].sort();
}

/** Every typed node reachable through any field but attributes and positions. */
function everyNodePath(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => everyNodePath(item, `${path}/${index}`));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const own = typeof record.type === 'string' ? [path] : [];
  return [...own, ...Object.entries(record).filter(([key]) => key !== 'attrs' && key !== 'pos')
    .flatMap(([key, child]) => everyNodePath(child, `${path}/${key}`))];
}

describe('the AST child-field list', () => {
  it('names every field the 0.2 node types put nodes in', () => {
    expect([...AST_CHILD_FIELDS].sort()).toStrictEqual(engineNodeFields());
  });

  it('reaches every node of a document using many node positions', () => {
    const source = [
      '= Title *strong* /em/',
      '',
      '- item [link](https://example.com)',
      '',
      '|= A |= B |',
      '| 1 | {_u_} |',
      '^ Table caption',
      '',
      '![alt](i.jpg)',
      '^ Figure caption',
      '',
      '::: note "Title"',
      'Body[^n]',
      ':::',
      '',
      '[^n]: Note',
      '',
      ':: Term',
      ': Definition',
      '',
    ].join('\n');
    const ast = parse(source) as AstJsonDocument;
    const walked = astNodes(ast).map(({ path }) => path).sort();
    expect(walked).toStrictEqual(everyNodePath(ast).sort());
    expect(walked.length).toBeGreaterThan(20);
  });
});
