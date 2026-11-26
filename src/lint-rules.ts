import { readFileSync } from 'node:fs';

interface LintRule { id: string; severity: string; status: string; default: string; reports?: string; clauses?: string[] }

const catalog = JSON.parse(readFileSync(new URL('../resources/spec-0.2/lint-rules.json', import.meta.url), 'utf8')) as { rules: LintRule[] };
const rules = new Map(catalog.rules.filter((rule) => ['kept', 'new', 'renamed'].includes(rule.status)).map((rule) => [rule.id, rule]));

/** The 0.2 lint catalog (spec/0.2/data/lint-rules.json). */
export const lintRuleNames = [...rules.keys()];

export function lintRuleMarkdown(name: string): string | undefined {
  const rule = rules.get(name.toLowerCase());
  if (!rule) return undefined;
  const clauses = rule.clauses?.length ? `\n\nClauses: ${rule.clauses.map((id) => `\`carve://rules/${id}\``).join(', ')}` : '';
  const reports = rule.reports ? `\n\nReports ${rule.reports}.` : '';
  return `# ${rule.id}\n\nSeverity: ${rule.severity}. Default: ${rule.default}.${reports}${clauses}\n\nThe warning returned by \`carve_lint\` includes the exact location and a document-specific explanation.\n`;
}
