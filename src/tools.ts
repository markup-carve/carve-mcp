import {
  carveToAnsiWithReport,
  carveToAstJson,
  carveToCarveWithReport,
  carveToHtmlWithReport,
  carveToMarkdownWithReport,
  carveToPlainTextWithReport,
  autolink,
  semanticSpan,
  wikilinks,
  lintCarve,
  migrateDjot,
  migrateHtml,
  migrateMarkdown,
  type LintPlatform,
  type MigrationResult,
  type RenderResult,
  type CarveExtension,
  type MarkdownDialect,
} from '@markup-carve/carve';

export const MAX_SOURCE_BYTES = 1_000_000;
export type RenderTarget = 'html' | 'markdown' | 'plain' | 'ansi';
export type SourceFormat = 'html' | 'markdown' | 'djot';
export type RenderPreset = 'default' | 'portable' | 'static-html';
export type ExtensionName = 'autolink' | 'semantic-spans' | 'wikilinks';
type AsciiHeadingIdMode = boolean | 'fold' | 'strict';
export interface RenderSettings {
  preset?: RenderPreset;
  asciiHeadingIds?: AsciiHeadingIdMode;
  lowercaseHeadingIds?: boolean;
  strictLosses?: boolean;
  maxRenderLosses?: number;
  smartTypography?: 'glyph' | 'source';
  extensions?: ExtensionName[];
  allowRawHtml?: boolean;
  sanitizeUrls?: boolean;
}

function extensionInstances(names: ExtensionName[] = []): CarveExtension[] {
  return names.map((name) => {
    switch (name) {
      case 'autolink': return autolink();
      case 'semantic-spans': return semanticSpan();
      case 'wikilinks': return wikilinks();
    }
  });
}

function renderOptions(settings: RenderSettings) {
  const portable = settings.preset === 'portable';
  return {
    asciiHeadingIds: settings.asciiHeadingIds ?? (portable ? 'fold' : undefined),
    lowercaseHeadingIds: settings.lowercaseHeadingIds ?? (portable ? true : undefined),
    strictLosses: settings.strictLosses,
    maxRenderLosses: settings.maxRenderLosses,
    smartTypography: settings.smartTypography,
    extensions: extensionInstances(settings.extensions),
    allowRawHtml: settings.allowRawHtml ?? false,
    sanitizeUrls: settings.sanitizeUrls ?? true,
  };
}

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

export function render(source: string, target: RenderTarget, settings: RenderSettings = {}): RenderResult {
  validateSource(source);
  if (settings.preset === 'static-html' && target !== 'html') {
    throw new Error('The static-html preset is only valid for the HTML target.');
  }
  if (settings.extensions?.includes('semantic-spans') && target !== 'html') {
    throw new Error('The semantic-spans extension is only valid for the HTML target.');
  }
  const options = renderOptions(settings);
  switch (target) {
    case 'html': return carveToHtmlWithReport(source, settings.preset === 'static-html' ? { ...options, mode: 'static' } : options);
    case 'markdown': return carveToMarkdownWithReport(source, options);
    case 'plain': return carveToPlainTextWithReport(source, options);
    case 'ansi': return carveToAnsiWithReport(source, options);
  }
}

export function parse(source: string) {
  validateSource(source);
  return carveToAstJson(source);
}

export function migrate(source: string, format: SourceFormat, dialect?: MarkdownDialect): MigrationResult {
  validateSource(source);
  if (dialect && format !== 'markdown') {
    throw new Error('markdownDialect is only valid when format is markdown.');
  }
  switch (format) {
    case 'html': return migrateHtml(source);
    case 'markdown': return migrateMarkdown(source, { dialect });
    case 'djot': return migrateDjot(source);
  }
}
