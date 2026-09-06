export interface CliOptions { roots: string[]; allowWrite: boolean; http: boolean; host: string; port: number; config?: string }

export function parseArgs(args: string[]): CliOptions {
  const roots: string[] = [];
  let allowWrite = false;
  let http = false;
  let host = '127.0.0.1';
  let port = 3000;
  let config: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allow-write') allowWrite = true;
    else if (argument.startsWith('--config=')) {
      config = argument.slice(9);
      if (!config) throw new Error('--config requires a JSON file path.');
    }
    else if (argument === '--config') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--config requires a JSON file path.');
      config = value;
    }
    else if (argument === '--http') http = true;
    else if (argument.startsWith('--host=')) host = argument.slice(7);
    else if (argument === '--host') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--host requires a hostname or IP address.');
      host = value;
    }
    else if (argument.startsWith('--port=')) port = Number(argument.slice(7));
    else if (argument === '--port') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--port requires an integer from 0 to 65535.');
      port = Number(value);
    }
    else if (argument.startsWith('--root=')) roots.push(argument.slice(7));
    else if (argument === '--root') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--root requires an absolute path.');
      roots.push(value);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (roots.some((root) => !isAbsolute(root))) throw new Error('Workspace roots must be absolute paths.');
  if (host.length === 0) throw new Error('--host requires a hostname or IP address.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535.');
  return { roots: [...new Set(roots)], allowWrite, http, host, port, config };
}

import { isAbsolute } from 'node:path';
