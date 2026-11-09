import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {handleMcp} from '../src/mcp.mjs';
import {ReviewStore} from '../src/store.mjs';
const identity={'oai-authenticated-user-id':'site-owner'};
const request=(method,params={},headers=identity)=>new Request('https://site.example/mcp',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
const run=(env,name,args)=>handleMcp(request('tools/call',{name,arguments:args}),env);
const observation={source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html',title:'MCP isolated test',observed_at:'2026-11-01T00:00:00Z',listing_kind:'order',availability:'open'};
const unpack=async response=>{const body=await response.json();return {body,data:body.result?.content?.[0]?.text?JSON.parse(body.result.content[0].text):null};};
test('MCP fails closed for absent config, anonymous, wrong identity and bearer-only service',async()=>{
 const db=fixture();try{const env={DB:db,OWNER_USER_ID:'site-owner',WRITER_TOKEN:'an-existing-secret-not-needed-by-mcp'};
 assert.equal((await handleMcp(request('tools/list'),{})).status,503);
 assert.equal((await handleMcp(request('tools/list',{},{}),env)).status,401);
 assert.equal((await handleMcp(request('tools/list',{}, {'oai-authenticated-user-id':'other-owner'}),env)).status,403);
 assert.equal((await handleMcp(request('tools/list',{}, {'X-Bid-Writer-Token':env.WRITER_TOKEN,'OAI-Sites-Authorization':'Bearer anything'}),env)).status,401);
 }finally{db.close();}
});
test('discovery advertises ingest draft readback and scan diagnostics, not approval or sender',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'site-owner'};try{
 const discover=await (await handleMcp(request('server/discover'),env)).json();assert.deepEqual(discover.result.supportedVersions,['2026-07-28']);
 const listed=await (await handleMcp(request('tools/list'),env)).json();assert.deepEqual(listed.result.tools.map(x=>x.name),['bid_read_mail','bid_ingest','bid_draft','bid_record_manual_delivery','bid_readback','bid_record_scan','bid_scan_coverage','bid_record_mail','bid_link_mail_conversation','bid_read_inbox','bid_record_platform_message','bid_observe_delivery','bid_mark_delivery_error','bid_delivery_log']);
 for(const name of ['approve','queue','claim','active','result','bid_approve'])assert.equal((await unpack(await run(env,name,{}))).body.result.isError,true);
 }finally{db.close();}
});
test('owner-authorized MCP writes only agent operations and reads same owner records without token',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'site-owner'};try{
 let result=await unpack(await run(env,'bid_ingest',{observations:[observation]}));assert.equal(result.data.written,1);
 const args={source_id:'fl',external_id:'42',operation_id:'prepare1'};
 result=await unpack(await run(env,'bid_draft',args));assert.equal(result.data.state,'draft');
 const store=new ReviewStore(db),now=new Date().toISOString();await store.act('site-owner','fl','42',{action:'approve',revision:1,operation_id:'owner-approve'},{role:'owner',now});
 result=await unpack(await run(env,'bid_draft',{...args,operation_id:'save1',revision:1,text:'Edited by agent'}));assert.equal(result.data.state,'draft');assert.equal(result.data.approved_revision,null);
 result=await unpack(await run(env,'bid_readback',{source_id:'fl',external_id:'42'}));assert.equal(result.data.listings[0].title,observation.title);assert.equal(result.data.reviews[0].text,'Edited by agent');assert.equal(JSON.stringify(result.data).includes('claim_token'),false);
 assert.equal((await store.snapshot('other-owner')).listings.length,0);
 }finally{db.close();}
});
test('MCP forbids extra arguments, role injection, stale revision and invalid imports',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'site-owner'};try{
 assert.equal((await unpack(await run(env,'bid_ingest',{observations:[{...observation,state:'approved'}]}))).body.result.isError,true);
 await run(env,'bid_ingest',{observations:[observation]});await run(env,'bid_draft',{source_id:'fl',external_id:'42',operation_id:'p1'});
 for(const extra of [{role:'owner'},{action:'approve'},{owner_id:'other'},{claim_token:'secret'},{approved_revision:1}])assert.equal((await unpack(await run(env,'bid_draft',{source_id:'fl',external_id:'42',operation_id:'s1',revision:1,text:'changed',...extra}))).body.result.isError,true);
 assert.equal((await unpack(await run(env,'bid_draft',{source_id:'fl',external_id:'42',operation_id:'stale',revision:9,text:'changed'}))).data.error,'stale_revision');
 }finally{db.close();}
});
test('readback hides claim tokens, malformed JSON and wrong methods reject',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'site-owner'};try{
 await run(env,'bid_ingest',{observations:[observation]});const store=new ReviewStore(db),now=new Date().toISOString();await store.prepare('site-owner','fl','42',now,'p');
 for(const [action,operation_id] of [['approve','a'],['queue','q']])await store.act('site-owner','fl','42',{action,revision:1,operation_id},{role:'owner',now});
 const row=(await store.get('site-owner','fl','42')).data;
 const details={source_id:row.source_id,external_id:row.external_id,canonical_url:row.canonical_url,text:row.text,revision:row.revision,sender_account:'me',recipient_account:'customer',price:null,currency:null,deadline:null,credit_cost:0};
 await store.act('site-owner','fl','42',{action:'confirm_delivery',revision:1,operation_id:'consent',details},{role:'owner',now});
 const claimed=await store.claimNext('site-owner','fl','c',{role:'sender',enabled:true,now,newClaimToken:'S'.repeat(32),session:{source_id:'fl',sender_account:'me',authenticated:true,verified_at:now},preflight:{...details,verified_at:now,availability:'open',already_sent:false,form_supported:true}});
 assert.equal(claimed.claim_token,'S'.repeat(32));
 const text=await (await run(env,'bid_readback',{})).text();assert.equal(text.includes('S'.repeat(32)),false);assert.equal(text.includes('claim_token'),false);
 assert.equal((await handleMcp(new Request('https://site.example/mcp',{headers:identity}),env)).status,405);
 const bad=new Request('https://site.example/mcp',{method:'POST',headers:{...identity,'Content-Type':'application/json'},body:'{'});assert.equal((await handleMcp(bad,env)).status,400);
 }finally{db.close();}
});
test('MCP rejects oversized streams, cross-origin browser calls and JSON-RPC batches',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'site-owner'};try{
 const cross=await handleMcp(request('tools/list',{}, {...identity,Origin:'https://attacker.example'}),env);assert.equal(cross.status,403);
 const large=new Request('https://site.example/mcp',{method:'POST',headers:{...identity,'Content-Type':'application/json'},body:' '.repeat(4*1024*1024+1)});assert.equal((await handleMcp(large,env)).status,413);
 const batch=new Request('https://site.example/mcp',{method:'POST',headers:{...identity,'Content-Type':'application/json'},body:'[]'});assert.equal((await handleMcp(batch,env)).status,400);
 const unsupported=await handleMcp(request('owner/approve'),env);assert.equal((await unsupported.json()).error.code,-32601);
 }finally{db.close();}
});
test('MCP draft cannot change a queued reply or silently reuse operation ID with changed text',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'site-owner'};try{
 await run(env,'bid_ingest',{observations:[observation]});const args={source_id:'fl',external_id:'42',operation_id:'p1'};await run(env,'bid_draft',args);
 const change={...args,operation_id:'s1',revision:1,text:'agent draft'};await run(env,'bid_draft',change);
 assert.equal((await unpack(await run(env,'bid_draft',{...change,text:'changed reuse'}))).data.error,'operation_conflict');
 const store=new ReviewStore(db),now=new Date().toISOString();for(const [action,operation_id] of [['approve','a1'],['queue','q1']])await store.act('site-owner','fl','42',{action,revision:2,operation_id},{role:'owner',now});
 assert.equal((await unpack(await run(env,'bid_draft',{...args,operation_id:'s2',revision:2,text:'overwrite queued'}))).data.error,'review_locked');
 const row=await store.get('site-owner','fl','42');assert.equal(row.data.text,'agent draft');assert.equal(row.data.state,'queued');
 }finally{db.close();}
});
test('Sites protocol metadata stays outside strict business arguments and conveys no authority',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'site-owner'};try{
 const _meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'Sites',version:'1'},'io.modelcontextprotocol/clientCapabilities':{},owner_id:'other-owner',role:'owner'};
 const result=await unpack(await handleMcp(request('tools/call',{name:'bid_readback',arguments:{},_meta}),env));
 assert.equal(result.body.result.isError,undefined);assert.deepEqual(result.data.listings,[]);
 for(const args of [undefined,null,{}])assert.deepEqual((await unpack(await run(env,'bid_readback',args))).data.listings,[]);
 assert.equal((await handleMcp(request('tools/call',{name:'bid_readback',arguments:{},_meta},{}),env)).status,401);
 for(const args of [{_meta},{source_id:null,external_id:null},{source_id:'fl'},{owner_id:'other-owner'},[], '']){
  assert.equal((await unpack(await run(env,'bid_readback',args))).data.error,'invalid_arguments');
 }
 for(const meta of [null,[], 'metadata'])assert.equal((await unpack(await handleMcp(request('tools/call',{name:'bid_readback',arguments:{},_meta:meta}),env))).data.error,'invalid_arguments');
 }finally{db.close();}
});

