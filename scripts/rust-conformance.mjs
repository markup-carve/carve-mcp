import { execFileSync } from 'node:child_process';
import { deepStrictEqual } from 'node:assert';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const target = JSON.parse(execFileSync('cargo', [
  'metadata', '--manifest-path', 'rust/Cargo.toml', '--format-version=1', '--no-deps',
], { encoding: 'utf8' })).target_directory;

const calls = [
  ['carve_format', { source: '# Hello' }],
  ['carve_render', { source: '# Héllo', target: 'html', preset: 'portable' }],
  ['carve_render', { source: 'Visit https://example.com', target: 'html', extensions: ['autolink'] }],
  ['carve_render', { source: '[x]{samp}', target: 'html', extensions: ['semantic-spans'] }],
  ['carve_render', { source: '[[Some Page]]', target: 'html', extensions: ['wikilinks'] }],
  ['carve_render', { source: '# Mixed', target: 'html', asciiHeadingIds: 'strict', lowercaseHeadingIds: true }],
  ['carve_render', { source: 'Wait...', target: 'plain', smartTypography: 'source' }],
  ['carve_render', { source: '`<b>x</b>`{=html}', target: 'html', allowRawHtml: false, sanitizeUrls: true }],
  ['carve_render', { source: '```=latex\nx\n```', target: 'plain' }],
  ['carve_parse', { source: '# Hello' }],
  ['carve_migrate', { source: '<strong>Hello</strong>', format: 'html' }],
  ['carve_migrate', { source: '==marked==', format: 'markdown', markdownDialect: { highlight: true } }],
  ['carve_migrate', { source: '^[note]', format: 'markdown' }],
  ['carve_migrate', { source: '^power^', format: 'markdown', markdownDialect: { superscript: true } }],
  ['carve_migrate', { source: '$x+y$', format: 'markdown', markdownDialect: { math: true } }],
  ['carve_migrate', { source: '*[HTML]: language', format: 'markdown', markdownDialect: { abbreviations: true } }],
  ['carve_migrate', { source: '::: note\nbody\n:::', format: 'markdown', markdownDialect: { fencedDivs: true } }],
  ['carve_migrate', { source: '[text]{.class}', format: 'markdown', markdownDialect: { attributes: true } }],
  ['carve_migrate', { source: '`==literal==` and ==marked==', format: 'markdown', markdownDialect: { highlight: true } }],
  ['carve_migrate', { source: '```text\n==literal== and $x$\n```', format: 'markdown', markdownDialect: { highlight: true, math: true } }],
  ['carve_lint', { source: 'é\n:::' }],
  ['carve_lint', { source: '😀 @person and #12', platforms: ['github'] }],
  ['carve_lint', { source: '`@person #12`', platforms: ['github'] }],
  ['carve_lint', { source: '@person\n:::', platforms: ['github'] }],
];

async function results(command, args = []) {
  const client = new Client({ name: 'rust-conformance', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command, args, stderr: 'pipe' }));
  try {
    const tools = await client.listTools();
    const output = [];
    for (const [name, callArgs] of calls) {
      const result = await client.callTool({ name, arguments: callArgs });
      output.push({ name, isError: result.isError ?? false, value: JSON.parse(result.content[0].text) });
    }
    return { tools: tools.tools.map(({ name }) => name).sort(), output };
  } finally {
    await client.close();
  }
}

const typescript = await results(process.execPath, ['dist/index.js']);
const rust = await results(`${target}/debug/carve-mcp-rs`);
try {
  deepStrictEqual(rust, typescript);
} catch (error) {
  console.error(JSON.stringify({ typescript, rust }, null, 2));
  throw new Error('TypeScript and Rust MCP conformance results differ.', { cause: error });
}
