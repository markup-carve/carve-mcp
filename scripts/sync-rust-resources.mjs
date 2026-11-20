import { readFile, writeFile } from 'node:fs/promises';
import {
  authoringGuide, ruleIndexMarkdown, ruleMarkdown, ruleIds, specIndexMarkdown,
  specDocument, specDocumentNames, upgradeMapMarkdown, upgradeEntryMarkdown,
  upgradeEntryIds,
} from '../dist/resources.js';
import { lintRuleMarkdown, lintRuleNames } from '../dist/lint-rules.js';

const root = new URL('../', import.meta.url);
const text = {
  'carve://guide': authoringGuide,
  'carve://rules': ruleIndexMarkdown(),
  'carve://spec': specIndexMarkdown(),
  'carve://upgrade-map': upgradeMapMarkdown(),
};
for (const id of ruleIds) text[`carve://rules/${id}`] = ruleMarkdown(id);
for (const name of specDocumentNames) text[`carve://spec/${name}`] = specDocument(name);
for (const id of upgradeEntryIds) text[`carve://upgrade-map/${id}`] = upgradeEntryMarkdown(id);
for (const name of lintRuleNames) text[`carve://lint-rules/${name}`] = lintRuleMarkdown(name);

const artifacts = [
  ['rust/resources/resource-texts.json', `${JSON.stringify({ text, ruleIds, specDocumentNames, upgradeEntryIds, lintRuleNames }, null, 2)}\n`],
  ['rust/resources/rules.json', await readFile(new URL('resources/spec-0.2/rules.json', root), 'utf8')],
  ['rust/resources/lint-rules.json', await readFile(new URL('resources/spec-0.2/lint-rules.json', root), 'utf8')],
];
for (const [path, generated] of artifacts) {
  const url = new URL(path, root);
  if (process.argv.includes('--check')) {
    const current = await readFile(url, 'utf8').catch(() => '');
    if (current !== generated) throw new Error(`${path} is stale; run npm run sync:rust-resources.`);
  } else {
    await writeFile(url, generated);
  }
}
