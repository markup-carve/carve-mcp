import { readFileSync } from 'node:fs';
import { ENGINE_VERSION, SPEC_VERSION } from './engine.js';

export const DOCS_BASE = 'https://markup-carve.github.io/carve';

const RESOURCE_DIR = new URL('../resources/spec-0.2/', import.meta.url);

function resourceText(name: string): string {
  return readFileSync(new URL(name, RESOURCE_DIR), 'utf8');
}

const source = JSON.parse(resourceText('SOURCE.json')) as { repository: string; commit: string; documents: string[] };
/** The markup-carve/carve commit the vendored 0.2 resources come from. */
export const SPEC_SOURCE_COMMIT = source.commit;
export const specDocumentNames = source.documents.map((name) => name.replace(/\.md$/, ''));

export const authoringGuide = `# Carve authoring quick start

This guide covers the forms writers use most. It accompanies Carve language
specification ${SPEC_VERSION} and the JavaScript engine ${ENGINE_VERSION}.

## Everyday text

| Write | Meaning |
| --- | --- |
| \`/italic/\` | emphasis |
| \`*bold*\` | strong emphasis |
| \`{_underline_}\` | underline |
| \`{~strike~}\` | deleted text |
| \`{=mark=}\` | highlight |
| <code>&#96;code&#96;</code> | inline code |
| \`[text](url)\` | link |
| \`![alt](image.jpg)\` | image |
| \`[^1]\` and \`[^1]: Note\` | footnote |

A bare \`_x_\` or \`~x~\` pair is text in 0.2. Use a backslash before ASCII
punctuation when it should stay literal.

## Structure

\`=\` through \`======\` create headings (\`#\` is still read). Use \`-\` for
bullet lists, \`1.\` for numbered lists, \`- [ ]\` for tasks, and \`>\` for
quotations. Fenced code blocks use three backticks followed by the language.
Leave a blank line before a block that follows a paragraph.

Put block attributes on their own line immediately before a block:

\`{#stable-id .wide key=value}\`
\`= A heading\`

Inline attributes follow the inline construct: \`*important*{.highlight}\`.

Containers use matching colon fences:

\`\`\`carve
::: note "Optional title"
Body
:::
\`\`\`

## Tables and captions

Pipe tables need no delimiter row. Attach \`=\` to the pipe, then add a space,
to make a header cell: \`|= Name |= Value |\`. Alignment goes in braces glued
to the marker: \`|={>} Price |\` or \`|{~} 12 |\`. Put a line beginning with \`^\`
after an image, quote, table, or code block to add a caption.

## Good defaults

- Prefer explicit links; bare URLs remain literal.
- Run \`carve_upgrade\` on Carve 0.1 source before editing it as 0.2.
- Run \`carve_lint\` before publishing and \`carve_format\` for canonical source.
- Check \`losses\` or import diagnostics before accepting converted output.

Specification: \`carve://spec\`. Upgrade map: \`carve://upgrade-map\`.
`;

interface RuleEntry { id: string; document: string; text: string }
const rules = (JSON.parse(resourceText('rules.json')) as { rules: RuleEntry[] }).rules;
const rulesById = new Map(rules.map((rule) => [rule.id, rule]));

export const ruleIds = rules.map((rule) => rule.id);

export function findRule(ruleId: string): RuleEntry | undefined {
  return rulesById.get(ruleId.toUpperCase());
}

function specName(document: string): string {
  return document.replace(/\.md$/, '');
}

export function ruleIndexMarkdown(): string {
  const counts = new Map<string, number>();
  for (const rule of rules) counts.set(rule.document, (counts.get(rule.document) ?? 0) + 1);
  const lines = [...counts].map(([document, count]) => `- **${specName(document)}**: ${count} clauses (\`carve://spec/${specName(document)}\`)`);
  return `# Normative Carve ${SPEC_VERSION} rule index

The clauses below come from the Carve ${SPEC_VERSION} specification at
markup-carve/carve commit \`${SPEC_SOURCE_COMMIT}\` (branch \`next2\`).
The server engine is @markup-carve/carve ${ENGINE_VERSION}.

${lines.join('\n')}

Read \`carve://rules/{ruleId}\` for one \`C2-*\` clause. Lint names such as
\`unclosed-container-fence\` belong to a separate diagnostic namespace
(\`carve://lint-rules/{ruleName}\`) and are not clause IDs.
`;
}

export function ruleMarkdown(ruleId: string): string | undefined {
  const rule = findRule(ruleId);
  if (!rule) return undefined;
  const link = `https://github.com/markup-carve/carve/blob/${SPEC_SOURCE_COMMIT}/spec/0.2/${rule.document}`;
  return `# ${rule.id}\n\nDocument: \`carve://spec/${specName(rule.document)}\`\n\n${rule.text}\n\nSource: ${link}\n`;
}

export function specIndexMarkdown(): string {
  return `# Carve ${SPEC_VERSION} specification

Vendored from markup-carve/carve commit \`${SPEC_SOURCE_COMMIT}\` (branch \`next2\`).

${specDocumentNames.map((name) => `- \`carve://spec/${name}\``).join('\n')}
`;
}

export function specDocument(name: string): string | undefined {
  if (!specDocumentNames.includes(name)) return undefined;
  return resourceText(`${name}.md`);
}

interface UpgradeEntry { id: string; kind: string; group?: string; from: string; to: string; silent?: boolean }
const upgradeMap = JSON.parse(resourceText('upgrade-map.json')) as { source: UpgradeEntry[]; tree: UpgradeEntry[] };
const upgradeEntries = new Map([...upgradeMap.source, ...upgradeMap.tree].map((entry) => [entry.id, entry]));
export const upgradeEntryIds = [...upgradeEntries.keys()];

export function upgradeMapMarkdown(): string {
  const row = (entry: UpgradeEntry) => `| ${entry.id} | ${entry.kind} | ${entry.group ?? ''} | ${entry.silent ? 'yes' : 'no'} |`;
  return `# Carve 0.1 to ${SPEC_VERSION} upgrade map

Every source change (\`U-*\`) and tree change (\`T-*\`) between Carve 0.1 and
${SPEC_VERSION}. A silent entry changes meaning without a diagnostic. Read
\`carve://upgrade-map/{entryId}\` for the before and after of one entry, and
run \`carve_upgrade\` to apply the source entries.

| Entry | Kind | Group | Silent |
| --- | --- | --- | --- |
${[...upgradeEntries.values()].map(row).join('\n')}
`;
}

export function upgradeEntryMarkdown(id: string): string | undefined {
  const entry = upgradeEntries.get(id.toUpperCase());
  if (!entry) return undefined;
  const fence = (text: string) => `\`\`\`\`\n${text.replace(/\n$/, '')}\n\`\`\`\``;
  const group = entry.group ? ` (${entry.group})` : '';
  return `# ${entry.id}: ${entry.kind}${group}\n\nBefore (0.1):\n\n${fence(entry.from)}\n\nAfter (${SPEC_VERSION}):\n\n${fence(entry.to)}\n\nSilent: ${entry.silent ? 'yes' : 'no'}\n`;
}
