import type { LintPlatform } from '@markup-carve/carve';
import { lint, render, type RenderTarget } from './tools.js';

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
  const results = selected.map((target) => {
    const profile = TARGETS[target];
    const rendered = render(source, profile.render);
    const diagnosed = lint(source, profile.platforms);
    const status = rendered.totalLosses > 0 ? 'lossy' : diagnosed.warningCount > 0 ? 'warning' : 'compatible';
    const suggestions = [
      ...(rendered.totalLosses > 0 ? ['Inspect the reported render losses and choose a target-specific fallback.'] : []),
      ...(diagnosed.warningCount > 0 ? [`Resolve the ${target === 'github' ? 'target-specific' : 'general'} lint warnings before publishing.`] : []),
    ];
    return { target, renderTarget: profile.render, status, note: profile.note,
      warningCount: diagnosed.warningCount, warnings: diagnosed.warnings,
      lossCount: rendered.totalLosses, losses: rendered.losses, lossesTruncated: rendered.truncated, suggestions };
  });
  return { compatible: results.every(({ status }) => status === 'compatible'), targetCount: results.length,
    summary: { compatible: results.filter(({ status }) => status === 'compatible').length,
      warning: results.filter(({ status }) => status === 'warning').length,
      lossy: results.filter(({ status }) => status === 'lossy').length }, targets: results };
}
