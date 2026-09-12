import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
const rustInstalled = /^name = "carve-lang"\nversion = "([^"]+)"$/m.exec(cargoLock)?.[1];
if (!rustInstalled) throw new Error('rust/Cargo.lock does not pin carve-lang.');

let rustLatest;
try {
  const response = await fetch('https://crates.io/api/v1/crates/carve-lang', {
    headers: { 'user-agent': 'carve-mcp engine drift check' },
  });
  if (!response.ok) throw new Error(`crates.io returned HTTP ${response.status}.`);
  rustLatest = (await response.json()).crate?.default_version;
} catch (error) {
  problems.push(`Could not query crates.io for the newest carve-lang version: ${error.message}`);
}
if (rustLatest !== undefined && (typeof rustLatest !== 'string' || !rustLatest)) {
  problems.push('crates.io returned no published carve-lang version.');
} else if (rustLatest) {
  console.log(`Rust engine: ${rustInstalled}; newest published: ${rustLatest}`);
  if (rustInstalled !== rustLatest) {
    problems.push(`carve-lang ${rustLatest} is published; update and verify the MCP from ${rustInstalled}.`);
  }
}

if (problems.length > 0) throw new Error(problems.join('\n'));
