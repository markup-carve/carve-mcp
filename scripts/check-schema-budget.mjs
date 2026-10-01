import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { countTokens } from 'gpt-tokenizer/model/gpt-5';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_PROFILES } from '../dist/tool-profile.js';
import { validateBudgetScenario, assertBudgetToolNames } from './schema-budget-contract.mjs';

const budget = JSON.parse(readFileSync(new URL('./schema-token-budget.json', import.meta.url), 'utf8'));
const results = {};
let failed = false;

const budgetProfiles = Object.keys(budget.profiles);
if (budgetProfiles.length !== TOOL_PROFILES.length || TOOL_PROFILES.some((profile) => !budget.profiles[profile])) {
  throw new Error(`Schema budget profiles must exactly match: ${TOOL_PROFILES.join(', ')}.`);
}
const scenarios = [
  ...TOOL_PROFILES.map((profile) => ({ ...budget.profiles[profile], label: profile, profile })),
  ...Object.entries(budget.scenarios ?? {}).map(([label, scenario]) => ({ label, ...scenario })),
];

for (const scenario of scenarios) validateBudgetScenario(scenario, TOOL_PROFILES);

for (const { label, profile, maximum, tools, workspace: needsWorkspace } of scenarios) {
  const workspace = needsWorkspace ? mkdtempSync(join(tmpdir(), 'carve-mcp-schema-')) : undefined;
  const args = ['dist/index.js', '--tool-profile', profile, ...(workspace ? ['--root', workspace, '--allow-write'] : [])];
  const client = new Client({ name: 'schema-token-budget', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' }));
  try {
    const listed = await client.listTools();
    assertBudgetToolNames(label, tools, listed.tools.map(({ name }) => name));
    const tokens = countTokens(JSON.stringify(listed));
    results[label] = { tools: listed.tools.length, tokens, maximum };
    if (tokens > maximum) failed = true;
  } finally {
    await client.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ tokenizer: budget.tokenizer, profiles: results }, null, 2));
if (failed) throw new Error('MCP tool schemas exceed their token budget.');
