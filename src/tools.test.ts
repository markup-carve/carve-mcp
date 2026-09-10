import { describe, expect, it } from 'vitest';
import { applyReversibleStructuredAstPatch, applyStructuredAstPatch, createReversibleStructuredAstPatch, createStructuredAstPatch, format, lint, MAX_AST_PATCH_OPERATIONS, MAX_SOURCE_BYTES, migrate, parse, planSemanticAstEdit, render, selectAstNodes, validateSource } from './tools.js';
import { diagnoseAndFix } from './diagnostics.js';

describe('Carve operations', () => {
  it('lints valid input', () => expect(lint('# Hello').valid).toBe(true));
  it('returns positioned lint warnings', () => {
    expect(lint(':::')).toMatchObject({
      valid: false,
      warningCount: 1,
      warnings: [{ line: 1, column: 1, rule: 'unclosed-container-fence' }],
    });
  });
  it('previews, applies, and reverses safe diagnostic fixes', () => {
    const source = '::: note\nBody';
    const preview = diagnoseAndFix(source);
    expect(preview).toMatchObject({ warningCount: 1, fixes: [{ applicability: 'automatic' }], appliedFixIds: [], value: source });
    const applied = diagnoseAndFix(source, [], [preview.fixes[0]!.id]);
    expect(applied).toMatchObject({ value: '::: note\nBody\n:::\n', remainingWarningCount: 0, remainingValid: true });
    expect(applied.undoPatch.edits).toHaveLength(1);
    expect(diagnoseAndFix(source, [], [preview.fixes[0]!.id, preview.fixes[0]!.id]).value).toBe('::: note\nBody\n:::\n');
    expect(() => diagnoseAndFix(source, [], ['missing-fix'])).toThrow(/Unknown fix id/);
  });
  it('converts lint UTF-16 positions to UTF-8 patch offsets', () => {
    const source = '😀\u202e text';
    const preview = diagnoseAndFix(source);
    const applied = diagnoseAndFix(source, [], [preview.fixes[0]!.id]);
    expect(applied.value).toBe('😀 text');
    expect(applied.patch.edits[0]).toMatchObject({ start: 4, end: 7, replacement: '' });
  });
  it('refuses to auto-apply writer-review diagnostics', () => {
    const preview = diagnoseAndFix('See </#missing>.');
    expect(preview.fixes[0]).toMatchObject({ applicability: 'writer-review', edit: null });
    expect(() => diagnoseAndFix('See </#missing>.', [], [preview.fixes[0]!.id])).toThrow(/writer review/);
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
    expect(patch.changes).toEqual(expect.arrayContaining([expect.objectContaining({ summary: expect.stringContaining('heading') })]));
    expect(patch.operations).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'replace' })]));
    const applied = applyStructuredAstPatch(before, patch.operations);
    expect(applied.ast).toEqual(expect.objectContaining({ type: 'document', srcByteLength: 0 }));
    expect(applied.source).toContain('After');
    expect(before).toMatchObject({ srcByteLength: 8 });
  });
  it('selects stable semantic nodes and reports ambiguous type matches', () => {
    const ast = parse('# First\n\nText\n\n# Second\n\n[^n]: Note');
    expect(selectAstNodes(ast, { kind: 'heading-id', value: 'First' })).toMatchObject({ matchCount: 1, matches: [{ type: 'heading', identity: 'First', preview: 'First' }] });
    expect(selectAstNodes(ast, { kind: 'footnote-label', value: 'n' })).toMatchObject({ matchCount: 1, matches: [{ type: 'footnote', identity: 'n' }] });
    expect(selectAstNodes(ast, { kind: 'node-type', value: 'heading' }).matchCount).toBe(2);
  });
  it('bounds selectors and reports empty, missing, and truncated results', () => {
    const source = Array.from({ length: 101 }, (_, index) => `# Heading ${index}`).join('\n\n');
    const selected = selectAstNodes(parse(source), { kind: 'node-type', value: 'heading' });
    expect(selected).toMatchObject({ matchCount: 101, truncated: true });
    expect(selected.matches).toHaveLength(100);
    expect(selectAstNodes(parse('# Hello'), { kind: 'heading-id', value: 'missing' })).toMatchObject({ matchCount: 0, matches: [], truncated: false });
    expect(() => selectAstNodes(parse('# Hello'), { kind: 'heading-id', value: '' })).toThrow(/must not be empty/);
    expect(() => selectAstNodes(parse('# Hello'), { kind: 'heading-id', value: 'x'.repeat(257) })).toThrow(/256/);
  });
  it('describes collection changes and keeps explanations human-readable', () => {
    const before = parse('# Heading\n\nFirst\n\nSecond');
    const after = parse('# Heading\n\nFirst');
    const patch = createStructuredAstPatch(before, after);
    expect(patch.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'remove', summary: expect.stringMatching(/^Removed 1 item in/) }),
    ]));
    expect(patch.changes.every(({ target, summary }) => !target.includes('\n') && !summary.includes('\n'))).toBe(true);
    const mixed = createStructuredAstPatch(parse('- a\n- b'), parse('- x\n- b\n- c'));
    expect(mixed.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'replace', summary: expect.stringMatching(/^Changed items on/) }),
    ]));
  });
  it('plans exact, reversible semantic edits without writing', () => {
    const source = '# Before\n\nBody';
    const plan = planSemanticAstEdit(source, { kind: 'heading-id', value: 'Before' }, { kind: 'replace-text', text: 'After' });
    expect(plan).toMatchObject({
      edit: { kind: 'replace-text' }, match: { type: 'heading', identity: 'Before', preview: 'Before' },
      reversiblePatch: { version: 1, changes: expect.any(Array) },
      sourcePatch: { sourceFingerprint: expect.stringMatching(/^fnv1a64:/), edits: expect.any(Array) },
    });
    const applied = applyReversibleStructuredAstPatch(source, plan.reversiblePatch);
    expect(applied.source).toContain('# After');
    expect(applied.source).toContain('{#Before}');
    expect(applyReversibleStructuredAstPatch(applied.source, plan.reversiblePatch, true).source).toContain('# Before');
    expect(plan.notices).toEqual(expect.arrayContaining([expect.stringContaining('Preserved heading ID'), expect.stringContaining('inline formatting')]));

    const renamed = planSemanticAstEdit(source, { kind: 'heading-id', value: 'Before' }, { kind: 'rename-heading-id', id: 'intro' });
    const renamedSource = applyReversibleStructuredAstPatch(source, renamed.reversiblePatch).source;
    expect(renamedSource).toContain('{#intro}');
    expect(applyReversibleStructuredAstPatch(renamedSource, renamed.reversiblePatch, true).source).toContain('# Before');
  });
  it('plans structural semantic edits and rejects unsafe selection', () => {
    const paragraph = { type: 'paragraph', children: [{ type: 'text', value: 'New' }] };
    const deleted = planSemanticAstEdit('# Title\n\nBody', { kind: 'node-type', value: 'paragraph' }, { kind: 'delete-node' });
    expect(applyReversibleStructuredAstPatch('# Title\n\nBody', deleted.reversiblePatch).source).not.toContain('Body');
    const replaced = planSemanticAstEdit('# Title\n\nBody', { kind: 'node-type', value: 'paragraph' }, { kind: 'replace-node', node: paragraph });
    expect(applyReversibleStructuredAstPatch('# Title\n\nBody', replaced.reversiblePatch).source).toContain('New');
    const inserted = planSemanticAstEdit('# Title', { kind: 'heading-id', value: 'Title' }, { kind: 'insert-after', node: paragraph });
    expect(applyReversibleStructuredAstPatch('# Title', inserted.reversiblePatch).source).toContain('New');
    const insertedBefore = planSemanticAstEdit('# Title', { kind: 'heading-id', value: 'Title' }, { kind: 'insert-before', node: paragraph });
    expect(applyReversibleStructuredAstPatch('# Title', insertedBefore.reversiblePatch).source.startsWith('New')).toBe(true);
    expect(() => planSemanticAstEdit('# A\n\n# B', { kind: 'node-type', value: 'heading' }, { kind: 'delete-node' })).toThrow(/matched 2/);
    const byPath = planSemanticAstEdit('# A\n\n# B', { kind: 'ast-path', value: '/children/1' }, { kind: 'delete-node' });
    expect(applyReversibleStructuredAstPatch('# A\n\n# B', byPath.reversiblePatch).source).not.toContain('# B');
    expect(() => planSemanticAstEdit('# A', { kind: 'heading-id', value: 'missing' }, { kind: 'delete-node' })).toThrow(/did not match/);
    expect(() => planSemanticAstEdit('# A\n\n# B', { kind: 'heading-id', value: 'A' }, { kind: 'rename-heading-id', id: 'B' })).toThrow(/already in use/);
    expect(() => planSemanticAstEdit('Text[^a]\n\n[^a]: Note\n', { kind: 'footnote-label', value: 'a' }, { kind: 'delete-node' })).toThrow(/references remain/);
    expect(() => planSemanticAstEdit('Body', { kind: 'node-type', value: 'paragraph' }, { kind: 'replace-text', text: 'a\n\nb' })).toThrow(/line breaks/);
    expect(() => planSemanticAstEdit('# A', { kind: 'heading-id', value: 'A' }, { kind: 'delete-node', text: 'ignored' } as never)).toThrow(/does not accept text/);
    expect(() => planSemanticAstEdit('# A', { kind: 'heading-id', value: 'A' }, { kind: 'replace-text', text: 'A' })).toThrow(/would not change/);
    expect(() => planSemanticAstEdit('# A', { kind: 'heading-id', value: 'A' }, { kind: 'rename-heading-id', id: 'bad\nid' })).toThrow(/control characters/);
  });
  it('plans edits for source documents larger than their positioned AST limit', () => {
    const source = 'a'.repeat(200_000);
    const plan = planSemanticAstEdit(source, { kind: 'node-type', value: 'paragraph' }, { kind: 'replace-text', text: 'Short' });
    expect(plan.sourcePatch.sourceBytes).toBe(200_000);
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
  it('creates, applies, and reverses stale-guarded AST patches as source edits', () => {
    const beforeSource = '# Before\n\nBody   \n';
    const before = parse(beforeSource);
    const after = parse('# After\n\nBody   \n');
    const patch = createReversibleStructuredAstPatch(before, after);
    expect(patch).toMatchObject({ version: 1, beforeFingerprint: expect.stringMatching(/^fnv1a64:/), forward: expect.any(Array), inverse: expect.any(Array) });
    const applied = applyReversibleStructuredAstPatch(beforeSource, patch);
    expect(applied).toMatchObject({ direction: 'forward', source: expect.stringContaining('# After'), sourcePatch: { sourceFingerprint: expect.stringMatching(/^fnv1a64:/), edits: expect.any(Array) } });
    const reverted = applyReversibleStructuredAstPatch(applied.source, patch, true);
    expect(reverted.source).toContain('# Before');
    expect(() => applyReversibleStructuredAstPatch('# Stale', patch)).toThrow(/precondition/);
    expect(() => applyReversibleStructuredAstPatch(beforeSource, { ...patch, forward: [] })).toThrow(/postcondition/);
    expect(() => applyReversibleStructuredAstPatch(beforeSource, { ...patch, inverse: [] })).toThrow(/reverse direction/);
    const { changes: _changes, ...legacyPatch } = patch;
    expect(applyReversibleStructuredAstPatch(beforeSource, legacyPatch).source).toContain('# After');
  });
  it('fingerprints author keyValues without treating their type as an AST node', () => {
    const first = parse('[x]{type=widget pos=1}');
    const second = parse('[x]{type=widget pos=2}');
    const fingerprints = createReversibleStructuredAstPatch(first, second);
    expect(fingerprints.beforeFingerprint).not.toBe(fingerprints.afterFingerprint);
    const patch = createReversibleStructuredAstPatch(first, parse('[y]{type=widget pos=1}'));
    expect(() => applyReversibleStructuredAstPatch('[x]{type=widget pos=2}', patch)).toThrow(/precondition/);
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
