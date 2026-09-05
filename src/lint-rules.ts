export const lintRuleDescriptions = {
  'bidi-control-in-source': 'Invisible bidirectional controls can make source read differently from its stored order.',
  'block-marker-as-text': 'A block marker is being read as ordinary text, usually because spacing or indentation is wrong.',
  'braced-comment-in-a-template-source': 'A braced comment can be interpreted by an outer template before Carve sees it.',
  'broken-crossref': 'A cross-reference does not resolve to a document target.',
  'carve-version-unsupported': 'The document requests a Carve version this engine does not support.',
  'colon-fence-length-mismatch': 'A container closer must use the same number of colons as its opener.',
  'duplicate-footnote-definition': 'More than one definition uses the same footnote label.',
  'duplicate-heading-id': 'More than one heading resolves to the same identifier.',
  'fence-title-syntax': 'A fence title or label does not use the required quoted or bracketed form.',
  'figure-group-empty': 'A composite figure has no panels.',
  'figure-group-nested': 'Composite figure groups cannot be nested.',
  'figure-group-opener-metadata': 'Figure-group metadata is placed where it cannot be represented safely.',
  'figure-group-panel-number': 'A figure panel number conflicts with the group numbering model.',
  'figure-group-single-panel': 'A composite figure has only one panel and does not need grouping.',
  'footnote-labels-differ-only-in-whitespace': 'Footnote labels differ only by whitespace and can be confused.',
  'platform-issue-reference': 'The selected publishing platform can relink a bare issue reference unexpectedly.',
  'platform-mention-token': 'The selected publishing platform can relink a bare mention unexpectedly.',
  'quote-fence-ends-the-quote-above': 'A quote fence closes a preceding quote instead of opening the intended block.',
  'semantic-attribute-outside-span': 'A semantic attribute is attached where it cannot create the intended span.',
  'semantic-attribute-value-ignored': 'The selected semantic span ignores an authored attribute value.',
  'unclosed-container-fence': 'A colon-fenced container reaches the end of the document without a closer.',
  'unresolved-footnote': 'A footnote reference has no matching definition.',
  'unresolved-reference-link': 'A reference-style link has no matching definition or heading.',
  'unused-footnote-definition': 'A footnote is defined but never referenced.',
} as const;

export type LintRuleName = keyof typeof lintRuleDescriptions;
export const lintRuleNames = Object.keys(lintRuleDescriptions) as LintRuleName[];

export function lintRuleMarkdown(name: string): string | undefined {
  const normalized = name.toLowerCase() as LintRuleName;
  if (!Object.hasOwn(lintRuleDescriptions, normalized)) return undefined;
  const description = lintRuleDescriptions[normalized];
  if (!description) return undefined;
  return `# ${normalized}\n\n${description}\n\nThe warning returned by \`carve_lint\` includes the exact location and a document-specific explanation.\n`;
}
