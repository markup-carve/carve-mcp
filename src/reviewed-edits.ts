import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import { sha256Text } from './blocks.js';
import { reviewWorkspace } from './project.js';
import { SourceEditRefusal } from './splice.js';
import type { Workspace } from './workspace.js';

export type UndoReceipt = {
  rootIndex: number; path: string; expectedSha256: string; originalSha256: string;
  undoPatch: { edits: Array<{ start: number; end: number; replacement: string }> };
  originalProjectWarnings: Array<{ rule: string; path: string; target?: string; message: string; severity: 'error' | 'warning' }>;
  signature: string;
};

const receiptKey = randomBytes(32);
function signed(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHmac('sha256', receiptKey).update(JSON.stringify(canonical(value))).digest('hex');
}

export function createUndoReceipt(payload: Omit<UndoReceipt, 'signature'>): string {
  return JSON.stringify({ ...payload, signature: signed(payload) });
}

function verify(receipt: UndoReceipt): void {
  const { signature, ...payload } = receipt;
  const expected = Buffer.from(signed(payload), 'hex');
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new SourceEditRefusal('The undo receipt is invalid or belongs to another server process.', { reason: 'invalid-receipt' });
  }
}

async function projectReview(workspace: Workspace, rootIndex: number, path: string, source: string) {
  const checkedPath = posix.normalize(path.replaceAll('\\', '/'));
  const review = await reviewWorkspace(workspace, rootIndex, {
    strict: true, replacements: new Map([[checkedPath, source]]),
    maxDepth: workspace.review.maxDepth ?? 10, limit: workspace.review.limit ?? 500,
    platforms: workspace.review.platforms ?? [], checkLinks: true, checkAnchors: true,
  });
  if (!review.filesRead.includes(checkedPath)) throw new SourceEditRefusal('The file is outside the workspace review scope.',
    { reason: 'outside-project-scope', filesRead: review.filesRead });
  if (review.truncated || review.checks.suppressedIncludeWarnings
      || review.projectWarnings.some((warning) => warning.rule === 'unreadable-document')) {
    throw new SourceEditRefusal('The workspace check is incomplete.',
      { reason: 'incomplete-project-check', filesRead: review.filesRead });
  }
  return review;
}

export async function undoReviewedEdit(workspace: Workspace, receipt: UndoReceipt) {
  if (!workspace.allowWrite) throw new Error('Workspace writes are disabled.');
  verify(receipt);
  const current = await workspace.read(receipt.rootIndex, receipt.path);
  if (current.sha256 !== receipt.expectedSha256) throw new SourceEditRefusal('The source changed after the edit.',
    { reason: 'stale-undo', sha256: current.sha256 });
  const [edit] = receipt.undoPatch.edits;
  if (!edit || receipt.undoPatch.edits.length !== 1 || edit.start < 0 || edit.end < edit.start || edit.end > current.bytes) {
    throw new SourceEditRefusal('The undo patch is invalid.', { reason: 'invalid-undo' });
  }
  const bytes = Buffer.from(current.content, 'utf8');
  const source = Buffer.concat([bytes.subarray(0, edit.start), Buffer.from(edit.replacement, 'utf8'), bytes.subarray(edit.end)]).toString('utf8');
  if (sha256Text(source) !== receipt.originalSha256) throw new SourceEditRefusal('The undo patch does not restore the previewed source.',
    { reason: 'invalid-undo' });
  const before = await projectReview(workspace, receipt.rootIndex, receipt.path, current.content);
  const after = await projectReview(workspace, receipt.rootIndex, receipt.path, source);
  const key = (warning: { rule: string; path: string; target?: string; message: string; severity: string }) =>
    `${warning.rule}\u0000${warning.path}\u0000${warning.target ?? ''}\u0000${warning.message}\u0000${warning.severity}`;
  const counts = (warnings: UndoReceipt['originalProjectWarnings']) => {
    const result = new Map<string, number>();
    for (const warning of warnings) result.set(key(warning), (result.get(key(warning)) ?? 0) + 1);
    return result;
  };
  const prior = counts(before.projectWarnings);
  for (const [id, count] of counts(receipt.originalProjectWarnings)) prior.set(id, Math.max(prior.get(id) ?? 0, count));
  const introduced = after.projectWarnings.filter((warning) => {
    const count = prior.get(key(warning)) ?? 0;
    if (count === 0) return warning.severity === 'error';
    prior.set(key(warning), count - 1);
    return false;
  });
  if (introduced.length) throw new SourceEditRefusal('Undo would introduce project errors.',
    { reason: 'undo-project-findings', introduced });
  return workspace.write(receipt.rootIndex, receipt.path, source, receipt.expectedSha256, false);
}
