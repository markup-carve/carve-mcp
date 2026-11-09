import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cargoLockPackages, immutableGithubPin, CRATES_IO_SOURCE } from './rust-release-contract.mjs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const jsEngine = lock.packages?.['node_modules/@markup-carve/carve'];
const installed = jsEngine?.version;
if (typeof installed !== 'string') {
  throw new Error('package-lock.json does not pin @markup-carve/carve.');
}

// A git pin of a merged engine commit may carry a version newer than the last
// release, so it is stale only once a release overtakes it.
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(/[-+]/)[0].split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const stale = (pinned, published, git) => (git ? newer(published, pinned) : pinned !== published);

async function checkOnMain(repository, revision) {
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

const problems = [];
const jsGit = /^git\+[^#]*github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?#([0-9a-f]{40})$/.exec(jsEngine.resolved ?? '');
if (jsEngine.resolved?.startsWith('git') && !jsGit) {
  problems.push('@markup-carve/carve must resolve from npm or an immutable GitHub commit.');
}
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
  if (stale(installed, latest, Boolean(jsGit))) {
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
  if (stale(rustInstalled, rustLatest, Boolean(rustEngine.source?.startsWith('git+')))) {
    problems.push(`carve-lang ${rustLatest} is published; update and verify the MCP from ${rustInstalled}.`);
  }
}

// The lock reports the engine's own version whatever the source is, so the
// comparison above cannot see a git pin left on a squash-merged branch head.
if (rustEngine.source?.startsWith('git+')) {
  const { repository, revision } = immutableGithubPin(rustEngine.source);
  console.log(`Rust engine source: ${repository}@${revision.slice(0, 10)}`);
  await checkOnMain(repository, revision);
}
if (jsGit) {
  console.log(`JavaScript engine source: ${jsGit[1]}@${jsGit[2].slice(0, 10)}`);
  await checkOnMain(jsGit[1], jsGit[2]);
}

if (rustEngine.source !== CRATES_IO_SOURCE && !rustEngine.source?.startsWith('git+')) {
  problems.push('Rust engine must be pinned to a crates.io release or an immutable Git commit.');
}

if (problems.length > 0) throw new Error(problems.join('\n'));
