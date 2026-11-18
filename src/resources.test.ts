import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, SPEC_VERSION } from './engine.js';
import { authoringGuide, findRule, ruleIds, ruleIndexMarkdown, ruleMarkdown, specDocument, specDocumentNames, upgradeEntryIds, upgradeEntryMarkdown, upgradeMapMarkdown } from './resources.js';
import { lintRuleMarkdown, lintRuleNames } from './lint-rules.js';
import { lint, render } from './tools.js';

describe('documentation resources', () => {
  it('keeps the quick start concise and task focused', () => {
    expect(authoringGuide.length).toBeLessThan(3_000);
    expect(authoringGuide).toContain('Everyday text');
    expect(authoringGuide).toContain('Good defaults');
    expect(authoringGuide).toContain(`specification ${SPEC_VERSION}`);
    expect(authoringGuide).toContain(`engine ${ENGINE_VERSION}`);
  });

  it('teaches spellings that render as the guide says in 0.2', () => {
    expect(render('{_u_} {~s~} {=m=}', 'html').value).toBe('<p><u>u</u> <s>s</s> <mark>m</mark></p>');
    expect(lint('{_u_} {~s~}\n').warningCount).toBe(0);
    expect(render('= A heading', 'html').value).toContain('<h1>A heading</h1>');
  });

  it('documents every 0.2 lint diagnostic name', () => {
    expect(lintRuleNames.length).toBeGreaterThan(150);
    expect(lintRuleNames).toEqual(expect.arrayContaining([
      'platform-mention-token', 'platform-issue-reference', 'unclosed-container-fence', 'deprecated-bare-underline', 'a11y/image-alt',
    ]));
    expect(lintRuleMarkdown('unclosed-container-fence')).toContain('Severity');
    expect(lintRuleMarkdown('constructor')).toBeUndefined();
    expect(lintRuleMarkdown('__proto__')).toBeUndefined();
  });

  it('resolves the resource of every warning carve_lint returns', () => {
    const documents = ['= Title {#x}\n', '>quote\n', '[a]:\n', '[x](#nope)\n', '{{}}\n', 'a\n\n---\n', '_word_\n', ':::\n'];
    const rules = documents.flatMap((document) => lint(document).warnings.map((warning) => warning.rule));
    expect(rules).toHaveLength(documents.length);
    for (const rule of rules) expect(lintRuleMarkdown(rule), rule).toBeDefined();
  });

  it('indexes every 0.2 clause exactly once', () => {
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    expect(ruleIds.length).toBeGreaterThan(1_000);
  });

  it('looks up clause IDs case-insensitively', () => {
    expect(findRule('c2-t-005')).toMatchObject({ id: 'C2-T-005', document: 'tooling.md' });
    expect(ruleMarkdown('C2-T-005')).toContain('https://github.com/markup-carve/carve/blob/');
    expect(ruleMarkdown('NOT-A-RULE')).toBeUndefined();
  });

  it('links readers to the clause documents', () => {
    expect(ruleIndexMarkdown()).toContain('carve://spec/syntax-blocks');
    expect(ruleIndexMarkdown()).toContain('diagnostic namespace');
  });

  it('serves the vendored specification and upgrade map', () => {
    expect(specDocumentNames).toEqual(expect.arrayContaining(['UPGRADING', 'syntax-blocks', 'tooling']));
    expect(specDocument('tooling')).toContain('C2-T-005');
    expect(specDocument('../package')).toBeUndefined();
    expect(upgradeEntryIds).toEqual(expect.arrayContaining(['U-001', 'T-001']));
    expect(upgradeMapMarkdown()).toContain('| U-001 |');
    expect(upgradeEntryMarkdown('u-001')).toContain('Before (0.1)');
    expect(upgradeEntryMarkdown('U-999999')).toBeUndefined();
  });
});
