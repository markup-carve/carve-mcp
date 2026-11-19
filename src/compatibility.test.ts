import { describe, expect, it } from 'vitest';
import { compatibilityMatrix, type CompatibilityTarget } from './compatibility.js';

/**
 * Engine 0.1.10 records a `destination-denied` render loss wherever it blanks a
 * URL scheme PART 9 §25 denies. The output bytes did not change, so the only way
 * this server can see the blanking is the loss report it already forwards, and
 * the only way a caller sees it is this verdict.
 */
describe('a denied destination scheme', () => {
  const source = '[x](javascript:alert(1))\n\n<javascript:alert(1)>\n\n![a](javascript:alert(1))\n';
  const verdict = (target: CompatibilityTarget) => {
    const [result] = compatibilityMatrix(source, [target]).targets;
    return { status: result!.status, lossCount: result!.lossCount,
      codes: (result!.losses as Array<{ code: string }>).map(({ code }) => code) };
  };

  it('is lossy on every target that emits a destination', () => {
    // Three destinations reach HTML and Markdown; ANSI emits one, for the link.
    expect(verdict('html')).toStrictEqual({ status: 'lossy', lossCount: 3,
      codes: ['destination-denied', 'destination-denied', 'destination-denied'] });
    expect(verdict('markdown')).toStrictEqual({ status: 'lossy', lossCount: 3,
      codes: ['destination-denied', 'destination-denied', 'destination-denied'] });
    expect(verdict('ansi')).toStrictEqual({ status: 'lossy', lossCount: 1, codes: ['destination-denied'] });
  });

  it('reports no loss where no destination is emitted', () => {
    // Plain text drops destinations outright, so nothing is blanked. Canonical
    // Carve keeps the denied destination verbatim (markup-carve/carve#2438), so
    // reporting a loss there would be wrong.
    expect(verdict('plain')).toMatchObject({ lossCount: 0, codes: [] });
  });

  it.skip('is compatible where no destination is emitted (lint reads the denied autolink as bare-html-tag, markup-carve/carve-js#5081)', () => {
    expect(verdict('plain')).toStrictEqual({ status: 'compatible', lossCount: 0, codes: [] });
  });
});

// carve-js #3525: a header's default alignment covers only its starting
// column, so the cell under a colspan placeholder renders unaligned.
describe('a header colspan with alignment', () => {
  it('reports only the merge, not an alignment loss in the covered column', () => {
    // 0.2 has no table-structure-v1 preservation report; the Markdown export reports the merge as a render loss.
    const [result] = compatibilityMatrix('|={>} Wide|<|={~} Last|\n|a|b|c|\n', ['markdown']).targets;
    expect((result!.losses as Array<{ code: string; path: string }>).map(({ path, code }) => `${path} ${code}`))
      .toStrictEqual(['/children/0/children/0/children/0/children/0 table-span-flattened']);
  });
  it.skip('names the merge in the table-structure-v1 preservation report (0.1 report with no 0.2 counterpart)', () => {
    // U-056 and C2-A-053: 0.2 braces the alignment mark and holds table rows and cells in `children`.
    const [result] = compatibilityMatrix('|={>} Wide|<|={~} Last|\n|a|b|c|\n', ['markdown']).targets;
    const { preservation } = result as unknown as { preservation: { diagnostics: Array<{ path: string; field: string }> } };
    expect(preservation.diagnostics.map(({ path, field }) => `${path} ${field}`))
      .toStrictEqual(['/children/0/children/0/children/0/children/0 colspan']);
  });
});

describe('target warnings', () => {
  it('link each warning to its lint rule resource, as carve_lint does', () => {
    const [result] = compatibilityMatrix('[x](#nope)\n', ['markdown']).targets;
    expect(result!.warnings).toEqual([expect.objectContaining({
      rule: 'broken-fragment-link', resourceUri: 'carve://lint-rules/broken-fragment-link' })]);
  });
});
