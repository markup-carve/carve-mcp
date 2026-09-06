import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { KNOWN_LINT_PLATFORMS, type LintPlatform } from '@markup-carve/carve';

export interface ReviewConfiguration {
  maxDepth?: number;
  limit?: number;
  platforms?: LintPlatform[];
  exclude?: string[];
  checkLinks?: boolean;
  checkAnchors?: boolean;
}

export interface ProjectConfiguration { roots?: string[]; review?: ReviewConfiguration }

function integer(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function paths(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item || isAbsolute(item) || item.split(/[\\/]/).includes('..'))) {
    throw new Error(`${name} must contain safe relative paths.`);
  }
  return [...new Set(value.map((item) => item.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')))];
}

export async function loadProjectConfiguration(path: string): Promise<ProjectConfiguration> {
  const absolute = resolve(path);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(absolute, 'utf8')); }
  catch (error) { throw new Error(`Cannot read Carve MCP configuration ${absolute}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Carve MCP configuration must be a JSON object.');
  const object = raw as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => !['roots', 'review'].includes(key));
  if (unknown.length) throw new Error(`Unknown Carve MCP configuration field: ${unknown.join(', ')}`);
  const configuredRoots = paths(object.roots, 'roots')?.map((root) => resolve(dirname(absolute), root));
  let review: ReviewConfiguration | undefined;
  if (object.review !== undefined) {
    if (!object.review || typeof object.review !== 'object' || Array.isArray(object.review)) throw new Error('review must be a JSON object.');
    const value = object.review as Record<string, unknown>;
    const unknownReview = Object.keys(value).filter((key) => !['maxDepth', 'limit', 'platforms', 'exclude', 'checkLinks', 'checkAnchors'].includes(key));
    if (unknownReview.length) throw new Error(`Unknown review configuration field: ${unknownReview.join(', ')}`);
    if (value.platforms !== undefined && (!Array.isArray(value.platforms) || value.platforms.some((item) => !KNOWN_LINT_PLATFORMS.includes(item as LintPlatform)))) {
      throw new Error(`review.platforms must contain only: ${KNOWN_LINT_PLATFORMS.join(', ')}.`);
    }
    for (const key of ['checkLinks', 'checkAnchors'] as const) {
      if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`review.${key} must be a boolean.`);
    }
    review = {
      maxDepth: integer(value.maxDepth, 'review.maxDepth', 0, 25),
      limit: integer(value.limit, 'review.limit', 1, 2_000),
      platforms: value.platforms as LintPlatform[] | undefined,
      exclude: paths(value.exclude, 'review.exclude'),
      checkLinks: value.checkLinks as boolean | undefined,
      checkAnchors: value.checkAnchors as boolean | undefined,
    };
  }
  return { roots: configuredRoots, review };
}
