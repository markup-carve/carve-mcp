import {
  carveToAnsiWithReport,
  carveToAstJson,
  carveToCarveWithReport,
  carveToHtmlWithReport,
  carveToMarkdownWithReport,
  carveToPlainTextWithReport,
  lintCarve,
  migrateDjot,
  migrateHtml,
  migrateMarkdown,
  type LintPlatform,
  type MigrationResult,
  type RenderResult,
} from '@markup-carve/carve';

export const MAX_SOURCE_BYTES = 1_000_000;
export type RenderTarget = 'html' | 'markdown' | 'plain' | 'ansi' | 'carve';
export type SourceFormat = 'html' | 'markdown' | 'djot';

export function validateSource(source: string): void {
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(`Source is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES} bytes.`);
  }
}

export function lint(source: string, platforms: LintPlatform[] = []) {
  validateSource(source);
  const warnings = lintCarve(source, { platforms });
  return { valid: warnings.length === 0, warningCount: warnings.length, warnings };
}

export function format(source: string): RenderResult {
  validateSource(source);
  return carveToCarveWithReport(source);
}

export function render(source: string, target: RenderTarget): RenderResult {
  validateSource(source);
  switch (target) {
    case 'html': return carveToHtmlWithReport(source);
    case 'markdown': return carveToMarkdownWithReport(source);
    case 'plain': return carveToPlainTextWithReport(source);
    case 'ansi': return carveToAnsiWithReport(source);
    case 'carve': return carveToCarveWithReport(source);
  }
}

export function parse(source: string) {
  validateSource(source);
  return carveToAstJson(source);
}

export function migrate(source: string, format: SourceFormat): MigrationResult {
  validateSource(source);
  switch (format) {
    case 'html': return migrateHtml(source);
    case 'markdown': return migrateMarkdown(source);
    case 'djot': return migrateDjot(source);
  }
}
