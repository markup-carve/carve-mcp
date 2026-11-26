#!/usr/bin/env node
// Copy the Carve 0.2 specification documents, lint catalog and upgrade map
// from a markup-carve/carve checkout of `next2` into resources/spec-0.2/.
// Usage: node scripts/sync-spec-resources.mjs <carve checkout> [--check]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [checkout, flag] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/sync-spec-resources.mjs <carve checkout> [--check]');
const spec = join(checkout, 'spec', '0.2');
const target = new URL('../resources/spec-0.2/', import.meta.url);
const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const files = new Map();
const docs = readdirSync(spec).filter((name) => name.endsWith('.md')).sort();
for (const name of docs) files.set(name, readFileSync(join(spec, name), 'utf8'));
for (const name of ['lint-rules.json', 'upgrade-map.json']) files.set(name, readFileSync(join(spec, 'data', name), 'utf8'));

// One entry per normative clause: `**C2-X-NNN** text` opens a paragraph.
const rules = [];
for (const name of docs) {
  for (const paragraph of files.get(name).split(/\n\s*\n/)) {
    const match = /^\*\*(C2-[A-Z]+-\d+)\*\*\s+([\s\S]*)$/.exec(paragraph.trim());
    if (match) rules.push({ id: match[1], document: name, text: match[2].replace(/\s+/g, ' ').trim() });
  }
}
files.set('rules.json', `${JSON.stringify({ commit, rules }, null, 1)}\n`);
files.set('SOURCE.json', `${JSON.stringify({ repository: 'markup-carve/carve', branch: 'next2', commit, documents: docs }, null, 2)}\n`);

if (flag === '--check') {
  const stale = [...files].filter(([name, text]) => !existsSync(new URL(name, target)) || readFileSync(new URL(name, target), 'utf8') !== text);
  if (stale.length) throw new Error(`resources/spec-0.2 is stale: ${stale.map(([name]) => name).join(', ')}`);
} else {
  mkdirSync(target, { recursive: true });
  for (const [name, text] of files) writeFileSync(new URL(name, target), text);
  console.log(`Wrote ${files.size} files from markup-carve/carve ${commit}.`);
}
