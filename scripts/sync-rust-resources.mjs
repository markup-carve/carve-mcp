import { readFile, writeFile } from 'node:fs/promises';

const sourceUrl = new URL('../src/rules.generated.ts', import.meta.url);
const outputUrl = new URL('../rust/resources/rules.json', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const commit = source.match(/RULE_SOURCE_COMMIT = '([0-9a-f]+)'/)?.[1];
const rawIndex = source.match(/export const ruleIndex = ([\s\S]+?) as const;/)?.[1];
if (!commit || !rawIndex) throw new Error('Could not read generated rule data.');

const generated = `${JSON.stringify({ sourceCommit: commit, index: JSON.parse(rawIndex) }, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = await readFile(outputUrl, 'utf8').catch(() => '');
  if (current !== generated) throw new Error('Rust rule resources are stale; run npm run sync:rust-resources.');
} else {
  await writeFile(outputUrl, generated);
}
