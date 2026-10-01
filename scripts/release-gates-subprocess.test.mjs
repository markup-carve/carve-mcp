import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = fileURLToPath(new URL('..', import.meta.url));
const directories = [];
const sha = 'a'.repeat(40);
const root = '[[package]]\nname = "carve-mcp"\nversion = "0.1.6"\n';
const entry = (name, source) => `[[package]]\nname = "${name}"\nversion = "0.1.7"\n${source ? `source = "${source}"\n` : ''}`;
const registry = 'registry+https://github.com/rust-lang/crates.io-index';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'carve-mcp-gates-'));
  directories.push(directory);
  for (const folder of ['scripts', 'rust', 'dist']) mkdirSync(join(directory, folder));
  symlinkSync(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir');
  for (const file of ['check-engine-current.mjs', 'check-rust-package.mjs', 'release-check.mjs', 'rust-release-contract.mjs', 'release-contract.mjs']) {
    copyFileSync(join(repository, 'scripts', file), join(directory, 'scripts', file));
  }
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@markup-carve/carve': { version: '0.1.9' } } }));
  writeFileSync(join(directory, 'rust', 'Cargo.toml'), readFileSync(join(repository, 'rust', 'Cargo.toml'), 'utf8'));
  writeFileSync(join(directory, 'package.json'), readFileSync(join(repository, 'package.json'), 'utf8'));
  copyFileSync(join(repository, 'server.json'), join(directory, 'server.json'));
  writeFileSync(join(directory, 'dist', 'tool-profile.js'), 'export const DOCUMENT_TOOLS = [];\n');
  writeFileSync(join(directory, 'stub.mjs'), `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.execFileSync = (command, args) => {
      if (command === 'npm' && args[0] === 'view') return '0.1.9\\n';
      if (command === 'cargo' && args[0] === 'metadata') return JSON.stringify({ packages: [{ dependencies: JSON.parse(process.env.GATE_DEPENDENCIES ?? '[]') }] });
      if (command === 'cargo' && args[0] === 'package') { console.log('PACKAGE_VERIFIED'); return Buffer.from(''); }
      throw new Error('REACHED_EXTERNAL_COMMAND');
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (url) => {
      if (url.startsWith('https://crates.io/')) return { ok: true, json: async () => JSON.parse(process.env.GATE_REGISTRY ?? '{"crate":{"default_version":"0.1.7"}}') };
      console.log('ANCESTRY_CHECK ' + url);
      return { ok: true, json: async () => ({ status: 'behind' }) };
    };
  `);
  return directory;
}
function run(directory, script, environment = {}) {
  const env = { ...process.env, ...environment };
  delete env.REQUIRE_RELEASE_TAG;
  delete env.RELEASE_TAG;
  return spawnSync(process.execPath, ['--import', join(directory, 'stub.mjs'), join(directory, 'scripts', script)], {
    encoding: 'utf8', env, timeout: 10000,
  });
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('release gate subprocess regressions', () => {
  it.each(['git+https://github.com/markup-carve/carve-rs?branch=main#' + sha, null])('fails package verification instead of skipping a non-registry dependency: %s', (source) => {
    const result = run(fixture(), 'check-rust-package.mjs', { GATE_DEPENDENCIES: JSON.stringify([{ name: 'carve-lang', kind: null, source }]) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must use registry versions');
    expect(result.stdout).not.toContain('PACKAGE_VERIFIED');
  });
  it('still verifies a registry package', () => {
    const result = run(fixture(), 'check-rust-package.mjs', { GATE_DEPENDENCIES: JSON.stringify([{ name: 'carve-lang', kind: null, source: registry }]) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PACKAGE_VERIFIED');
  });
  it.each(['?branch=main#' + sha, '?tag=v0.1.7#' + sha, '#' + sha])('rejects a mutable engine source: %s', (suffix) => {
    const directory = fixture();
    writeFileSync(join(directory, 'rust', 'Cargo.lock'), root + entry('carve-lang', 'git+https://github.com/markup-carve/carve-rs' + suffix));
    const result = run(directory, 'check-engine-current.mjs');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('immutable rev');
  });
  it('does not attribute a later package Git source to carve-lang', () => {
    const directory = fixture();
    writeFileSync(join(directory, 'rust', 'Cargo.lock'), root + entry('carve-lang', registry)
      + entry('regex', `git+https://github.com/rust-lang/regex?rev=${sha}#${sha}`));
    const result = run(directory, 'check-engine-current.mjs');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('ANCESTRY_CHECK');
    expect(result.stdout).not.toContain('Rust engine source:');
  });
  it('checks the actual immutable engine revision against main', () => {
    const directory = fixture();
    writeFileSync(join(directory, 'rust', 'Cargo.lock'), root + entry('carve-lang', `git+https://github.com/markup-carve/carve-rs?rev=${sha}#${sha}`));
    const result = run(directory, 'check-engine-current.mjs');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`compare/main...${sha}`);
  });
  it.each(['{}', '{"crate":{"max_stable_version":"9.9.9"}}'])('rejects a registry response without default_version: %s', (response) => {
    const directory = fixture();
    writeFileSync(join(directory, 'rust', 'Cargo.lock'), root + entry('carve-lang', registry));
    const result = run(directory, 'check-engine-current.mjs', { GATE_REGISTRY: response });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no published carve-lang version');
  });
  it.each([undefined, `git+https://github.com/markup-carve/carve-rs?rev=${sha}#${sha}`])('rejects non-registry dependencies outside tag-time runs: %s', (source) => {
    const directory = fixture();
    writeFileSync(join(directory, 'rust', 'Cargo.lock'), root + entry('carve-lang', source));
    const result = run(directory, 'release-check.mjs');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Rust release dependencies must use registry versions');
    expect(result.stderr).not.toContain('REACHED_EXTERNAL_COMMAND');
  });
  it('rejects a package-version mismatch even when a dependency matches npm', () => {
    const directory = fixture();
    const manifest = readFileSync(join(directory, 'rust', 'Cargo.toml'), 'utf8').replace('version = "0.1.6"', 'version = "9.9.9"');
    writeFileSync(join(directory, 'rust', 'Cargo.toml'), manifest);
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    pkg.version = '3.2.0';
    writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg));
    const server = JSON.parse(readFileSync(join(directory, 'server.json'), 'utf8'));
    server.version = server.packages[0].version = '3.2.0';
    writeFileSync(join(directory, 'server.json'), JSON.stringify(server));
    writeFileSync(join(directory, 'rust', 'Cargo.lock'), root + entry('carve-lang', registry));
    const result = run(directory, 'release-check.mjs');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Rust and npm package versions must match');
  });
});
