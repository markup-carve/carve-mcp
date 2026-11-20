import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { deepStrictEqual, ok } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const metadata=JSON.parse(execFileSync('cargo',['metadata','--manifest-path','rust/Cargo.toml','--format-version=1','--no-deps'],{encoding:'utf8'}));
const rust=`${process.env.CARGO_TARGET_DIR ?? metadata.target_directory}/debug/carve-mcp-rs`;
const roots=[mkdtempSync(join(tmpdir(),'carve-mcp-v2-ts-')),mkdtempSync(join(tmpdir(),'carve-mcp-v2-rs-'))];
for(const root of roots){
  mkdirSync(join(root,'docs'));
  writeFileSync(join(root,'index.crv'),'= Home\n\n[Guide](docs/guide.crv#Guide)\n');
  writeFileSync(join(root,'docs/guide.crv'),'= Guide\n\nBody.\n');
  writeFileSync(join(root,'docs/child.crv'),'Child text.\n');
  mkdirSync(join(root,'src'));
  writeFileSync(join(root,'src/server.js'),'// #region start\nexport const shown = 2;\n// #endregion\n');
}
const clean=(value)=>{
  if(Array.isArray(value))return value.map(clean);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,clean(v)]));
  return value;
};
function normalized(value){
  const copy=structuredClone(value);
  if(copy?.versions?.engine) copy.versions.engine='<engine pin>';
  return clean(copy);
}
async function connect(command,args){const client=new Client({name:'rust-v2-conformance',version:'0.2'});
  await client.connect(new StdioClientTransport({command,args,stderr:'pipe'}));return client;}
async function call(client,name,args){const response=await client.callTool({name,arguments:args});
  const value=response.structuredContent??JSON.parse(response.content[0].text);
  return {isError:response.isError??false,value:normalized(value)};}
const typescript=await connect(process.execPath,['dist/index.js','--root',roots[0],'--allow-write']);
const native=await connect(rust,['--root',roots[1],'--allow-write']);
try {
  const tsTools=(await typescript.listTools()).tools.map(x=>x.name).sort();
  const rsTools=(await native.listTools()).tools.map(x=>x.name).sort();
  deepStrictEqual(rsTools,tsTools,'The Rust server must offer every TypeScript tool.');
  const source='= Title\n\nBody.\n';
  const parsed=(await call(typescript,'carve_parse',{source,positions:false})).value;
  const after=(await call(typescript,'carve_parse',{source:'= Changed\n\nBody.\n',positions:false})).value;
  const patch=(await call(typescript,'carve_create_ast_patch',{before:parsed,after})).value.operations;
  const reversible=(await call(typescript,'carve_create_reversible_ast_patch',{before:parsed,after})).value;
  const cases=[
    ['carve_lint',{source}],['carve_diagnose_and_fix',{source}],['carve_format',{source}],
    ...['html','markdown','plain','ansi'].map(target=>['carve_render',{source,target}]),
    ['carve_check_targets',{source,targets:['html','markdown','github','pdf']}],
    ['carve_parse',{source,positions:false}],
    ['carve_create_ast_patch',{before:parsed,after}],
    ['carve_apply_ast_patch',{ast:parsed,operations:patch}],
    ['carve_select_ast_nodes',{ast:parsed,selector:{kind:'node-type',value:'heading'}}],
    ['carve_get_block',{source,selector:{kind:'node-type',value:'paragraph'}}],
    ['carve_replace_source',{source,selector:{kind:'node-type',value:'paragraph'},text:'Changed.'}],
    ['carve_plan_ast_edit',{source,selector:{kind:'heading-id',value:'Title'},edit:{kind:'replace-text',text:'Changed'}}],
    ['carve_create_reversible_ast_patch',{before:parsed,after}],
    ['carve_apply_reversible_ast_patch',{source,patch:reversible}],
    ...['html','markdown','gfm','djot'].map(format=>['carve_migrate',{source:format==='html'?'<p>Hello</p>':'# Hello\n',format}]),
    ['carve_upgrade',{source:'# Hello\n'}],
    ['carve_render',{source:'{{ docs/child.crv }}\n',target:'html',includeRootIndex:0}],
    ['carve_render',{source:'{{ src/server.js @region:start @code:js }}\n',target:'html',includeRootIndex:0}],
    ['carve_parse',{source:'{{ docs/child.crv }}\n',includeRootIndex:0}],
    ['carve_lint',{source:'{{ docs/child.crv }}\n',includeRootIndex:0}],
    ['carve_workspace_info',{}],['carve_read_file',{rootIndex:0,path:'index.crv'}],
    ['carve_list_files',{rootIndex:0}],['carve_review_workspace',{rootIndex:0}],
    ['carve_reference_graph',{rootIndex:0}],['carve_prepare_edit',{rootIndex:0,path:'index.crv'}],
    ['carve_prepare_workspace_edits',{rootIndex:0}],
    ['carve_write_file',{rootIndex:0,path:'new.crv',content:'= New\n',dryRun:true}],
    ['carve_reviewed_edit',{rootIndex:0,path:'docs/guide.crv',selector:{kind:'node-type',value:'paragraph'},text:'Rewritten.'}],
  ];
  let failures=0;
  for(const [name,args] of cases){
    const [left,right]=await Promise.all([call(typescript,name,args),call(native,name,args)]);
    try{deepStrictEqual(right,left);}
    catch{failures++;console.error(`Mismatch ${name} ${JSON.stringify(args).slice(0,180)}\nTS ${JSON.stringify(left).slice(0,2600)}\nRS ${JSON.stringify(right).slice(0,2600)}`);}
  }
  const editArgs={rootIndex:0,path:'docs/guide.crv',selector:{kind:'node-type',value:'paragraph'},
    text:'Rewritten.',dryRun:false,
    expectedSha256:(await call(typescript,'carve_read_file',{rootIndex:0,path:'docs/guide.crv'})).value.sha256};
  const [tsEdit,rsEdit]=await Promise.all([call(typescript,'carve_reviewed_edit',editArgs),call(native,'carve_reviewed_edit',editArgs)]);
  const tsReceipt=tsEdit.value.undoReceipt,rsReceipt=rsEdit.value.undoReceipt;
  if(typeof tsReceipt==='string')tsEdit.value.undoReceipt='<signed receipt>';
  if(typeof rsReceipt==='string')rsEdit.value.undoReceipt='<signed receipt>';
  try{deepStrictEqual(rsEdit,tsEdit);}catch{failures++;console.error(`Reviewed edit mismatch\nTS ${JSON.stringify(tsEdit)}\nRS ${JSON.stringify(rsEdit)}`);}
  if(typeof tsReceipt==='string'&&typeof rsReceipt==='string') {
    const [tsUndo,rsUndo]=await Promise.all([call(typescript,'carve_undo_reviewed_edit',{receipt:tsReceipt}),call(native,'carve_undo_reviewed_edit',{receipt:rsReceipt})]);
    try{deepStrictEqual(rsUndo,tsUndo);}catch{failures++;console.error(`Reviewed undo mismatch\nTS ${JSON.stringify(tsUndo)}\nRS ${JSON.stringify(rsUndo)}`);}
  }else { failures++;console.error('A reviewed edit did not return a signed undo receipt.'); }
  ok(!failures,`${failures} Rust 0.2 tool comparisons differed.`);
  console.log(`${cases.length+2} Carve 0.2 tool calls and ${tsTools.length} tool names agree.`);
} finally {await Promise.all([typescript.close(),native.close()]);}
