import { describe, expect, it } from 'vitest';
import { findRule, ruleIds, ruleMarkdown } from './resources.js';

describe('released rule index', () => {
  // Carve 0.2 numbers its normative clauses C2-<part>-NNN; the 0.1 CARVE-P* ids are gone (spec/0.2 README).
  it('serves the clauses of the vendored 0.2 specification', () => {
    expect(ruleIds.length).toBeGreaterThanOrEqual(1000);
    expect(findRule('C2-A-053')).toMatchObject({
      id: 'C2-A-053',
      document: 'ast.md',
    });
    expect(ruleMarkdown('C2-A-053')).toContain('`list_item`');
    expect(findRule('CARVE-P12-054')).toBeUndefined();
  });
});
