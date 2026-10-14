import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { includeScope } from './includes.js';
import { applyStructuredAstPatch, format, MAX_WRITER_DEPTH, parse, planSemanticAstEdit, render } from './tools.js';
import { prepareWorkspace } from './workspace.js';

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'carve-mcp-security-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, workspace: await prepareWorkspace({ roots: [root], allowWrite: true }) };
}

const looseList = (levels: number) => Array.from({ length: levels }, (_, index) => `${' '.repeat(index * 2)}- x\n`).join('\n');

describe('include workspace policy', () => {
  const secrets = {
    '.env': 'SECRET=env\n',
    '.git/config': 'SECRET=git\n',
    'node_modules/pkg/README.md': 'SECRET=module\n',
    'vendor/lib/notes.md': 'SECRET=vendor\n',
    'target/out.txt': 'SECRET=target\n',
    'settings.json': '{"SECRET":"json"}\n',
  };

  for (const path of Object.keys(secrets)) {
    it(`does not expand {{ ${path} }}, which carve_read_file refuses`, async () => {
      const { workspace } = await fixture(secrets);
      const scope = includeScope(workspace, { includeRootIndex: 0 });
      const out = render(`{{ ${path} }}\n`, 'plain', {}, scope);
      expect(out.value).not.toContain('SECRET');
      expect(out.includes?.warnings.map((warning) => warning.rule)).toEqual(['include-unresolved']);
      expect(out.includes?.dependencies.every((dependency) => !dependency.resolved)).toBe(true);
      expect(JSON.stringify(parse(`{{ ${path} }}\n`, scope))).not.toContain('SECRET');
      await expect(workspace.read(0, path)).rejects.toThrow();
    });
  }

  it('checks the resolved target, so a document-named symlink to a hidden file is refused', async () => {
    const { root, workspace } = await fixture({ '.env': 'SECRET=env\n' });
    await mkdir(join(root, 'docs'));
    await symlink('../.env', join(root, 'docs', 'env.md'));
    const out = render('{{ docs/env.md }}\n', 'plain', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).not.toContain('SECRET');
    await expect(workspace.read(0, 'docs/env.md')).rejects.toThrow(/Hidden paths/);
  });

  it('still expands a normal document reached through ..', async () => {
    const { workspace } = await fixture({ 'shared/glossary.crv': 'Glossary text.\n', 'chapters/one.crv': '{{ ../shared/glossary.crv }}\n' });
    const out = render('{{ chapters/one.crv }}\n', 'plain', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).toContain('Glossary text.');
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO instead of blocking on it', async () => {
    const { root, workspace } = await fixture({});
    execFileSync('mkfifo', [join(root, 'pipe.crv')]);
    const started = performance.now();
    const out = render('{{ pipe.crv }}\n', 'plain', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(out.includes?.warnings.map((warning) => warning.rule)).toEqual(['include-unresolved']);
  }, 10_000);
});

describe('host paths stay out of results', () => {
  it('reports pos.file for included nodes relative to the root', async () => {
    const { root, workspace } = await fixture({ 'parts/child.crv': '# Child\n' });
    const ast = parse('{{ parts/child.crv }}\n', includeScope(workspace, { includeRootIndex: 0 }));
    const serialized = JSON.stringify(ast);
    expect(serialized).not.toContain(root);
    expect(serialized).toContain('"file":"parts/child.crv"');
    const files = [...serialized.matchAll(/"file":"([^"]*)"/g)].map((match) => match[1]!);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(isAbsolute(file)).toBe(false);
  });

  it('keeps the root out of a write error for a missing directory', async () => {
    const { root, workspace } = await fixture({});
    const error = await workspace.write(0, 'nope/doc.crv', 'x').catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(root);
    expect((error as Error).message).toContain('nope/doc.crv');
  });
});

describe('writer depth guard', () => {
  it('refuses carve_format on a tree past the writer limit, quickly', () => {
    const started = performance.now();
    expect(() => format(looseList(230))).toThrow(new RegExp(`deeper than ${MAX_WRITER_DEPTH} AST levels`));
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('still formats a deeply nested but reasonable document', () => {
    expect(format(looseList(40)).value).toContain('- x');
  });

  it('refuses carve_apply_ast_patch when the patched tree is too deep', () => {
    const ast = parse('Para.\n');
    let node: Record<string, unknown> = { type: 'paragraph', children: [{ type: 'text', value: 'x' }] };
    for (let index = 0; index < MAX_WRITER_DEPTH; index += 1) node = { type: 'block_quote', children: [node] };
    expect(() => applyStructuredAstPatch(ast, [{ op: 'replace', path: '/children/0', value: node }])).toThrow(/deeper than/);
  });

  it('refuses carve_plan_ast_edit when the edited tree is too deep', () => {
    let node: Record<string, unknown> = { type: 'paragraph', children: [{ type: 'text', value: 'x' }] };
    for (let index = 0; index < MAX_WRITER_DEPTH; index += 1) node = { type: 'block_quote', children: [node] };
    expect(() => planSemanticAstEdit('Para.\n', { kind: 'node-type', value: 'paragraph' }, { kind: 'replace-node', node })).toThrow(/deeper than/);
  });
});
