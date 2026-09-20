import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DOCUMENT_TOOLS } from '../dist/tool-profile.js';
import { describeContractDrift } from './release-contract.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const registry = JSON.parse(await readFile(new URL('../server.json', import.meta.url), 'utf8'));
const cargo = await readFile(new URL('../rust/Cargo.toml', import.meta.url), 'utf8');
const cargoLock = await readFile(new URL('../rust/Cargo.lock', import.meta.url), 'utf8');
const releaseVersion = process.env.RELEASE_TAG?.replace(/^v/, '');
const releaseRun = process.env.REQUIRE_RELEASE_TAG === '1';

if (releaseRun) {
  if (!releaseVersion) throw new Error('RELEASE_TAG is required in a release run.');
  const runtimeDependencies = { ...pkg.dependencies, ...pkg.optionalDependencies };
  const nonRegistryDependencies = Object.entries(runtimeDependencies)
    .filter(([, spec]) => typeof spec === 'string'
      && (/^(git(\+|:)|github:|gitlab:|bitbucket:|gist:|file:|link:|https?:)/.test(spec)
        || /^[^@\s][^\s]*\/[^\s]+/.test(spec) || spec.includes('#')))
    .map(([name]) => name);
  if (nonRegistryDependencies.length > 0) {
    throw new Error(`Release dependencies must use registry versions: ${nonRegistryDependencies.join(', ')}.`);
  }
  // cargo drops a git source from the packaged manifest, so a crate carrying
  // one cannot be verified against what crates.io would serve.
  const cargoPins = [...cargoLock.matchAll(/^name = "([^"]+)"\nversion = "[^"]+"\nsource = "git\+/gm)]
    .map(([, name]) => name);
  if (cargoPins.length > 0) {
    throw new Error(`Rust release dependencies must use registry versions: ${cargoPins.join(', ')}.`);
  }
}
if (releaseVersion && releaseVersion !== pkg.version) {
  throw new Error(`Release tag ${process.env.RELEASE_TAG} does not match package version ${pkg.version}.`);
}
if (registry.version !== pkg.version || registry.packages?.[0]?.version !== pkg.version) {
  throw new Error('package.json and server.json versions must match.');
}
if (registry.packages?.[0]?.identifier !== pkg.name) {
  throw new Error('package.json and server.json package names must match.');
}
if (registry.name !== pkg.mcpName) throw new Error('package.json mcpName and server.json name must match.');
if (!cargo.includes(`version = "${pkg.version}"`)) throw new Error('Rust and npm package versions must match.');

const packDirectory = await mkdtemp(join(tmpdir(), 'carve-mcp-pack-'));
const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', packDirectory], { encoding: 'utf8' });
// npm 10 reports an array here; npm 11 and 12 report an object keyed by
// package name. The release job installs npm@latest, so it sees the object
// shape while a developer on the repo's engines floor sees the array.
const packed = JSON.parse(packOutput);
const [{ filename }] = Array.isArray(packed) ? packed : Object.values(packed);
const installDirectory = await mkdtemp(join(tmpdir(), 'carve-mcp-install-'));
execFileSync('npm', ['init', '--yes'], { cwd: installDirectory, stdio: 'ignore' });
// The temporary carve-js git pin has no committed dist/ and relies on its
// prepare script when npm installs it. A registry release will carry dist/,
// but --ignore-scripts makes the current release candidate unstartable.
const installEnv = { ...process.env };
for (const secret of ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'GITHUB_TOKEN', 'NODE_AUTH_TOKEN']) {
  delete installEnv[secret];
}
const installArgs = ['install', '--omit=dev'];
if (releaseRun) installArgs.push('--ignore-scripts');
installArgs.push(join(packDirectory, filename));
execFileSync('npm', installArgs, {
  cwd: installDirectory, env: installEnv, stdio: ['ignore', 'ignore', 'inherit'],
});

const client = new Client({ name: 'release-check', version: pkg.version });
const transport = new StdioClientTransport({
  // Keep startup failures visible in CI. Piping without consuming this stream
  // hides the server's diagnostic and leaves only the client's generic
  // "Connection closed" error.
  command: join(installDirectory, 'node_modules', '.bin', 'carve-mcp'), stderr: 'inherit',
});
await client.connect(transport);
try {
  const tools = await client.listTools();
  // Exact, not a subset: this runs on every pull request, so it is where a tool
  // added without updating DOCUMENT_TOOLS has to go red.
  const drift = describeContractDrift(DOCUMENT_TOOLS, tools.tools.map(({ name }) => name));
  if (drift) throw new Error(`Packed server contract drifted. ${drift}`);
  const result = await client.callTool({ name: 'carve_render', arguments: { source: '# Release check', target: 'html' } });
  if (result.isError || !result.content?.some((item) => item.type === 'text')
      || !result.structuredContent?.value?.includes('Release check')) {
    throw new Error('Release candidate failed the MCP render smoke test.');
  }
} finally {
  await client.close();
}
