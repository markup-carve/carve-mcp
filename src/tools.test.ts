import { describe, expect, it } from 'vitest';
import { format, lint, MAX_SOURCE_BYTES, migrate, parse, render, validateSource } from './tools.js';

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
