import { readFileSync } from 'node:fs';

// On next2 the TypeScript server runs the Carve 0.2 engine while the Rust server
// still links carve-lang 0.1 (markup-carve/carve-mcp#132), so the comparisons
// would only measure the version gap. Each pending carve-rs call is named.
export const RUST_GAPS = [
  'format, the Carve writer and the Markdown, plain-text and ANSI writers: markup-carve/carve-rs#4327',
  'includes through the file-system resolver: markup-carve/carve-rs#4326',
  'HTML import: markup-carve/carve-rs#4328',
  'extension registration: markup-carve/carve-rs#4329',
  'the Rust server port itself: markup-carve/carve-mcp#132',
];

export function rustServerOn01() {
  const manifest = readFileSync(new URL('../rust/Cargo.toml', import.meta.url), 'utf8');
  return /^carve-lang\s*=/m.test(manifest);
}

export function reportRustGap(check) {
  console.log(`${check}: expected skip, the Rust server still runs Carve 0.1.`);
  for (const gap of RUST_GAPS) console.log(`  pending: ${gap}`);
}
