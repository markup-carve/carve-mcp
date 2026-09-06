import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const registry = JSON.parse(await readFile(new URL('../server.json', import.meta.url), 'utf8'));
const cargo = await readFile(new URL('../rust/Cargo.toml', import.meta.url), 'utf8');
const releaseVersion = process.env.RELEASE_TAG?.replace(/^v/, '');

if (process.env.REQUIRE_RELEASE_TAG === '1' && !releaseVersion) {
  throw new Error('RELEASE_TAG is required in a release run.');
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
execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', join(packDirectory, filename)], {
  cwd: installDirectory, stdio: 'ignore',
});

const client = new Client({ name: 'release-check', version: pkg.version });
const transport = new StdioClientTransport({
  command: join(installDirectory, 'node_modules', '.bin', 'carve-mcp'), stderr: 'pipe',
});
await client.connect(transport);
try {
  const tools = await client.listTools();
  const names = tools.tools.map(({ name }) => name);
  for (const required of ['carve_lint', 'carve_format', 'carve_render', 'carve_parse', 'carve_migrate']) {
    if (!names.includes(required)) throw new Error(`Packed server contract is missing ${required}.`);
  }
  const result = await client.callTool({ name: 'carve_render', arguments: { source: '# Release check', target: 'html' } });
  if (result.isError || !result.content?.some((item) => item.type === 'text')
      || !result.structuredContent?.value?.includes('Release check')) {
    throw new Error('Release candidate failed the MCP render smoke test.');
  }
} finally {
  await client.close();
}
