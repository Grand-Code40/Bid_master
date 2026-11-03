import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../build/worker.mjs';
import {fixture} from './d1-fixture.mjs';
test('bundled Worker routes MCP through owner checks without exposing approval tools',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner'};
 try{const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'});
 const denied=await worker.fetch(new Request('https://test/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body}),env);assert.equal(denied.status,401);
 const accepted=await worker.fetch(new Request('https://test/mcp',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'owner'},body}),env);assert.equal(accepted.status,200);assert.deepEqual((await accepted.json()).result.tools.map(x=>x.name),['bid_read_mail','bid_ingest','bid_draft','bid_record_manual_delivery','bid_readback','bid_record_scan','bid_scan_coverage','bid_record_mail','bid_observe_delivery','bid_mark_delivery_error','bid_delivery_log']);
 }finally{db.close();}
});
test('bundled Worker protects HTML and serves only self-contained client assets',async()=>{
 const env={OWNER_USER_ID:'owner'},headers={'oai-authenticated-user-id':'owner'};
 assert.equal((await worker.fetch(new Request('https://test/'),env)).status,401);
 const response=await worker.fetch(new Request('https://test/',{headers}),env);assert.equal(response.status,200);assert.match(await response.text(),/CAIgraph/);assert.match(response.headers.get('Content-Security-Policy'),/script-src 'self'/);
 assert.equal((await worker.fetch(new Request('https://test/app.js',{headers}),env)).status,200);
 assert.equal((await worker.fetch(new Request('https://test/.env',{headers}),env)).status,404);
});
test('bundled Worker round-trips writer observation through database to owner',async()=>{
 const db=fixture(),token='test-secret-minimum-32-characters-long',env={DB:db,OWNER_USER_ID:'owner',WRITER_TOKEN:token};
 try{const observation={source_id:'freelance',external_id:'123',canonical_url:'https://freelance.ru/task/view/123',title:'Real-shaped test fixture only',observed_at:'2026-11-01T00:00:00Z',listing_kind:'order'};
 const written=await worker.fetch(new Request('https://test/api/agent/ingest',{method:'POST',headers:{'Content-Type':'application/json','X-Bid-Writer-Token':token},body:JSON.stringify([observation])}),env);assert.equal(written.status,200);
 const read=await worker.fetch(new Request('https://test/api/state',{headers:{'oai-authenticated-user-id':'owner'}}),env);assert.equal(read.status,200);assert.equal((await read.json()).listings[0].external_id,'123');
 }finally{db.close();}
});
test('bundled scan journal validates writes, enforces owner scope, and exposes read-only coverage',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner'},headers={'Content-Type':'application/json','oai-authenticated-user-id':'owner'};
 const check={run_id:'bundle-cycle',source_id:'fl',checked_at:'2026-11-01T00:00:00.000Z',status:'empty',reason:'no_matches',source_url:'https://www.fl.ru/projects/category/inzhiniring/autocad/',scope:'section',observed_count:0,saved_count:0};
 const call=(args,h=headers)=>worker.fetch(new Request('https://test/mcp',{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bid_record_scan',arguments:args}})}),env);
 try{
 assert.equal((await call(check,{'Content-Type':'application/json'})).status,401);
 assert.equal((await call(check,{...headers,'oai-authenticated-user-id':'other'})).status,403);
 const invalid=await (await call({...check,reason:'not_attempted'})).json();assert.equal(invalid.result.isError,true);
 const written=await (await call(check)).json();assert.equal(JSON.parse(written.result.content[0].text).duplicate,false);
 const duplicate=await (await call(check)).json();assert.equal(JSON.parse(duplicate.result.content[0].text).duplicate,true);
 const response=await worker.fetch(new Request('https://test/api/scan-coverage?run_id=bundle-cycle',{headers}),env);
 assert.equal(response.status,200);const c=await response.json();assert.equal(c.completed,1);assert.equal(c.missing,c.expected-1);assert.equal(c.reported,true);assert.equal(c.parsers_implemented,false);
 const state=await (await worker.fetch(new Request('https://test/api/state',{headers}),env)).json();assert.equal(state.sources.find(s=>s.id==='fl').code,'empty');assert.equal(state.sender.enabled,false);
 }finally{db.close();}
});
test('bundled MCP returns advisory provenance without content or secrets and keeps both cards',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner',WRITER_TOKEN:'synthetic-private-writer-token-12345'},headers={'Content-Type':'application/json','oai-authenticated-user-id':'owner'};
 try{const observations=['cad_jobs/1','cad_work/2'].map(id=>({source_id:'telegram',external_id:id,canonical_url:'https://t.me/'+id,title:'test only',description:'SYNTHETIC PRIVATE CONTENT '.repeat(20),detail_complete:true,observed_at:'2026-11-01T00:00:00Z'}));
 const result=await (await worker.fetch(new Request('https://test/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bid_ingest',arguments:{observations}}})}),env)).json();
 const data=JSON.parse(result.result.content[0].text);assert.equal(data.written,2);assert.equal(data.candidate_check.pairs.length,1);assert.ok(!JSON.stringify(data).includes('PRIVATE CONTENT'));assert.ok(!JSON.stringify(data).includes(env.WRITER_TOKEN));
 const state=await (await worker.fetch(new Request('https://test/api/state',{headers}),env)).json();assert.equal(state.listings.length,2);assert.equal(state.candidate_check.pairs.length,1);
 }finally{db.close();}
});
test('bundled manual-record MCP uses verified owner identity and persists terminal readback',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner'},headers={'Content-Type':'application/json','oai-authenticated-user-id':'owner'};
 const call=async(name,args,h=headers)=>worker.fetch(new Request('https://test/mcp',{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env);
 const unpack=async r=>JSON.parse((await r.json()).result.content[0].text);
 try{
 const identity={source_id:'vmasshtabe',external_id:'synthetic-manual'};
 await call('bid_ingest',{observations:[{...identity,canonical_url:'https://vmasshtabe.ru/task/synthetic-manual',title:'Synthetic only',listing_kind:'order',observed_at:'2026-11-01T00:00:00.000Z'}]});
 const row=await unpack(await call('bid_draft',{...identity,operation_id:'prepare'}));
 const args={...identity,operation_id:'manual',revision:row.revision,details:{text:row.text,observation:'Own reply visible, synthetic only',observed_at:'2026-11-02T00:00:00.000Z',delivery_url:'https://vmasshtabe.ru/account/view-task?id=123&response_id=456'}};
 assert.equal((await call('bid_record_manual_delivery',args,{'Content-Type':'application/json','X-Bid-Writer-Token':'not-owner'})).status,401);
 assert.equal((await unpack(await call('bid_record_manual_delivery',args))).state,'manual_sent');
 const read=await unpack(await call('bid_readback',identity));assert.equal(read.reviews[0].manual_delivery.delivery_url,args.details.delivery_url);
 assert.equal((await unpack(await call('bid_draft',{...identity,revision:row.revision,operation_id:'edit',text:'overwrite'}))).error,'review_locked');
 }finally{db.close();}
});
test('bundled correctable accounting MCP/API roundtrip preserves review and keeps owner-only client',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner'},origin='https://test',headers={'oai-authenticated-user-id':'owner','Content-Type':'application/json'},now='2026-11-03T00:00:00.000Z';
 try{const canonical_url='https://vmasshtabe.ru/task/synthetic';await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?)').bind('owner','vmasshtabe','synthetic',JSON.stringify({canonical_url}),'{}',now,now,1).run();const rpc=async(name,args)=>{const r=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env);const b=await r.json();assert.equal(b.result.isError,undefined,JSON.stringify(b));return JSON.parse(b.result.content[0].text);};
 const identity={source_id:'vmasshtabe',external_id:'synthetic'};assert.equal((await rpc('bid_observe_delivery',{...identity,version:0,operation_id:'observed',details:{text:'Real observed test fixture',observation:'Synthetic evidence',observed_at:now,canonical_url,delivery_url:'https://vmasshtabe.ru/account/view-task?id=1&response_id=2'}})).status,'observed');assert.equal((await rpc('bid_mark_delivery_error',{...identity,version:1,operation_id:'error',reason:'Synthetic correction'})).status,'erroneous');
 const log=await (await worker.fetch(new Request(origin+'/api/delivery-log?source_id=vmasshtabe&external_id=synthetic',{headers}),env)).json();assert.equal(log.events.length,2);assert.equal(log.record.auto_send_blocked,true);assert.equal((await db.prepare('SELECT * FROM reviews').all()).results.length,0);assert.equal((await worker.fetch(new Request(origin+'/delivery.js',{headers}),env)).status,200);assert.equal((await worker.fetch(new Request(origin+'/delivery.js'),env)).status,401);
 }finally{db.close();}
});

test('bundled mail read returns existing inbox without marking viewed',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner'};
 try{
 const request=()=>new Request('https://test/mcp',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'owner'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bid_read_mail',arguments:{}}})});
 await db.prepare('PRAGMA query_only=ON').run();
 const result=await(await worker.fetch(request(),env)).json();assert.equal(result.result.isError,undefined);assert.deepEqual(JSON.parse(result.result.content[0].text),{messages:[],next_cursor:null,import_mode:'observed_notifications_only'});
 }finally{db.close();}
});
