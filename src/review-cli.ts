#!/usr/bin/env node
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { LIB_VERSION } from '@markup-carve/carve';
import { prepareWorkspace } from './workspace.js';
import { reviewWorkspace } from './project.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
const args = process.argv.slice(2);
let root: string | undefined;
let strict = false;
let limit: number | undefined;
let maxDepth: number | undefined;
const exclude: string[] = [];
let validArgs = true;
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (flag === '--strict') { strict = true; continue; }
  const value = args[++index];
  if (!value || value.startsWith('--')) { validArgs = false; break; }
  if (flag === '--root' && !root) root = value;
  else if (flag === '--limit' && limit === undefined) limit = Number(value);
  else if (flag === '--max-depth' && maxDepth === undefined) maxDepth = Number(value);
  else if (flag === '--exclude') {
    const path = value.replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (!path || path === '.' || isAbsolute(value) || path.split('/').includes('..')) validArgs = false;
    else exclude.push(path);
  }
  else validArgs = false;
}
if (!root || !validArgs || (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 2_000))
  || (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 25))) {
  process.stderr.write('Usage: carve-mcp-review --root DIR [--strict] [--limit N] [--max-depth N] [--exclude PATH]\n');
  process.exitCode = 2;
} else {
  try {
    const workspace = await prepareWorkspace({ roots: [resolve(root)], review: { exclude } });
    const report = await reviewWorkspace(workspace, 0, { strict, limit, maxDepth });
    process.stdout.write(`${JSON.stringify({ ...report, versions: { engine: LIB_VERSION, mcp: version } }, null, 2)}\n`);
    if (!report.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
