import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareWorkspace } from './workspace.js';
import { createServer } from './server.js';
import { includeScope } from './includes.js';
import { lint, parse, render } from './tools.js';

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'carve-mcp-includes-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, workspace: await prepareWorkspace({ roots: [root] }) };
}

describe('include authorization', () => {
  it('leaves directives literal when the call names no root', async () => {
    const { root, workspace } = await fixture({ 'child.crv': 'Child.\n' });
    const scope = includeScope(workspace, {});
    expect(scope).toBeUndefined();
    const out = render('{{ child.crv }}\n', 'html', {}, scope);
    expect(out.value).toContain('{{ child.crv }}');
    expect(out.includes).toBeUndefined();
    expect(root).toBeTruthy();
  });

  it('refuses a sourcePath with no root, so a caller cannot believe includes are on', async () => {
    const { workspace } = await fixture({ 'child.crv': 'Child.\n' });
    expect(() => includeScope(workspace, { sourcePath: 'doc.crv' })).toThrow(/requires includeRootIndex/);
  });

  it('refuses a root the server never authorized', () => {
    expect(() => includeScope(undefined, { includeRootIndex: 0 })).toThrow(/--root/);
  });

  it('refuses a root index outside the configured set', async () => {
    const { workspace } = await fixture({ 'child.crv': 'Child.\n' });
    expect(() => includeScope(workspace, { includeRootIndex: 1 })).toThrow(/Unknown root index 1/);
  });

  it('refuses an absolute sourcePath and one that climbs out', async () => {
    const { workspace } = await fixture({ 'child.crv': 'Child.\n' });
    expect(() => includeScope(workspace, { includeRootIndex: 0, sourcePath: '/etc/doc.crv' })).toThrow(/must be relative/);
    expect(() => includeScope(workspace, { includeRootIndex: 0, sourcePath: '../doc.crv' })).toThrow(/stay inside/);
  });
});

