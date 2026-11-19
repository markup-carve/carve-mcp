/**
 * JSON patch operations over a tree of contract 2.0.
 *
 * Carve 0.2 has no AST diff or patch call, so the server keeps its own subset
 * of RFC 6902 (`add`, `remove`, `replace`). Source positions (`pos`) and the
 * parse metadata (`srcByteLength`, `stages`) never take part: they describe
 * the source, not the document.
 */
export interface AstPatchOperation { op: 'add' | 'remove' | 'replace'; path: string; value?: unknown }

export const POSITION_KEYS: ReadonlySet<string> = new Set(['pos', 'srcByteLength', 'stages']);

function segment(part: string): string {
  return part.replaceAll('~', '~0').replaceAll('/', '~1');
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left).filter((key) => !POSITION_KEYS.has(key)).sort();
  const rightKeys = Object.keys(right).filter((key) => !POSITION_KEYS.has(key)).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]
    && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** Strip positions and parse metadata from a copy of `value`. */
export function withoutPositions<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutPositions(item)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !(POSITION_KEYS.has(key) && (key !== 'pos' || (item && typeof item === 'object'))))
    .map(([key, item]) => [key, withoutPositions(item)])) as T;
}

export function createAstPatch(before: unknown, after: unknown): AstPatchOperation[] {
  const operations: AstPatchOperation[] = [];
  const diff = (left: unknown, right: unknown, path: string): void => {
    if (equal(left, right)) return;
    const bothArrays = Array.isArray(left) && Array.isArray(right);
    const bothObjects = !!left && !!right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right);
    if (bothArrays && left.length === right.length) {
      left.forEach((item, index) => diff(item, right[index], `${path}/${index}`));
      return;
    }
    if (bothObjects) {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      for (const key of Object.keys(leftRecord)) {
        if (POSITION_KEYS.has(key)) continue;
        if (!Object.hasOwn(rightRecord, key)) operations.push({ op: 'remove', path: `${path}/${segment(key)}` });
      }
      for (const key of Object.keys(rightRecord)) {
        if (POSITION_KEYS.has(key)) continue;
        if (!Object.hasOwn(leftRecord, key)) operations.push({ op: 'add', path: `${path}/${segment(key)}`, value: withoutPositions(rightRecord[key]) });
        else diff(leftRecord[key], rightRecord[key], `${path}/${segment(key)}`);
      }
      return;
    }
    operations.push({ op: 'replace', path, value: withoutPositions(right) });
  };
  diff(before, after, '');
  return operations;
}

function parts(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`patch path ${JSON.stringify(path)} is not a JSON pointer`);
  return path.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

export function applyAstPatch<T>(document: T, operations: readonly AstPatchOperation[]): T {
  let root: unknown = structuredClone(document);
  for (const operation of operations) {
    const keys = parts(operation.path);
    if (keys.length === 0) {
      if (operation.op === 'remove') throw new Error('patch cannot remove the document');
      root = structuredClone(operation.value);
      continue;
    }
    let parent: unknown = root;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error(`patch path ${operation.path} does not exist`);
      parent = (parent as Record<string, unknown>)[key];
    }
    const last = keys.at(-1)!;
    if (!parent || typeof parent !== 'object') throw new Error(`patch path ${operation.path} does not exist`);
    if (Array.isArray(parent)) {
      const index = last === '-' && operation.op === 'add' ? parent.length : /^(0|[1-9]\d*)$/.test(last) ? Number(last) : -1;
      const bound = operation.op === 'add' ? parent.length : parent.length - 1;
      if (index < 0 || index > bound) throw new Error(`patch path ${operation.path} is out of range`);
      if (operation.op === 'add') parent.splice(index, 0, structuredClone(operation.value));
      else if (operation.op === 'remove') parent.splice(index, 1);
      else parent[index] = structuredClone(operation.value);
      continue;
    }
    const record = parent as Record<string, unknown>;
    if (operation.op !== 'add' && !Object.hasOwn(record, last)) throw new Error(`patch path ${operation.path} does not exist`);
    if (operation.op === 'remove') delete record[last];
    else record[last] = structuredClone(operation.value);
  }
  return root as T;
}
