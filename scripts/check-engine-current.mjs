import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cargoLockPackages, immutableGithubPin, CRATES_IO_SOURCE } from './rust-release-contract.mjs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const installed = lock.packages?.['node_modules/@markup-carve/carve']?.version;
if (typeof installed !== 'string') {
  throw new Error('package-lock.json does not pin @markup-carve/carve.');
}

const problems = [];
let latest;
try {
  latest = execFileSync('npm', ['view', '@markup-carve/carve', 'version'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch (error) {
  problems.push(`Could not query npm for the newest @markup-carve/carve version: ${error.message}`);
}
if (latest === '') problems.push('npm returned no published @markup-carve/carve version.');
if (latest) {
  console.log(`JavaScript engine: ${installed}; newest published: ${latest}`);
  if (installed !== latest) {
    problems.push(`@markup-carve/carve ${latest} is published; update and verify the MCP from ${installed}.`);
  }
}

const cargoLock = readFileSync(new URL('../rust/Cargo.lock', import.meta.url), 'utf8');
const rustEngine = cargoLockPackages(cargoLock).find(({ name }) => name === 'carve-lang');
if (!rustEngine) throw new Error('rust/Cargo.lock does not pin carve-lang.');
const rustInstalled = rustEngine.version;

let rustLatest;
try {
  const response = await fetch('https://crates.io/api/v1/crates/carve-lang', {
    headers: { 'user-agent': 'carve-mcp engine drift check' },
  });
  if (!response.ok) throw new Error(`crates.io returned HTTP ${response.status}.`);
  rustLatest = (await response.json()).crate?.default_version;
  if (typeof rustLatest !== 'string' || !rustLatest.trim()) {
    throw new Error('crates.io returned no published carve-lang version.');
  }
} catch (error) {
  rustLatest = undefined;
  problems.push(`Could not query crates.io for the newest carve-lang version: ${error.message}`);
}
if (rustLatest) {
  console.log(`Rust engine: ${rustInstalled}; newest published: ${rustLatest}`);
  if (rustInstalled !== rustLatest) {
    problems.push(`carve-lang ${rustLatest} is published; update and verify the MCP from ${rustInstalled}.`);
  }
}

// The lock reports the engine's own version whatever the source is, so the
// comparison above cannot see a git pin left on a squash-merged branch head.
if (rustEngine.source?.startsWith('git+')) {
  const { repository, revision } = immutableGithubPin(rustEngine.source);
  console.log(`Rust engine source: ${repository}@${revision.slice(0, 10)}`);
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/compare/main...${revision}`, {
      headers: { 'user-agent': 'carve-mcp engine drift check', accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    const { status } = await response.json();
    if (status !== 'identical' && status !== 'behind') {
      problems.push(`${repository}@${revision.slice(0, 10)} is not reachable from main (${status}); repin to a commit on main.`);
    }
  } catch (error) {
    problems.push(`Could not check whether ${repository}@${revision.slice(0, 10)} is on main: ${error.message}`);
  }
}

if (rustEngine.source !== CRATES_IO_SOURCE && !rustEngine.source?.startsWith('git+')) {
  problems.push('Rust engine must be pinned to a crates.io release or an immutable Git commit.');
}

if (problems.length > 0) throw new Error(problems.join('\n'));
