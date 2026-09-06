import { execFileSync } from 'node:child_process';
import { deepStrictEqual, ok } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { lintRuleNames } from '../dist/lint-rules.js';
import { ruleIds } from '../dist/resources.js';

const metadata = JSON.parse(execFileSync('cargo', [
  'metadata', '--manifest-path', 'rust/Cargo.toml', '--format-version=1', '--no-deps',
], { encoding: 'utf8' }));
const target = metadata.target_directory;
const javascriptEngineVersion = JSON.parse(readFileSync(
  new URL('../node_modules/@markup-carve/carve/package.json', import.meta.url), 'utf8',
)).version;
const cargoLock = readFileSync(new URL('../rust/Cargo.lock', import.meta.url), 'utf8');
const rustEngineVersion = cargoLock.match(/\[\[package\]\]\nname = "carve-lang"\nversion = "([^"]+)"/)?.[1];
if (!rustEngineVersion) throw new Error('Could not resolve carve-lang from Cargo.lock.');

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
  ['carve_render', { source: '# Hello', target: 'markdown' }],
  ['carve_render', { source: '# Hello', target: 'ansi' }],
  ['carve_render', { source: '# HéLLo', target: 'html', preset: 'portable', lowercaseHeadingIds: false }],
  ['carve_render', { source: '`raw`{=latex}', target: 'plain', maxRenderLosses: 0 }],
  ['carve_render', { source: '`raw`{=latex}', target: 'plain', strictLosses: true }],
  ['carve_render', { source: '`<b>x</b>`{=html}', target: 'html', allowRawHtml: true }],
  ['carve_render', { source: '# Hello', target: 'plain', preset: 'static-html' }],
  ['carve_render', { source: '[x]{samp}', target: 'plain', extensions: ['semantic-spans'] }],
  ['carve_migrate', { source: '<b>x</b>', format: 'html', markdownDialect: {} }],
  ['carve_lint', { source: 'x'.repeat(1_000_001) }],
];

function localRef(schema, ref) {
  return ref?.startsWith('#/$defs/') ? schema.$defs?.[ref.slice('#/$defs/'.length)] : undefined;
}

function schemaNode(root, raw) {
  const selected = raw.anyOf?.find((item) => item.type !== 'null') ?? raw;
  const node = selected.$ref ? { ...localRef(root, selected.$ref), ...selected, $ref: undefined } : selected;
  const type = Array.isArray(node.type) ? node.type.filter((item) => item !== 'null')[0] : node.type;
  return {
    type,
    enum: node.enum,
    description: raw.description ?? node.description,
    minimum: node.minimum,
    maximum: node.maximum,
    maxItems: node.maxItems,
    additionalProperties: node.additionalProperties === undefined ? undefined : Boolean(node.additionalProperties),
    required: node.required ? [...node.required].sort() : undefined,
    properties: node.properties && Object.keys(node.properties).length ? Object.fromEntries(
      Object.entries(node.properties).map(([name, property]) => [name, schemaNode(root, property)]),
    ) : undefined,
    items: node.items ? schemaNode(root, node.items) : undefined,
  };
}

function schemaContract(schema) {
  return schemaNode(schema, schema);
}

function outputSchemaContract(schema) {
  const root = schemaNode(schema, schema);
  return {
    type: root.type,
    required: root.required,
    properties: Object.fromEntries(Object.entries(root.properties ?? {}).map(([name, value]) => [name, { type: value.type }])),
  };
}

function normalizedResource(text) {
  return text.replace(/The server engine is [\s\S]+?independent\./,
    'The server engine version is reported independently.').replace(
    /specification ([^\s]+) and the (?:JavaScript|Rust) engine [^\n]+\./,
    'specification $1 and the active engine.',
  );
}

