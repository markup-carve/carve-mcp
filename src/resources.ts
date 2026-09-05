import { ruleIndex, RULE_SOURCE_COMMIT } from './rules.generated.js';
import { LIB_VERSION, SPEC_VERSION } from '@markup-carve/carve';

export const DOCS_BASE = 'https://markup-carve.github.io/carve';

export const authoringGuide = `# Carve authoring quick start

This guide covers the forms writers use most. It accompanies Carve language
specification ${SPEC_VERSION} and the JavaScript engine ${LIB_VERSION}.

## Everyday text

| Write | Meaning |
| --- | --- |
| \`/italic/\` | emphasis |
| \`*bold*\` | strong emphasis |
| \`_underline_\` | underline |
| \`~strike~\` | deleted text |
| <code>&#96;code&#96;</code> | inline code |
| \`[text](url)\` | link |
| \`![alt](image.jpg)\` | image |
| \`[^1]\` and \`[^1]: Note\` | footnote |

Use a backslash before ASCII punctuation when it should stay literal.

## Structure

\`#\` through \`######\` create headings. Use \`-\` for bullet lists,
\`1.\` for numbered lists, \`- [ ]\` for tasks, and \`>\` for quotations.
Fenced code blocks use three backticks followed immediately by the language.

Put block attributes on their own line immediately before a block:

\`{#stable-id .wide key=value}\`  
\`# A heading\`

Inline attributes follow the inline construct: \`*important*{.highlight}\`.

Containers use matching colon fences:

\`\`\`carve
::: note "Optional title"
Body
:::
\`\`\`

Keep the space after the opening colons; without it the line is ordinary text.
Use one more colon for each nested container.

## Tables and captions

Pipe tables need no delimiter row. Attach \`=\` to the pipe, then add a space,
to make a header cell: \`|= Name |= Value |\`. Put a line beginning with \`^\`
after an image, quote, table, or code block to add a caption.

## Good defaults

- Prefer explicit links; bare URLs remain literal.
- Keep block markers at the container's content column.
- Run \`carve_lint\` before publishing and \`carve_format\` for canonical source.
- Check \`losses\` or migration diagnostics before accepting converted output.

Full examples: ${DOCS_BASE}/examples
Complete cheat sheet: ${DOCS_BASE}/cheatsheet
Syntax edge cases: ${DOCS_BASE}/parsing-ambiguities
`;

export function ruleIndexMarkdown(): string {
  const scopes = ruleIndex.scopes.map((scope) =>
    `- **${scope.title}**: ${scope.description} (${DOCS_BASE}/rules/${scope.id})`,
  );
  return `# Normative Carve rule index

This is an explicitly pinned development snapshot of the Carve ${SPEC_VERSION}
language contract from markup-carve/carve commit \`${RULE_SOURCE_COMMIT}\`.
The server engine is @markup-carve/carve ${LIB_VERSION}; those version lines are
independent.

The categories below are different views of one language contract; they are
not optional conformance levels.

${scopes.join('\n')}

Read \`carve://rules/{ruleId}\` for a stable normative \`CARVE-*\` rule's title
and category. Linter names such as \`unclosed-container-fence\` belong to a
separate diagnostic namespace and are not normative rule IDs.
The complete human-readable index is at ${DOCS_BASE}/rules/.
`;
}

export function findRule(ruleId: string) {
  const normalized = ruleId.toUpperCase();
  return ruleIndex.rules.find((rule) => rule.id === normalized)
    ?? ruleIndex.retired.find((rule) => rule.id === normalized);
}

export function ruleMarkdown(ruleId: string): string | undefined {
  const rule = findRule(ruleId);
  if (!rule) return undefined;
  if ('scope' in rule) {
    const scope = ruleIndex.scopes.find((candidate) => candidate.id === rule.scope);
    return `# ${rule.id}: ${rule.title}\n\nPart: ${rule.part}\n\nCategory: ${scope?.title ?? rule.scope}\n\n${scope?.description ?? ''}\n\nRead this rule's category: ${DOCS_BASE}/rules/${rule.scope}\n\nPinned source metadata: https://github.com/markup-carve/carve/blob/${RULE_SOURCE_COMMIT}/resources/spec/rules.json\n`;
  }
  const replacement = rule.replacement.startsWith('CARVE-')
    ? `carve://rules/${rule.replacement}`
    : `https://github.com/markup-carve/carve/blob/main/${rule.replacement}`;
  return `# ${rule.id}: ${rule.title}\n\nThis rule is retired. Replacement: ${replacement}\n`;
}

export const ruleIds = [...ruleIndex.rules, ...ruleIndex.retired].map((rule) => rule.id);
