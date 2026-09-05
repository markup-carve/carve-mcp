import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

describe('workspace CLI', () => {
  it('parses roots and write permission', () => expect(parseArgs(['--root=/tmp/project', '--allow-write'])).toEqual({ roots: ['/tmp/project'], allowWrite: true }));
  it('rejects missing, relative, and rootless write options', () => {
    expect(() => parseArgs(['--root', '--allow-write'])).toThrow(/requires/);
    expect(() => parseArgs(['--root', 'relative'])).toThrow(/absolute/);
    expect(() => parseArgs(['--allow-write'])).toThrow(/requires/);
  });
});
