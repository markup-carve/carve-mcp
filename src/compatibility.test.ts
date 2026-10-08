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

  it('is not lossy where no destination is emitted', () => {
    // Plain text drops destinations outright, so nothing is blanked. Canonical
    // Carve keeps the denied destination verbatim (markup-carve/carve#2438), so
    // reporting a loss there would be wrong.
    expect(verdict('plain')).toStrictEqual({ status: 'compatible', lossCount: 0, codes: [] });
  });
});