async function results(command, args, engineVersion) {
  const client = new Client({ name: 'rust-conformance', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command, args, stderr: 'pipe' }));
  try {
    const tools = await client.listTools();
    const output = [];
    for (const [name, callArgs] of calls) {
      const result = await client.callTool({ name, arguments: callArgs });
      output.push({ name, isError: result.isError ?? false, value: result.structuredContent ?? JSON.parse(result.content[0].text) });
    }
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    const completions = [];
    for (const [uri, name, value] of [
      ['carve://rules/{ruleId}', 'ruleId', 'CARVE-P12-04'],
      ['carve://lint-rules/{ruleName}', 'ruleName', 'unclosed'],
    ]) {
      completions.push(await client.complete({
        ref: { type: 'ref/resource', uri }, argument: { name, value },
      }));
    }
    const read = {};
    const resourceUris = [
      'carve://guide',
      'carve://rules',
      ...ruleIds.map((id) => `carve://rules/${id}`),
      ...lintRuleNames.map((name) => `carve://lint-rules/${name}`),
    ];
    for (const uri of resourceUris) {
      const response = await client.readResource({ uri });
      const text = response.contents[0].text;
      if ((uri === 'carve://guide' || uri === 'carve://rules') && !text.includes(engineVersion)) {
        throw new Error(`${uri} does not report engine version ${engineVersion}.`);
      }
      read[uri] = normalizedResource(text);
    }
    const resourceErrors = [];
    for (const uri of ['carve://rules/carve-nope-999', 'carve://lint-rules/nope', 'carve://nope']) {
      try { await client.readResource({ uri }); }
      catch (error) { resourceErrors.push({ code: error.code, message: error.message }); }
    }
    return {
      capabilities: Object.keys(client.getServerCapabilities() ?? {}).sort(),
      tools: tools.tools.map(({ name, title, description, annotations, inputSchema, outputSchema }) => ({
        name, title, description, annotations, inputSchema: schemaContract(inputSchema), outputSchema: outputSchemaContract(outputSchema),
      })).sort((a, b) => a.name.localeCompare(b.name)),
      prompts: (await client.listPrompts()).prompts.map(({ name, title, description }) => ({ name, title, description })),
      resources: resources.resources.map(({ uri, name, title, description, mimeType }) => (
        { uri, name, title, description, mimeType }
      )),
      templates: templates.resourceTemplates.map(({ uriTemplate, name, title, description, mimeType }) => (
        { uriTemplate, name, title, description, mimeType }
      )),
      completions,
      resourceErrors,
      read,
      output,
    };
  } finally {
    await client.close();
  }
}

const typescript = await results(process.execPath, ['dist/index.js'], javascriptEngineVersion);
const rust = await results(`${target}/debug/carve-mcp-rs`, [], rustEngineVersion);
try {
  deepStrictEqual(rust, typescript);
} catch (error) {
  for (const key of Object.keys(typescript)) {
    try { deepStrictEqual(rust[key], typescript[key]); }
    catch {
      if (Array.isArray(typescript[key])) {
        const index = typescript[key].findIndex((value, index) => {
          try { deepStrictEqual(rust[key][index], value); return false; } catch { return true; }
        });
        console.error(`Parity mismatch in ${key}[${index}]:`, JSON.stringify({
          typescript: typescript[key][index], rust: rust[key][index],
        }, null, 2));
      } else {
        console.error(`Parity mismatch in ${key}.`);
      }
    }
  }
  throw new Error('TypeScript and Rust MCP conformance results differ.', { cause: error });
}

async function workspaceResults(command, args) {
  const client = new Client({ name: 'rust-workspace-conformance', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command, args, stderr: 'pipe' }));
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).filter((name) => name.includes('workspace') || name.includes('file') || name === 'carve_prepare_edit').sort();
    const output = [];
    const calls = [
      ['carve_workspace_info', {}],
      ['carve_list_files', { rootIndex: 0 }],
      ['carve_review_workspace', { rootIndex: 0 }],
      ['carve_read_file', { rootIndex: 0, path: 'index.crv' }],
      ['carve_prepare_edit', { rootIndex: 0, path: 'index.crv' }],
    ];
    if (names.includes('carve_write_file')) calls.push(['carve_write_file', { rootIndex: 0, path: 'new.crv', content: '# New', dryRun: true }]);
    for (const [name, arguments_] of calls) {
      const result = await client.callTool({ name, arguments: arguments_ });
      output.push({ name, isError: result.isError ?? false, value: result.structuredContent });
    }
    return { names, output };
  } finally {
    await client.close();
  }
}

const workspaceRoot = mkdtempSync(join(tmpdir(), 'carve-mcp-conformance-'));
try {
  mkdirSync(join(workspaceRoot, 'docs'));
  mkdirSync(join(workspaceRoot, 'archive'));
  writeFileSync(join(workspaceRoot, 'index.crv'), '# Home\n\n[Guide](docs/guide.crv#Guide)\n[Missing](docs/missing.crv)\n');
  writeFileSync(join(workspaceRoot, 'docs', 'guide.crv'), '# Guide\n');
  writeFileSync(join(workspaceRoot, 'archive', 'old.crv'), '# Old\n');
  const configuration = join(workspaceRoot, 'carve-mcp.json');
  writeFileSync(configuration, JSON.stringify({ roots: ['.'], review: { exclude: ['archive'], maxDepth: 8, limit: 100 } }));
  const typescriptWorkspace = await workspaceResults(process.execPath, ['dist/index.js', '--config', configuration, '--allow-write']);
  const rustWorkspace = await workspaceResults(`${target}/debug/carve-mcp-rs`, ['--config', configuration, '--allow-write']);
  ok(!typescriptWorkspace.output.find(({ name }) => name === 'carve_list_files').value.files.includes('archive/old.crv'));
  deepStrictEqual(rustWorkspace, typescriptWorkspace);
} finally {
  rmSync(workspaceRoot, { recursive: true, force: true });
}
