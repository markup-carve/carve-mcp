export function cargoPackage(manifest) {
  const section = /^\[package\][ \t]*(?:#.*)?\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(manifest)?.[1];
  if (!section) throw new Error('Cargo.toml has no [package] section.');
  const field = (name) => new RegExp(`^${name}\\s*=\\s*"([^"\\r\\n]+)"`, 'm').exec(section)?.[1];
  const name = field('name');
  const version = field('version');
  if (!name || !version) throw new Error('Cargo.toml must declare its package name and version.');
  return { name, version };
}

export function cargoLockPackages(lock) {
  return lock.split(/^\[\[package\]\][ \t]*\r?$/m).slice(1).map((block) => {
    const field = (name) => new RegExp(`^${name} = "([^"\\r\\n]+)"$`, 'm').exec(block)?.[1];
    const name = field('name');
    const version = field('version');
    if (!name || !version) throw new Error('Cargo.lock contains an incomplete package block.');
    return { name, version, source: field('source') };
  });
}

export function assertRegistryRustDependencies(manifest, lock) {
  const root = cargoPackage(manifest);
  const nonRegistry = cargoLockPackages(lock)
    .filter(({ name, source }) => name !== root.name && !(source ?? '').startsWith('registry+'))
    .map(({ name, source }) => `${name} (${source?.startsWith('git+') ? 'git' : 'path'})`);
  if (nonRegistry.length > 0) {
    throw new Error(`Rust release dependencies must use registry versions: ${nonRegistry.join(', ')}.`);
  }
}

export function immutableGithubPin(source) {
  if (!source.startsWith('git+')) throw new Error('Rust engine source is not a registry or Git source.');
  const hashAt = source.lastIndexOf('#');
  const revision = source.slice(hashAt + 1);
  const url = new URL(source.slice(4, hashAt));
  if (url.searchParams.has('branch') || url.searchParams.has('tag') || !url.searchParams.has('rev')) {
    throw new Error('Rust engine Git source must use an immutable rev, not a branch, tag or default branch.');
  }
  if (!/^[0-9a-f]{40}$/.test(revision) || url.searchParams.get('rev') !== revision) {
    throw new Error('Rust engine Git rev must be the full locked commit hash.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
      || !/^\/[^/]+\/[^/]+$/.test(url.pathname)) {
    throw new Error('Rust engine Git source must be a GitHub HTTPS repository.');
  }
  return { repository: url.pathname.slice(1).replace(/\.git$/, ''), revision };
}
