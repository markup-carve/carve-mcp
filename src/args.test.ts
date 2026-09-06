import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

describe('workspace CLI', () => {
  it('parses roots and defaults', () => expect(parseArgs(['--root=/tmp/project', '--allow-write'])).toEqual({
    roots: ['/tmp/project'], allowWrite: true, http: false, host: '127.0.0.1', port: 3000, config: undefined,
  }));
  it('accepts a project configuration path', () => expect(parseArgs(['--config', './carve-mcp.json'])).toMatchObject({ config: './carve-mcp.json' }));
  it('parses HTTP configuration', () => expect(parseArgs(['--http', '--host', '0.0.0.0', '--port', '8080'])).toMatchObject({ http: true, host: '0.0.0.0', port: 8080 }));
  it('rejects missing, relative, and rootless write options', () => {
    expect(() => parseArgs(['--root', '--allow-write'])).toThrow(/requires/);
    expect(() => parseArgs(['--root', 'relative'])).toThrow(/absolute/);
    expect(() => parseArgs(['--config='])).toThrow(/requires/);
  });
});
