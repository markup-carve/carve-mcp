import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const metadata=JSON.parse(execFileSync('cargo',['metadata','--manifest-path','rust/Cargo.toml','--format-version=1','--no-deps'],{encoding:'utf8'}));
const rust=`${process.env.CARGO_TARGET_DIR??metadata.target_directory}/debug/carve-mcp-rs`;
async function connect(command,args){const client=new Client({name:'resource-conformance',version:'0.2'});
  await client.connect(new StdioClientTransport({command,args,stderr:'pipe'}));return client;}
const ts=await connect(process.execPath,['dist/index.js']);
const rs=await connect(rust,[]);
const sorted=(rows,key)=>rows.map(row=>Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b)))).sort((a,b)=>String(a[key]).localeCompare(String(b[key])));
try {
  const [tsList,rsList,tsTemplates,rsTemplates]=await Promise.all([ts.listResources(),rs.listResources(),ts.listResourceTemplates(),rs.listResourceTemplates()]);
  deepStrictEqual(sorted(rsList.resources,'uri'),sorted(tsList.resources,'uri'));
  deepStrictEqual(sorted(rsTemplates.resourceTemplates,'uriTemplate'),sorted(tsTemplates.resourceTemplates,'uriTemplate'));
  const bundle=JSON.parse(readFileSync(new URL('../rust/resources/resource-texts.json',import.meta.url),'utf8'));
  let checked=0;
  for(const [uri,expected] of Object.entries(bundle.text)) {
    // The MCP template variable is one URI segment. Names with a slash are
    // present in the generated index but have no routable TypeScript URI.
    if(uri.startsWith('carve://lint-rules/') && uri.slice('carve://lint-rules/'.length).includes('/')) continue;
    const [a,b]=await Promise.all([ts.readResource({uri}),rs.readResource({uri})]);
    const aText=a.contents[0]?.text,bText=b.contents[0]?.text;
    deepStrictEqual(bText,aText,`Rust and TypeScript disagree at ${uri}`);
    deepStrictEqual(bText,expected,`Rust resource ${uri} is not the generated 0.2 text`);
    checked++;
  }
  console.log(`${checked} Carve 0.2 resources and all resource templates agree.`);
} finally {await Promise.all([ts.close(),rs.close()]);}
