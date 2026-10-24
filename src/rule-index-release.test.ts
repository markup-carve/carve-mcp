import { describe, expect, it } from 'vitest';
import { findRule, ruleIds, ruleMarkdown } from './resources.js';

describe('released rule index', () => {
  it('serves rules added by the 0.1.11 specification', () => {
    expect(ruleIds.length).toBeGreaterThanOrEqual(347);
    expect(findRule('CARVE-P12-054')).toMatchObject({
      id: 'CARVE-P12-054',
      scope: 'ast-interchange',
    });
    expect(ruleMarkdown('CARVE-P9-071')).toContain('THE MEDIA TYPE AND THE FILE EXTENSION');
  });
});
