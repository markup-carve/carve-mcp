import { extname } from 'node:path';
import { structuredPatch } from 'diff';
import { format as formatCarve } from './tools.js';
import type { Workspace } from './workspace.js';

const CARVE_EXTENSIONS = new Set(['.crv', '.carve']);
const MAX_BATCH_FILES = 100;
const MAX_BATCH_BYTES = 25_000_000;

function diffPath(path: string): string {
  return path.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}

function diffRange(start: number, length: number): string {
  if (length === 1) return String(start);
  return `${length === 0 ? start - 1 : start},${length}`;
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value);
  if (encoded.length <= maximumBytes) return { value, truncated: false };
  let end = maximumBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return { value: `${encoded.subarray(0, end).toString('utf8')}\n... diff truncated ...\n`, truncated: true };
}

export function unifiedDiff(path: string, before: string, after: string, maximumBytes = 100_000) {
  if (before === after) return { value: '', truncated: false };
  const patch = structuredPatch('', '', before, after, '', '', { context: 3 });
  const lines: string[] = [
    `--- a/${diffPath(path)}`,
    `+++ b/${diffPath(path)}`,
  ];
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${diffRange(hunk.oldStart, hunk.oldLines)} +${diffRange(hunk.newStart, hunk.newLines)} @@`);
    lines.push(...hunk.lines);
  }
  return truncateUtf8(`${lines.join('\n')}\n`, maximumBytes);
}

export async function prepareWorkspaceEdits(
  workspace: Workspace,
  rootIndex: number,
  options: { paths?: string[]; maxDepth?: number; limit?: number; maxDiffBytes?: number; includeContent?: boolean } = {},
) {
  const maximumDiffBytes = Math.min(Math.max(options.maxDiffBytes ?? 100_000, 1_000), 200_000);
  const listed = options.paths
    ? { files: [...new Set(options.paths)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0), truncated: false }
    : await workspace.list(rootIndex, { maxDepth: options.maxDepth, limit: Math.min(options.limit ?? MAX_BATCH_FILES, MAX_BATCH_FILES) });
  if (listed.files.length > MAX_BATCH_FILES) throw new Error(`Batch previews support at most ${MAX_BATCH_FILES} files.`);
  if (options.paths?.some((path) => !CARVE_EXTENSIONS.has(extname(path).toLowerCase()))) {
    throw new Error('Explicit batch preview paths must use .crv or .carve extensions.');
  }
  const paths = listed.files.filter((path) => CARVE_EXTENSIONS.has(extname(path).toLowerCase()));
  const items = [];
  let totalBytes = 0;
  let sizeTruncated = false;
  for (const path of paths) {
    try {
      const current = await workspace.read(rootIndex, path);
      if (totalBytes + current.bytes > MAX_BATCH_BYTES) { sizeTruncated = true; break; }
      totalBytes += current.bytes;
      const proposal = formatCarve(current.content);
      const changed = proposal.value !== current.content;
      const diff = unifiedDiff(path, current.content, proposal.value, maximumDiffBytes);
      const item: Record<string, unknown> = {
        path, status: 'ready', expectedSha256: current.sha256, changed,
        mode: proposal.totalLosses === 0 ? 'automatic-format' : 'writer-review',
        unifiedDiff: diff.value, diffTruncated: diff.truncated,
        losses: proposal.losses, totalLosses: proposal.totalLosses, lossesTruncated: proposal.truncated,
      };
      if (changed && options.includeContent) item.proposedContent = proposal.value;
      items.push(item);
    } catch (error) {
      items.push({ path, status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    rootIndex, filesDiscovered: listed.files.length, filesPrepared: items.filter((item) => item.status === 'ready').length,
    filesChanged: items.filter((item) => item.status === 'ready' && 'changed' in item && item.changed).length,
    errorCount: items.filter((item) => item.status === 'error').length,
    items, truncated: listed.truncated || sizeTruncated, totalBytes,
  };
}
