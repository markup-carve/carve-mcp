import { describe, expect, it } from 'vitest';
import { format, lint, MAX_SOURCE_BYTES, migrate, parse, render, validateSource } from './tools.js';

describe('Carve operations', () => {
  it('lints valid input', () => expect(lint('# Hello').valid).toBe(true));
  it('formats source canonically', () => expect(format('# Hello').value).toContain('Hello'));
  it('renders every supported target', () => {
    expect(render('# Hello', 'html').value).toContain('<h1');
    expect(render('# Hello', 'markdown').value).toContain('# Hello');
    expect(render('# Hello', 'plain').value).toContain('Hello');
    expect(render('# Hello', 'ansi').value).toContain('Hello');
    expect(render('# Hello', 'carve').value).toContain('# Hello');
  });
  it('returns a position-aware AST', () => expect(parse('# Hello')).toMatchObject({ type: 'document' }));
  it('migrates each input format', () => {
    expect(migrate('<strong>Hello</strong>', 'html').value).toContain('Hello');
    expect(migrate('**Hello**', 'markdown').value).toContain('Hello');
    expect(migrate('*Hello*', 'djot').value).toContain('Hello');
  });
  it('rejects oversized input', () => expect(() => validateSource('x'.repeat(MAX_SOURCE_BYTES + 1))).toThrow(/limit/));
});