test('manual record MCP requires trusted owner identity, never writer or role/metadata assertions',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'site-owner',WRITER_TOKEN:'existing-writer-token-with-over-32-characters'};try{
 const args={source_id:'vmasshtabe',external_id:'synthetic-task',operation_id:'manual',revision:1,details:{text:'Exact saved synthetic response',observation:'Own response visible',observed_at:'2026-11-03T00:00:00.000Z',delivery_url:'https://vmasshtabe.ru/account/view-task?id=123&response_id=456'}};
 const store=new ReviewStore(db),now=new Date().toISOString();
 for(const owner of ['site-owner','other-owner']){
 const item={...observation,source_id:args.source_id,external_id:args.external_id,canonical_url:'https://vmasshtabe.ru/task/synthetic-task'};
 await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?)').bind(owner,item.source_id,item.external_id,JSON.stringify(item),'{}',now,now,1).run();const row=await store.prepare(owner,args.source_id,args.external_id,now,'p');
 if(owner==='site-owner')args.details.text=row.text;
 }
 const params={name:'bid_record_manual_delivery',arguments:args,_meta:{owner_id:'site-owner',role:'owner'}};
 for(const headers of [{},{'X-Bid-Writer-Token':env.WRITER_TOKEN},{'OAI-Sites-Authorization':'Bearer forged','X-Bid-Writer-Token':env.WRITER_TOKEN},{'oai-authenticated-user-id':'other-owner'},{...identity,Origin:'https://evil.example'},{...identity,Origin:'null'}])assert.ok([401,403].includes((await handleMcp(request('tools/call',params,headers),env)).status));
 for(const extra of [{role:'owner'},{owner_id:'other-owner'},{action:'result'},{claim_token:'secret'},{snapshot:'forged'}])assert.equal((await unpack(await run(env,'bid_record_manual_delivery',{...args,...extra}))).data.error,'invalid_arguments');
 for(const change of [{text:'different'},{delivery_url:args.details.delivery_url+'&token=secret'},{observed_at:'2099-01-01T00:00:00.000Z'},{role:'owner'}])assert.equal((await unpack(await run(env,'bid_record_manual_delivery',{...args,details:{...args.details,...change}}))).body.result.isError,true);
 assert.equal((await unpack(await run(env,'bid_record_manual_delivery',{...args,revision:2}))).data.error,'stale_revision');
 const result=await unpack(await run(env,'bid_record_manual_delivery',args));assert.equal(result.data.state,'manual_sent');assert.equal(result.data.manual_delivery.text,args.details.text);
 assert.deepEqual((await unpack(await run(env,'bid_record_manual_delivery',args))).data,result.data);
 assert.equal((await unpack(await run(env,'bid_record_manual_delivery',{...args,details:{...args.details,observation:'Changed'}}))).data.error,'operation_conflict');
 assert.equal((await store.get('other-owner',args.source_id,args.external_id)).data.state,'draft');
 assert.equal((await unpack(await run(env,'bid_draft',{source_id:args.source_id,external_id:args.external_id,revision:1,text:'overwrite',operation_id:'edit'}))).data.error,'review_locked');
 for(const name of ['bid_approve','bid_queue','bid_claim','bid_result'])assert.equal((await unpack(await run(env,name,args))).data.error,'unknown_tool');
 assert.equal((await unpack(await run(env,'bid_readback',{source_id:args.source_id,external_id:args.external_id}))).data.reviews[0].state,'manual_sent');
 }finally{db.close();}
});
