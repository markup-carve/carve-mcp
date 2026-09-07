import { describe, expect, it } from 'vitest';
import { applyStructuredAstPatch, createStructuredAstPatch, format, lint, MAX_AST_PATCH_OPERATIONS, MAX_SOURCE_BYTES, migrate, parse, render, validateSource } from './tools.js';

describe('Carve operations', () => {
  it('lints valid input', () => expect(lint('# Hello').valid).toBe(true));
  it('returns positioned lint warnings', () => {
    expect(lint(':::')).toMatchObject({
      valid: false,
      warningCount: 1,
      warnings: [{ line: 1, column: 1, rule: 'unclosed-container-fence' }],
    });
  });
  it('formats source canonically', () => expect(format('# Hello').value).toContain('Hello'));
  it('renders every supported target', () => {
    expect(render('# Hello', 'html').value).toContain('<h1');
    expect(render('# Hello', 'markdown').value).toContain('# Hello');
    expect(render('# Hello', 'plain').value).toContain('Hello');
    expect(render('# Hello', 'ansi').value).toContain('Hello');
  });
  it('applies named presets and extensions', () => {
    expect(render('# Héllo', 'html', { preset: 'portable' }).value).toContain('id="hello"');
    expect(render('Visit https://example.com', 'html', { extensions: ['autolink'] }).value).toContain('<a href=');
    expect(() => render('# Hello', 'markdown', { preset: 'static-html' })).toThrow(/HTML target/);
    expect(() => render('[x]{samp}', 'markdown', { extensions: ['semantic-spans'] })).toThrow(/HTML target/);
  });
  it('keeps untrusted HTML inert unless explicitly enabled', () => {
    const source = '`<script>alert(1)</script>`{=html}';
    expect(render(source, 'html').value).not.toContain('<script>');
    expect(render(source, 'html', { allowRawHtml: true }).value).toContain('<script>');
  });
  it('returns a position-aware AST', () => expect(parse('# Hello')).toMatchObject({ type: 'document' }));
  it('creates and applies position-independent AST patches', () => {
    const before = parse('# Before');
    const after = parse('# After');
    const patch = createStructuredAstPatch(before, after);
    expect(patch.operationCount).toBeGreaterThan(0);
    expect(patch.operations).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'replace' })]));
    const applied = applyStructuredAstPatch(before, patch.operations);
    expect(applied.ast).toEqual(expect.objectContaining({ type: 'document', srcByteLength: 0 }));
    expect(applied.source).toContain('After');
    expect(before).toMatchObject({ srcByteLength: 8 });
  });
  it('rejects malformed or excessive AST patches', () => {
    const ast = parse('# Hello');
    expect(() => applyStructuredAstPatch(ast, [{ op: 'replace', path: '/nope', value: true }])).toThrow(/does not exist/);
    expect(() => createStructuredAstPatch({ type: 'doc' }, ast)).toThrow(/document/);
    expect(() => applyStructuredAstPatch(ast, [{ op: 'move', path: '/children/0', value: true }])).toThrow(/unknown patch operation/);
    expect(() => applyStructuredAstPatch(ast, [{ op: 'remove', path: '/children/0', value: true }])).toThrow(/must not carry a value/);
    expect(() => applyStructuredAstPatch(ast, Array.from({ length: MAX_AST_PATCH_OPERATIONS + 1 }, () => ({ op: 'remove', path: '/children/0' })))).toThrow(/limit/);
    expect(() => applyStructuredAstPatch(ast, [{ op: 'replace', path: '/children/0', value: 'x'.repeat(MAX_SOURCE_BYTES) }])).toThrow(/limit/);
  });
  it('orders patch paths deterministically by code point', () => {
    const before = parse('[x]{Foo="1" bar="2"}');
    const after = parse('[x]{Foo="9" bar="8"}');
    expect(createStructuredAstPatch(before, after).operations.map(({ path }) => path)).toEqual([
      '/children/0/children/0/attrs/keyValues/Foo',
      '/children/0/children/0/attrs/keyValues/bar',
    ]);
  });
  it('normalizes the returned AST to match its rendered source', () => {
    const ast = parse('Body');
    const footnote = { type: 'footnote', label: 'note', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Note' }] }] };
    const applied = applyStructuredAstPatch(ast, [{ op: 'replace', path: '/children', value: [footnote, ...ast.children] }]);
    expect(createStructuredAstPatch(applied.ast, parse(applied.source)).operationCount).toBe(0);
  });
  it('migrates each input format', () => {
    expect(migrate('<strong>Hello</strong>', 'html')).toMatchObject({
      value: expect.stringContaining('Hello'),
      report: { schemaVersion: 1, sourceFormat: 'html', diagnostics: expect.any(Array) },
    });
    expect(migrate('**Hello**', 'markdown').value).toContain('Hello');
    expect(migrate('*Hello*', 'djot').value).toContain('Hello');
  });
  it('opts into Markdown dialect constructs explicitly', () => {
    expect(migrate('==marked==', 'markdown').value).toBe('==marked==');
    expect(migrate('==marked==', 'markdown', { highlight: true }).value).toContain('=marked=');
    expect(() => migrate('<b>x</b>', 'html', { highlight: true })).toThrow(/only valid/);
  });
  it('rejects oversized input', () => expect(() => validateSource('x'.repeat(MAX_SOURCE_BYTES + 1))).toThrow(/limit/));
});
