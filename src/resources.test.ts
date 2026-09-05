import { describe, expect, it } from 'vitest';
import { LIB_VERSION, SPEC_VERSION } from '@markup-carve/carve';
import { authoringGuide, findRule, ruleIds, ruleIndexMarkdown, ruleMarkdown } from './resources.js';
import { lintRuleMarkdown, lintRuleNames } from './lint-rules.js';

describe('documentation resources', () => {
  it('keeps the quick start concise and task focused', () => {
    expect(authoringGuide.length).toBeLessThan(3_000);
    expect(authoringGuide).toContain('Everyday text');
    expect(authoringGuide).toContain('Good defaults');
    expect(authoringGuide).toContain(`specification ${SPEC_VERSION}`);
    expect(authoringGuide).toContain(`engine ${LIB_VERSION}`);
  });

  it('documents every stable lint diagnostic name', () => {
    expect(lintRuleNames).toHaveLength(24);
    expect(lintRuleNames).toEqual(expect.arrayContaining(['platform-mention-token', 'platform-issue-reference']));
    expect(lintRuleMarkdown('unclosed-container-fence')).toContain('without a closer');
    expect(lintRuleMarkdown('constructor')).toBeUndefined();
    expect(lintRuleMarkdown('__proto__')).toBeUndefined();
  });

  it('indexes every active and retired rule exactly once', () => {
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    expect(ruleIds.length).toBeGreaterThan(200);
  });

  it('looks up stable IDs case-insensitively', () => {
    expect(findRule('carve-p0-001')).toMatchObject({ id: 'CARVE-P0-001', scope: 'parsing' });
    expect(ruleMarkdown('CARVE-PRE-001')).toContain('retired');
    expect(ruleMarkdown('CARVE-PRE-001')).toContain('https://github.com/markup-carve/carve/');
    expect(ruleMarkdown('NOT-A-RULE')).toBeUndefined();
  });

  it('links readers to the full human-readable rule views', () => {
    expect(ruleIndexMarkdown()).toContain('https://markup-carve.github.io/carve/rules/parsing');
    expect(ruleIndexMarkdown()).toContain('diagnostic namespace');
  });
});
