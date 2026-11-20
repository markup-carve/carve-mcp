import { createRequire } from 'node:module';
import { sha256Text } from './blocks.js';
import { ENGINE_VERSION, writerAvailable, type LintPlatform, type RegistryTarget } from './engine.js';
import { lint, render, validateSource, type RenderTarget } from './tools.js';

const { version: mcpVersion } = createRequire(import.meta.url)('../package.json') as { version: string };

export type CompatibilityTarget = 'html' | 'markdown' | 'plain' | 'ansi' | 'github' | 'wordpress' | 'pdf';

const TARGETS: Record<CompatibilityTarget, { render: RenderTarget; platforms: LintPlatform[]; note: string }> = {
  html: { render: 'html', platforms: [], note: 'Generic sanitized HTML.' },
  markdown: { render: 'markdown', platforms: [], note: 'Portable Markdown output.' },
  plain: { render: 'plain', platforms: [], note: 'Plain-text projection.' },
  ansi: { render: 'ansi', platforms: [], note: 'Terminal-oriented ANSI text.' },
  github: { render: 'markdown', platforms: ['github'], note: 'Markdown plus GitHub relinking diagnostics.' },
  wordpress: { render: 'html', platforms: [], note: 'Sanitized HTML suitable for the WordPress integration; host extensions remain host-dependent.' },
  pdf: { render: 'html', platforms: [], note: 'HTML-stage compatibility for a print/PDF pipeline; pagination and fonts remain renderer-dependent.' },
};

export function compatibilityMatrix(source: string, targets: CompatibilityTarget[]) {
  if (targets.length < 1 || targets.length > 7) throw new Error('targets must contain between 1 and 7 items.');
  const selected = [...new Set(targets)];
  validateSource(source);
  const results = selected.map((target) => {
    const profile = TARGETS[target];
    const diagnosed = lint(source, profile.platforms);
    const warnings = diagnosed.warnings.map((warning) => ({ ...warning, resourceUri: `carve://lint-rules/${warning.rule}` }));
    const assessmentScope = { renderLosses: 'Only events in the engine render-loss channel.', finalArtifact: target === 'pdf' ? 'Not assessed: HTML stage only.' : 'Host behavior is not assessed.' };
    if (profile.render !== 'html' && !writerAvailable(profile.render as RegistryTarget)) {
      return { target, renderTarget: profile.render, status: 'unavailable' as const, note: `${profile.note} The ${profile.render} writer is not available yet in Carve 0.2.`,
        assessmentScope, warningCount: diagnosed.warningCount, warnings, lossCount: 0, losses: [], lossesTruncated: false,
        suggestions: ['Check this target again once the engine registers its writer.'] };
    }
    const rendered = render(source, profile.render);
    const status = rendered.totalLosses > 0 ? 'lossy' as const : diagnosed.warningCount > 0 ? 'warning' as const : 'compatible' as const;
    const suggestions = [
      ...(rendered.totalLosses > 0 ? ['Inspect the reported render losses and choose a target-specific fallback.'] : []),
      ...(diagnosed.warningCount > 0 ? [`Resolve the ${target === 'github' ? 'target-specific' : 'general'} lint warnings before publishing.`] : []),
    ];
    return { target, renderTarget: profile.render, status, note: profile.note, assessmentScope,
      warningCount: diagnosed.warningCount, warnings,
      lossCount: rendered.totalLosses, losses: rendered.losses, lossesTruncated: rendered.truncated, suggestions };
  });
  return { receiptVersion: 2, source: { format: 'carve' as const, sha256: sha256Text(source) },
    versions: { engine: ENGINE_VERSION, mcp: mcpVersion },
    compatible: results.every(({ status }) => status === 'compatible'), targetCount: results.length,
    summary: { compatible: results.filter(({ status }) => status === 'compatible').length,
      warning: results.filter(({ status }) => status === 'warning').length,
      lossy: results.filter(({ status }) => status === 'lossy').length,
      unavailable: results.filter(({ status }) => status === 'unavailable').length }, targets: results };
}
