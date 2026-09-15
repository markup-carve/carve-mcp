import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  .filter(({ kind, source }) => kind === null && !(source ?? '').startsWith('registry+'))
  .map(({ name, source }) => `${name} (${source ?? 'path'})`);

if (unresolvable.length > 0) {
  console.log(`Skipping cargo package; these resolve outside the registry: ${unresolvable.join(', ')}.`);
  process.exit(0);
}

run(['package', '--manifest-path', 'rust/Cargo.toml', '--locked'], { stdio: 'inherit' });