describe('include expansion', () => {
  it('expands a contained target', async () => {
    const { workspace } = await fixture({ 'child.crv': 'Child text.\n' });
    const out = render('{{ child.crv }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).toContain('Child text.');
    expect(out.includes?.warnings).toEqual([]);
    expect(out.includes?.dependencies).toEqual([{ path: 'child.crv', resolved: true }]);
  });

  it('resolves a nested path against the including file, not the root', async () => {
    const { workspace } = await fixture({
      'parts/child.crv': 'Child.\n\n{{ sibling.crv }}\n',
      'parts/sibling.crv': 'Sibling.\n',
    });
    const scope = includeScope(workspace, { includeRootIndex: 0, sourcePath: 'index.crv' });
    const out = render('{{ parts/child.crv }}\n', 'html', {}, scope);
    expect(out.value).toContain('Sibling.');
    expect(out.includes?.dependencies.map((entry) => entry.path).sort()).toEqual(['parts/child.crv', 'parts/sibling.crv']);
  });

  it('places the document itself by sourcePath, so a bare sibling resolves', async () => {
    const { workspace } = await fixture({ 'parts/sibling.crv': 'Sibling.\n' });
    const out = render('{{ sibling.crv }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0, sourcePath: 'parts/index.crv' }));
    expect(out.value).toContain('Sibling.');
    expect(out.includes?.dependencies).toEqual([{ path: 'parts/sibling.crv', resolved: true }]);
  });

  it('expands for carve_parse on the same terms', async () => {
    const { workspace } = await fixture({ 'child.crv': '# Child\n' });
    const ast = parse('{{ child.crv }}\n', includeScope(workspace, { includeRootIndex: 0 }));
    expect(JSON.stringify(ast.children)).toContain('"heading"');
    expect(ast.includes?.dependencies).toEqual([{ path: 'child.crv', resolved: true }]);
  });

  it('reports an unresolved target so a watcher can see it appear', async () => {
    const { workspace } = await fixture({ 'child.crv': 'Child.\n' });
    const out = render('{{ missing.crv }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.includes?.dependencies).toEqual([{ path: 'missing.crv', resolved: false }]);
  });
});

describe('include containment', () => {
  it('refuses a target above the root and keeps the directive literal', async () => {
    const { root, workspace } = await fixture({ 'child.crv': 'Child.\n' });
    await writeFile(join(root, '..', 'escape.crv'), 'Escaped.\n');
    const out = render('{{ ../escape.crv }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).toContain('{{ ../escape.crv }}');
    expect(out.value).not.toContain('Escaped.');
    // C2-N-013: the 0.2 parse names the resolver cause instead of include-unresolved.
    expect(out.includes?.warnings.map((warning) => warning.rule)).toEqual([expect.stringMatching(/^include-(?:not-found|outside-root)$/)]);
  });

  it('refuses a symlink pointing out of the root', async () => {
    const { root, workspace } = await fixture({ 'child.crv': 'Child.\n' });
    const outside = await mkdtemp(join(tmpdir(), 'carve-mcp-outside-'));
    await writeFile(join(outside, 'secret.crv'), 'Secret.\n');
    await symlink(join(outside, 'secret.crv'), join(root, 'link.crv'));
    const out = render('{{ link.crv }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).not.toContain('Secret.');
    expect(out.includes?.warnings.map((warning) => warning.rule)).toEqual([expect.stringMatching(/^include-(?:not-found|outside-root)$/)]);
  });

  it('refuses an absolute include path', async () => {
    const { root, workspace } = await fixture({ 'child.crv': 'Child.\n' });
    const out = render(`{{ ${join(root, 'child.crv')} }}\n`, 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).not.toContain('Child.');
    expect(out.includes?.warnings.map((warning) => warning.rule)).toEqual([expect.stringMatching(/^include-(?:not-found|outside-root)$/)]);
  });

  it('does not read a file beside the process working directory', async () => {
    const { workspace } = await fixture({ 'child.crv': 'Child.\n' });
    const out = render('{{ package.json }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).not.toContain('carve-mcp');
    expect(out.includes?.warnings.map((warning) => warning.rule)).toEqual([expect.stringMatching(/^include-(?:not-found|outside-root)$/)]);
  });

  it('breaks a cycle', async () => {
    const { workspace } = await fixture({ 'a.crv': '{{ b.crv }}\n', 'b.crv': '{{ a.crv }}\n' });
    const out = render('{{ a.crv }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0, sourcePath: 'a.crv' }));
    expect(out.includes?.warnings.some((warning) => warning.rule === 'include-cycle')).toBe(true);
  });
});

describe('include reporting', () => {
  it('names files by their path inside the root and never by a host path', async () => {
    const { root, workspace } = await fixture({
      'parts/child.crv': '{{ missing.crv }}\n',
    });
    const out = render('{{ parts/child.crv }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    const files = out.includes?.warnings.map((warning) => warning.file) ?? [];
    expect(files).toEqual(['parts/child.crv']);
    for (const path of [...files, ...(out.includes?.dependencies.map((entry) => entry.path) ?? [])]) {
      expect(isAbsolute(path ?? '')).toBe(false);
      expect(path).not.toContain(root);
      expect(path).not.toContain(tmpdir());
    }
  });
});

const SERVER_JS = 'const hidden = 1;\n// #region start\nexport const shown = 2;\n// #endregion\n';

describe('code includes of source files', () => {
  it('renders a @code region of a .js file as a code block', async () => {
    const { workspace } = await fixture({ 'src/server.js': SERVER_JS });
    const out = render('{{ src/server.js @region:start @code:js }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).toContain('<code class="language-js">export const shown = 2;');
    expect(out.value).not.toContain('hidden');
    expect(out.includes?.warnings).toEqual([]);
    expect(out.includes?.dependencies).toEqual([{ path: 'src/server.js', resolved: true }]);
  });

  it('keeps a text include of a source file literal', async () => {
    const { workspace } = await fixture({ 'src/server.js': SERVER_JS });
    const out = render('{{ src/server.js }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).toContain('{{ src/server.js }}');
    expect(out.value).not.toContain('shown');
    expect(out.includes?.warnings.map((warning) => warning.rule)).toEqual([expect.stringMatching(/^include-(?:not-found|outside-root)$/)]);
  });

  // C2-N-012: 0.2 calls the resolver once per include with its own options, so the @code read no longer
  // fails because another include in the document asks for the same file as Carve.
  it('reads a source file for @code and refuses it as Carve in the same document', async () => {
    const { workspace } = await fixture({ 'src/server.js': SERVER_JS });
    const out = render('{{ src/server.js @code:js }}\n\n{{ src/server.js }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).toContain('<pre><code class="language-js">');
    expect(out.value).toContain('{{ src/server.js }}');
  });

  it('keeps a text include of a source file literal inside an included Carve file', async () => {
    const { workspace } = await fixture({ 'src/server.js': SERVER_JS, 'part.crv': '{{ src/server.js }}\n\n{{ src/server.js @code:js }}\n' });
    const out = render('{{ part.crv }}\n', 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.value).toContain('{{ src/server.js }}');
  });

  it('still refuses hidden and dependency paths for @code includes', async () => {
    const { workspace } = await fixture({ '.env': 'SECRET=env\n', 'node_modules/pkg/index.js': 'SECRET=module\n' });
    for (const path of ['.env', 'node_modules/pkg/index.js']) {
      const out = render(`{{ ${path} @code }}\n`, 'html', {}, includeScope(workspace, { includeRootIndex: 0 }));
      expect(out.value).not.toContain('SECRET');
      expect(out.includes?.dependencies.every((dependency) => !dependency.resolved)).toBe(true);
    }
  });

  it('expands a @code include for carve_parse on the same terms', async () => {
    const { workspace } = await fixture({ 'src/server.js': SERVER_JS });
    const ast = parse('{{ src/server.js @region:start @code:js }}\n', includeScope(workspace, { includeRootIndex: 0 }));
    expect(JSON.stringify(ast.children)).toContain('export const shown = 2;');
  });
});

describe('lint through includes', () => {
  it('reports a finding inside an included file by its root-relative path', async () => {
    const { root, workspace } = await fixture({ 'parts/child.crv': 'See [x][missing].\n' });
    const out = lint('{{ parts/child.crv }}\n', [], includeScope(workspace, { includeRootIndex: 0, sourcePath: 'index.crv' }));
    expect(out.valid).toBe(false);
    // 0.2 diagnostics name the file but carry no include chain (markup-carve/carve-js#5056).
    expect(out.warnings).toEqual([expect.objectContaining({ file: 'parts/child.crv', line: 1 })]);
    expect(JSON.stringify(out)).not.toContain(root);
  });

  it('names the include chain of a finding in an included file', async () => {
    const { workspace } = await fixture({ 'parts/child.crv': 'See [x][missing].\n' });
    const out = lint('{{ parts/child.crv }}\n', [], includeScope(workspace, { includeRootIndex: 0, sourcePath: 'index.crv' }));
    expect(out.warnings).toEqual([expect.objectContaining({
      rule: 'unresolved-reference-link', file: 'parts/child.crv', line: 1, column: 5,
      includedBy: [expect.objectContaining({ file: 'index.crv', line: 1, column: 1 })],
    })]);
  });

  it('reports include offsets in UTF-16 units of the file they name', async () => {
    const { workspace } = await fixture({ 'child.crv': '\u{1F600} {{ gone.crv }}\n' });
    // C2-N-002: an include is a block line only, so the directive stands on its own line; C2-N-013 names the cause.
    const out = lint('\u{1F600}\u{1F600}\n\n{{ absent.crv }}\n\n{{ child.crv }}\n', [], includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'include-not-found', line: 3, column: 1, start: 6, end: 22 }),
    ]));
  });

  it('lints nothing included without a root', async () => {
    const out = lint('{{ parts/child.crv }}\n');
    // C2-N-003: a call without a resolver reports every include with include-no-resolver.
    expect(out.warnings.map((warning) => warning.rule)).toEqual(['include-no-resolver']);
  });

  it('reports an include it could not resolve', async () => {
    const { workspace } = await fixture({ 'child.crv': 'Child.\n' });
    const out = lint('{{ settings.json }}\n', [], includeScope(workspace, { includeRootIndex: 0 }));
    expect(out.warnings.map((warning) => warning.rule)).toEqual([expect.stringMatching(/^include-(?:not-found|outside-root)$/)]);
  });

  it('applies the render policy, so a hidden file is never linted', async () => {
    const { root, workspace } = await fixture({ 'child.crv': 'Child.\n' });
    await mkdir(join(root, '.private'));
    await writeFile(join(root, '.private', 'notes.crv'), 'See [x][secret-label].\n');
    const out = lint('{{ .private/notes.crv }}\n', [], includeScope(workspace, { includeRootIndex: 0 }));
    expect(JSON.stringify(out)).not.toContain('secret-label');
  });
});

describe('include options over MCP', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => { await Promise.all(closeables.splice(0).map((item) => item.close())); });

  async function connect(roots?: string[]) {
    const server = await createServer(roots ? { roots } : undefined);
    const client = new Client({ name: 'include-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  const properties = async (client: Client, tool: string) => Object.keys(
    ((await client.listTools()).tools.find((entry) => entry.name === tool)?.inputSchema.properties ?? {}) as Record<string, unknown>,
  );

  it('advertises no include option on a server with no configured root', async () => {
    const client = await connect();
    expect(await properties(client, 'carve_render')).not.toContain('includeRootIndex');
    expect(await properties(client, 'carve_parse')).not.toContain('includeRootIndex');
    expect(await properties(client, 'carve_lint')).not.toContain('includeRootIndex');
  });

  it('advertises the include option once a root is configured, and expands through it', async () => {
    const { root } = await fixture({ 'child.crv': 'Child text.\n' });
    const client = await connect([root]);
    expect(await properties(client, 'carve_render')).toContain('includeRootIndex');
    const called = await client.callTool({
      name: 'carve_render',
      arguments: { source: '{{ child.crv }}\n', target: 'html', includeRootIndex: 0 },
    });
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toEqual(expect.objectContaining({
      value: expect.stringContaining('Child text.'),
      includes: expect.objectContaining({ rootIndex: 0, dependencies: [{ path: 'child.crv', resolved: true }] }),
    }));
  });

  it('lints included content through carve_lint once a root is configured', async () => {
    const { root } = await fixture({ 'child.crv': 'See [x][missing].\n' });
    const client = await connect([root]);
    expect(await properties(client, 'carve_lint')).toContain('includeRootIndex');
    const called = await client.callTool({ name: 'carve_lint', arguments: { source: '{{ child.crv }}\n', includeRootIndex: 0 } });
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toEqual(expect.objectContaining({
      valid: false,
      warnings: [expect.objectContaining({ rule: 'unresolved-reference-link', file: 'child.crv', resourceUri: 'carve://lint-rules/unresolved-reference-link' })],
    }));
  });

  it('refuses an unauthorized root index through the tool call', async () => {
    const { root } = await fixture({ 'child.crv': 'Child.\n' });
    const client = await connect([root]);
    const called = await client.callTool({ name: 'carve_render', arguments: { source: '{{ child.crv }}\n', target: 'html', includeRootIndex: 4 } });
    expect(called.isError).toBe(true);
  });
});
