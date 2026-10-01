import { describe, expect, it } from 'vitest';
import { cargoPackage, cargoLockPackages, assertRegistryRustDependencies, immutableGithubPin } from './rust-release-contract.mjs';
import { validateBudgetScenario, assertBudgetToolNames } from './schema-budget-contract.mjs';

const sha = 'a'.repeat(40);
const manifest = '[package]\nname = "carve-mcp"\nversion = "0.1.6"\n\n[dependencies]\nrmcp = { version = "3.2.0" }\n';
const root = '[[package]]\nname = "carve-mcp"\nversion = "0.1.6"\n';
const entry = (name, source) => `[[package]]\nname = "${name}"\nversion = "0.1.7"\n${source ? `source = "${source}"\n` : ''}`;

describe('Rust release gates', () => {
  it('reads the package version without accepting a dependency version', () => {
    expect(cargoPackage(manifest).version).toBe('0.1.6');
    expect(cargoPackage(manifest.replace('version = "0.1.6"', 'version = "9.9.9"')).version).toBe('9.9.9');
    expect(() => cargoPackage('[dependencies]\nrmcp = { version = "3.2.0" }')).toThrow('[package]');
  });
  it('bounds each lock package to its own block', () => {
    const packages = cargoLockPackages(root + entry('carve-lang', 'registry+https://github.com/rust-lang/crates.io-index')
      + entry('regex', `git+https://github.com/rust-lang/regex?rev=${sha}#${sha}`));
    expect(packages.find(({ name }) => name === 'carve-lang')?.source).toBe('registry+https://github.com/rust-lang/crates.io-index');
  });
  it.each([undefined, `git+https://github.com/markup-carve/carve-rs?branch=main#${sha}`])('rejects a non-registry lock source: %s', (source) => {
    expect(() => assertRegistryRustDependencies(manifest, root + entry('carve-lang', source))).toThrow('registry versions');
  });
  it('allows only the root package to omit a registry source', () => {
    expect(() => assertRegistryRustDependencies(manifest, root + entry('carve-lang', 'registry+https://github.com/rust-lang/crates.io-index'))).not.toThrow();
  });
  it.each([`?branch=main#${sha}`, `?tag=v0.1.7#${sha}`, `#${sha}`, `?rev=main#${sha}`])('rejects a mutable Git source: %s', (suffix) => {
    expect(() => immutableGithubPin(`git+https://github.com/markup-carve/carve-rs${suffix}`)).toThrow();
  });
  it('accepts an explicit immutable Git commit for ancestry verification', () => {
    expect(immutableGithubPin(`git+https://github.com/markup-carve/carve-rs.git?rev=${sha}#${sha}`))
      .toEqual({ repository: 'markup-carve/carve-rs', revision: sha });
  });
});

describe('schema budget gates', () => {
  const scenario = { label: 'review', profile: 'review', maximum: 3100, tools: ['carve_lint'], workspace: false };
  it.each([undefined, '3100', 0, -1, Number.NaN, Infinity])('rejects a missing or invalid threshold: %s', (maximum) => {
    expect(() => validateBudgetScenario({ ...scenario, maximum }, ['review'])).toThrow('numeric maximum');
  });
  it('requires an explicit unique tool list', () => {
    expect(() => validateBudgetScenario({ ...scenario, tools: undefined }, ['review'])).toThrow('expected tool names');
    expect(() => validateBudgetScenario({ ...scenario, tools: ['carve_lint', 'carve_lint'] }, ['review'])).toThrow('expected tool names');
    expect(() => validateBudgetScenario(scenario, ['review'])).not.toThrow();
  });
  it('rejects both a removed tool and an added tool', () => {
    expect(() => assertBudgetToolNames('structure', ['carve_parse', 'carve_select_ast_nodes'], ['carve_parse'])).toThrow('missing carve_select_ast_nodes');
    expect(() => assertBudgetToolNames('structure', ['carve_parse'], ['carve_parse', 'carve_new_tool'])).toThrow('unexpected carve_new_tool');
    expect(() => assertBudgetToolNames('structure', ['carve_parse', 'carve_select_ast_nodes'], ['carve_select_ast_nodes', 'carve_parse'])).not.toThrow();
  });
});
