import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CRATES_IO_SOURCE } from './rust-release-contract.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const run = (args, options = {}) => execFileSync('cargo', args, { cwd: repository, ...options });

const metadata = JSON.parse(run(
  ['metadata', '--manifest-path', 'rust/Cargo.toml', '--format-version', '1', '--no-deps'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
));
const [crate] = metadata.packages;
if (!crate) throw new Error('cargo metadata reported no package for rust/Cargo.toml.');

// cargo drops a git or path source when it writes the packaged manifest, so the
// verify build resolves that dependency from the registry, against a release
// that need not carry the API this crate calls.
const unresolvable = crate.dependencies
  .filter(({ kind, source }) => (kind === null || kind === 'build') && source !== CRATES_IO_SOURCE)
  .map(({ name, source }) => `${name} (${source ?? 'path'})`);

if (unresolvable.length > 0) {
  throw new Error(`Rust package dependencies must use crates.io registry versions: ${unresolvable.join(', ')}.`);
}

run(['package', '--manifest-path', 'rust/Cargo.toml', '--locked'], { stdio: 'inherit' });
