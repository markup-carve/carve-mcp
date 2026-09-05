export interface CliOptions { roots: string[]; allowWrite: boolean }

export function parseArgs(args: string[]): CliOptions {
  const roots: string[] = [];
  let allowWrite = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allow-write') allowWrite = true;
    else if (argument.startsWith('--root=')) roots.push(argument.slice(7));
    else if (argument === '--root') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--root requires an absolute path.');
      roots.push(value);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (roots.some((root) => !isAbsolute(root))) throw new Error('Workspace roots must be absolute paths.');
  if (allowWrite && roots.length === 0) throw new Error('--allow-write requires at least one --root.');
  return { roots: [...new Set(roots)], allowWrite };
}

import { isAbsolute } from 'node:path';
