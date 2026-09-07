export type SourceEditKind = 'formatting' | 'syntax-migration' | 'quick-fix' | 'refactor';

export function createSourcePatch(source: string, replacement: string, kind: SourceEditKind, code: string) {
  const encoder = new TextEncoder();
  const before = encoder.encode(source);
  const after = encoder.encode(replacement);
  let hash = 0xcbf29ce484222325n;
  for (const byte of before) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  while (start > 0 && ((before[start] ?? 0) & 0xc0) === 0x80) start -= 1;
  while (start > 0 && ((after[start] ?? 0) & 0xc0) === 0x80) start -= 1;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
  while (((before[oldEnd] ?? 0) & 0xc0) === 0x80 || ((after[newEnd] ?? 0) & 0xc0) === 0x80) { oldEnd += 1; newEnd += 1; }
  const edits = source === replacement ? [] : [{
    start, end: oldEnd, replacement: new TextDecoder().decode(after.subarray(start, newEnd)), kind, code,
  }];
  return { version: 1 as const, sourceFingerprint: `fnv1a64:${hash.toString(16).padStart(16, '0')}`, sourceBytes: before.length, edits, unresolved: [] };
}
