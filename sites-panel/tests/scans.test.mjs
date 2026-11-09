import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {handleMcp} from '../src/mcp.mjs';
import {handleApi} from '../src/api.mjs';
const identity={'oai-authenticated-user-id':'owner'};
const base={run_id:'cycle-1',source_id:'fl',checked_at:'2026-11-01T00:00:00.000Z',status:'empty',source_url:'https://www.fl.ru/projects/category/inzhiniring/autocad/',scope:'section',observed_count:0,saved_count:0,reason:'no_matches'};
const request=(name,args,headers=identity)=>new Request('https://site.example/mcp',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
async function call(env,name,args,headers){const response=await handleMcp(request(name,args,headers),env),body=await response.json();return {status:response.status,body,data:body.result?.content?JSON.parse(body.result.content[0].text):null};}
const setup=()=>{const db=fixture();return {db,env:{DB:db,OWNER_USER_ID:'owner'}};};
test('empty scan is recorded without listings, exact retry is idempotent, conflicting retry rejected',async()=>{const {db,env}=setup();try{
 let r=await call(env,'bid_record_scan',base);assert.equal(r.body.result.isError,undefined);assert.equal(r.data.duplicate,false);
 r=await call(env,'bid_record_scan',base);assert.equal(r.data.duplicate,true);
 r=await call(env,'bid_record_scan',{...base,status:'blocked',reason:'access_denied'});assert.equal(r.data.error,'scan_conflict');
 const coverage=(await call(env,'bid_scan_coverage',{run_id:base.run_id})).data;assert.equal(coverage.recorded,1);assert.equal(coverage.completed,1);assert.equal(coverage.status_counts.empty,1);assert.equal(coverage.sources.find(s=>s.id==='fl').check.status,'empty');
 const state=await (await handleApi(new Request('https://site.example/api/state',{headers:identity}),env)).json();assert.equal(state.listings.length,0);assert.equal(state.sources.find(s=>s.id==='fl').code,'empty');assert.equal(state.sources.find(s=>s.id==='fl').last_checked_at,base.checked_at);
 }finally{db.close();}});
test('blocked channel is exact, distinct from aggregate and other channels; cycle coverage is not claimed complete',async()=>{const {db,env}=setup();try{
 await call(env,'bid_record_scan',{...base,source_id:'telegram:cgfreelance',source_url:'https://t.me/s/cgfreelance',status:'blocked',reason:'access_denied'});
 const c=(await call(env,'bid_scan_coverage',{run_id:base.run_id})).data;assert.equal(c.recorded,1);assert.equal(c.completed,0);assert.equal(c.status_counts.blocked,1);assert.equal(c.sources.find(s=>s.id==='telegram:cgfreelance').check.status,'blocked');assert.equal(c.sources.find(s=>s.id==='telegram:job_design').check,null);assert.equal(c.sources.some(s=>s.id==='telegram'),false);
 assert.equal((await call(env,'bid_scan_coverage',{run_id:'another'})).data.recorded,0);
 }finally{db.close();}});
test('scan tools reject anonymous/non-owner and cannot select another owner',async()=>{const {db,env}=setup();try{
 for(const name of ['bid_record_scan','bid_scan_coverage']){assert.equal((await call(env,name,base,{})).status,401);assert.equal((await call(env,name,base,{'oai-authenticated-user-id':'other'})).status,403);}
 assert.equal((await call(env,'bid_record_scan',{...base,owner_id:'other'})).data.error,'invalid_scan');
 await call(env,'bid_record_scan',base);assert.equal((await call({...env,OWNER_USER_ID:'other'},'bid_scan_coverage',{run_id:base.run_id},{'oai-authenticated-user-id':'other'})).data.recorded,0);
 }finally{db.close();}});
test('bounded diagnostics reject credentials, unsupported identities, arbitrary text and impossible counts',async()=>{const {db,env}=setup();try{
 for(const patch of [{source_id:'telegram'},{source_id:'telegram:CGfreelance'},{source_id:'kwork'},{source_url:'https://evil.example/'},{source_url:'https://user:pass@www.fl.ru/'},{source_url:'https://www.fl.ru/?token=secret'},{source_url:'https://www.fl.ru/#secret'},{source_url:'http://www.fl.ru/'},{source_url:'https://www.fl.ru/private-secret'},{reason:'Bearer secret'},{reason:'x'.repeat(501)},{observed_count:-1},{observed_count:1000001},{saved_count:1},{checked_at:'invalid'},{checked_at:'2099-01-01T00:00:00.000Z'},{run_id:'x'.repeat(129)},{status:'available'},{token:'secret'}])assert.equal((await call(env,'bid_record_scan',{...base,...patch})).data.error,'invalid_scan',JSON.stringify(patch));
 assert.equal((await call(env,'bid_record_scan',{...base,source_id:'telegram:cgfreelance',source_url:'https://t.me/job_design'})).data.error,'invalid_scan');
 }finally{db.close();}});
test('all exact catalog sources support skipped records and success is distinct from empty',async()=>{const {db,env}=setup();try{
 const c=(await call(env,'bid_scan_coverage',{run_id:'cycle-all'})).data;assert.ok(c.expected>=15);
 for(const s of c.sources){const r=await call(env,'bid_record_scan',{...base,run_id:'cycle-all',source_id:s.id,source_url:s.scan_urls[0],scope:s.scan_targets[0].scope,status:'skipped',reason:'not_attempted'});assert.equal(r.body.result.isError,undefined,s.id);}
 const all=(await call(env,'bid_scan_coverage',{run_id:'cycle-all'})).data;assert.equal(all.recorded,all.expected);assert.equal(all.completed,0);
 assert.equal((await call(env,'bid_record_scan',{...base,run_id:'success',status:'success',reason:'checked',observed_count:3,saved_count:1})).body.result.isError,undefined);
 }finally{db.close();}});
test('latest check follows checked_at rather than ingestion order; cycle coverage GET is read-only and owner-only',async()=>{const {db,env}=setup();try{
 await call(env,'bid_record_scan',{...base,run_id:'new',checked_at:'2026-11-01T01:00:00.000Z',status:'auth_required',reason:'login_required'});await call(env,'bid_record_scan',base);
 const state=await (await handleApi(new Request('https://site.example/api/state',{headers:identity}),env)).json();assert.equal(state.sources.find(s=>s.id==='fl').code,'auth_required');assert.equal(state.scan.coverage.run_id,'new');
 for(const [headers,status] of [[{},401],[{'oai-authenticated-user-id':'other'},403],[identity,200]])assert.equal((await handleApi(new Request('https://site.example/api/scan-coverage?run_id=cycle-1',{headers}),env)).status,status);
 assert.equal((await handleApi(new Request('https://site.example/api/scan-coverage?run_id=cycle-1&owner_id=other',{headers:identity}),env)).status,400);
 }finally{db.close();}});
test('concurrent identical retries write one row and diagnostics never mutate legacy tables',async()=>{const {db,env}=setup();try{
 await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?)').bind('owner','kwork','legacy','{"title":"kept"}','{}','old','old',4).run();
 await db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?)').bind('owner','kwork','legacy','{"state":"queued","claim_token":"synthetic-only"}',2,'keep-op').run();
 const before=await Promise.all(['listings','reviews','review_events'].map(t=>db.prepare('SELECT * FROM '+t).all()));
 const results=await Promise.all(Array.from({length:8},()=>call(env,'bid_record_scan',base)));assert.equal(results.filter(r=>r.data.duplicate===false).length,1);assert.equal((await db.prepare('SELECT count(*) n FROM scan_runs').first()).n,1);
 assert.deepEqual(await Promise.all(['listings','reviews','review_events'].map(t=>db.prepare('SELECT * FROM '+t).all())),before);
 }finally{db.close();}});
test('contradictory diagnostics cannot be represented as completed checks',async()=>{const {db,env}=setup();try{
 for(const patch of [{status:'success',reason:'login_required',observed_count:1},{status:'empty',reason:'captcha'},{status:'blocked',reason:'checked'},{status:'auth_required',reason:'no_matches'},{status:'error',reason:'checked'},{status:'skipped',reason:'checked'}])assert.equal((await call(env,'bid_record_scan',{...base,...patch})).data.error,'invalid_scan');
 assert.equal((await call(env,'bid_scan_coverage',{run_id:base.run_id})).data.recorded,0);
 }finally{db.close();}});
test('coverage explicitly distinguishes missing reports from skipped and failed checks',async()=>{const {db,env}=setup();try{
 await call(env,'bid_record_scan',base);
 const c=(await call(env,'bid_scan_coverage',{run_id:base.run_id})).data;
 assert.equal(c.missing,c.expected-1);assert.equal(c.all_reported,false);assert.equal(c.all_completed,false);
 }finally{db.close();}});
test('concurrent conflicting retries never overwrite first recorded result',async()=>{const {db,env}=setup();try{
 const results=await Promise.all([call(env,'bid_record_scan',base),call(env,'bid_record_scan',{...base,status:'blocked',reason:'captcha'})]);
 assert.equal(results.filter(r=>r.data.error==='scan_conflict').length,1);
 const c=(await call(env,'bid_scan_coverage',{run_id:base.run_id})).data;
 assert.equal(c.recorded,1);assert.equal(c.sources.find(s=>s.id==='fl').check.status,'empty');
 }finally{db.close();}});
test('exact public section URLs require matching scope and reject URL origin tricks',async()=>{const {db,env}=setup();try{
 const scoped={...base,scope:'section',source_url:'https://www.fl.ru/projects/category/inzhiniring/autocad/'};
 assert.equal((await call(env,'bid_record_scan',scoped)).body.result.isError,undefined);
 for(const patch of [{scope:'root'},{scope:'single_item'},{scope:'legacy_unknown'},{source_url:'https://www.fl.ru/'},{source_url:scoped.source_url+'?token=x'},{source_url:'https://www.fl.ru.evil.test/projects/category/inzhiniring/autocad/'},{source_url:'https://user@www.fl.ru/projects/category/inzhiniring/autocad/'},{source_url:scoped.source_url+'#secret'},{source_url:'https://www.fl.ru/projects/category/inzhiniring/other/'}])assert.equal((await call(env,'bid_record_scan',{...scoped,run_id:'invalid',...patch})).data.error,'invalid_scan');
 const {scope,...missing}=scoped;assert.equal((await call(env,'bid_record_scan',missing)).data.error,'invalid_scan');
 }finally{db.close();}});
test('single item is explicit, Telegram has exact case aliases, and partial observations are preserved',async()=>{const {db,env}=setup();try{
 for(const [source_id,source_url,scope,status,observed_count,reason] of [['vmasshtabe','https://vmasshtabe.ru/task/pnevmovibrostol','single_item','success',1,'checked'],['telegram:help_kirill_autocad','https://t.me/s/help_kirill_autoCAD','section','empty',20,'no_matches'],['3ddd','https://3ddd.ru/work','section','error',7,'unavailable']]){
 const r=await call(env,'bid_record_scan',{...base,source_id,source_url,scope,status,observed_count,reason});assert.equal(r.body.result.isError,undefined,source_id);
 }
 const c=(await call(env,'bid_scan_coverage',{run_id:base.run_id})).data;assert.equal(c.scope_counts.single_item,1);assert.equal(c.completed_source_checks,1);assert.equal(c.completed,2);
 assert.equal(c.sources.find(s=>s.id==='3ddd').check.observed_count,7);
 }finally{db.close();}});
test('historical scan JSON remains byte-identical and reads as unknown scope, not a platform scan',async()=>{const {db,env}=setup();try{
 const {scope,...old}=base;const data=JSON.stringify(old);
 await db.prepare('INSERT INTO scan_runs VALUES (?,?,?,?,?,?)').bind('owner',old.run_id,old.source_id,old.checked_at,old.checked_at,data).run();
 const c=(await call(env,'bid_scan_coverage',{run_id:old.run_id})).data;assert.equal(c.sources.find(s=>s.id==='fl').check.scope,'legacy_unknown');assert.equal(c.scope_counts.legacy_unknown,1);assert.equal(c.completed_source_checks,0);
 const state=await (await handleApi(new Request('https://site.example/api/state',{headers:identity}),env)).json();assert.equal(state.sources.find(s=>s.id==='fl').last_check.scope,'legacy_unknown');
 assert.equal((await db.prepare('SELECT data FROM scan_runs').first()).data,data);
 }finally{db.close();}});
test('empty may count viewed nonmatches; partial errors preserve saved counts while skipped cannot claim observations',async()=>{const {db,env}=setup();try{
 assert.equal((await call(env,'bid_record_scan',{...base,observed_count:20})).body.result.isError,undefined);
 assert.equal((await call(env,'bid_record_scan',{...base,run_id:'empty-saved',observed_count:20,saved_count:1})).data.error,'invalid_scan');
 for(const [status,reason] of [['blocked','captcha'],['auth_required','login_required'],['error','timeout']]){
 const r=await call(env,'bid_record_scan',{...base,run_id:status,status,reason,observed_count:5,saved_count:1});assert.equal(r.data.scan.observed_count,5);assert.equal(r.data.scan.saved_count,1);
 }
 assert.equal((await call(env,'bid_record_scan',{...base,run_id:'skip',status:'skipped',reason:'not_attempted',observed_count:1})).data.error,'invalid_scan');
 }finally{db.close();}});
test('RSS URLs are exact safe literals, not arbitrary query endpoints, and errors never imply empty',async()=>{const {db,env}=setup();try{
 for(const [i,url] of ['https://www.fl.ru/rss/?category=20','https://www.fl.ru/rss/all.xml'].entries()){
 const r=await call(env,'bid_record_scan',{...base,run_id:'rss-'+i,source_url:url,status:'error',reason:'unavailable'});assert.equal(r.data.scan.status,'error');
 const c=(await call(env,'bid_scan_coverage',{run_id:'rss-'+i})).data;assert.equal(c.completed,0);assert.equal(c.status_counts.empty,0);
 }
 for(const url of ['https://www.fl.ru/rss/?category=21','https://www.fl.ru/rss/?category=20&token=x','https://www.fl.ru/rss/?category=%32%30'])assert.equal((await call(env,'bid_record_scan',{...base,source_url:url})).data.error,'invalid_scan');
 }finally{db.close();}});
test('scope is required by MCP discovery and retry cannot silently change checked target',async()=>{const {db,env}=setup();try{
 const response=await handleMcp(new Request('https://site.example/mcp',{method:'POST',headers:{'Content-Type':'application/json',...identity},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),env);
 const tool=(await response.json()).result.tools.find(t=>t.name==='bid_record_scan');assert.ok(tool.inputSchema.required.includes('scope'));assert.deepEqual(tool.inputSchema.properties.scope.enum,['root','section','single_item']);
 await call(env,'bid_record_scan',base);
 assert.equal((await call(env,'bid_record_scan',{...base,source_url:'https://www.fl.ru/rss/?category=20'})).data.error,'scan_conflict');
 const crossOrigin=await handleMcp(new Request('https://site.example/mcp',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example',...identity},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bid_record_scan',arguments:{...base,run_id:'cross-origin'}}})}),env);
 assert.equal(crossOrigin.status,403);assert.equal((await call(env,'bid_scan_coverage',{run_id:'cross-origin'})).data.recorded,0);
 }finally{db.close();}});
test('a single-item scope cannot claim multiple viewed items',async()=>{const {db,env}=setup();try{
 assert.equal((await call(env,'bid_record_scan',{...base,source_id:'vmasshtabe',source_url:'https://vmasshtabe.ru/task/pnevmovibrostol',scope:'single_item',status:'success',reason:'checked',observed_count:2})).data.error,'invalid_scan');
 }finally{db.close();}});
test('reviewed engineering sections record their actual URL and preserve partial outcomes',async()=>{const {db,env}=setup();try{
 const targets=[['fl','https://www.fl.ru/projects/category/inzhiniring/'],['weblancer','https://www.weblancer.net/freelance/chertezhi-i-skhemi-78/']];
 for(const [source_id,source_url] of targets){
  const scan={...base,source_id,source_url,status:'error',reason:'parse_failed',observed_count:4,saved_count:2};
  const r=await call(env,'bid_record_scan',scan);assert.equal(r.body.result.isError,undefined,source_id);assert.equal(r.data.scan.source_url,source_url);assert.equal(r.data.scan.observed_count,4);assert.equal(r.data.scan.saved_count,2);
  assert.equal((await call(env,'bid_record_scan',scan)).data.duplicate,true);
  for(const suffix of ['?token=secret','#secret','unreviewed/'])assert.equal((await call(env,'bid_record_scan',{...scan,run_id:'invalid',source_url:source_url+suffix})).data.error,'invalid_scan');
 }
 const c=(await call(env,'bid_scan_coverage',{run_id:base.run_id})).data;assert.equal(c.recorded,2);assert.equal(c.completed,0);assert.equal(c.completed_source_checks,0);assert.equal(c.status_counts.error,2);
 for(const [source_id,source_url] of targets){const s=c.sources.find(x=>x.id===source_id);assert.ok(s.scan_urls.includes(source_url));assert.equal(s.check.source_url,source_url);assert.equal(s.check.saved_count,2);}
 assert.equal((await db.prepare('SELECT count(*) n FROM listings').first()).n,0);assert.equal((await db.prepare('SELECT count(*) n FROM reviews').first()).n,0);
 }finally{db.close();}});
test('reviewed 3ddd section and DWG feeds retain exact targets without implying fresh listings',async()=>{const {db,env}=setup();try{
 const targets=[['3ddd','https://3ddd.ru/work/tasks'],['dwg','https://dwg.ru/rss/rssforumt33.xml'],['dwg','https://dwg.ru/rss/rssforum33.xml']];
 for(const [i,[source_id,source_url]] of targets.entries()){
  const scan={...base,run_id:'reviewed-feed-'+i,source_id,source_url,observed_count:5};
  const r=await call(env,'bid_record_scan',scan);assert.equal(r.body.result.isError,undefined,source_url);assert.equal(r.data.scan.source_url,source_url);assert.equal(r.data.scan.scope,'section');assert.equal(r.data.scan.status,'empty');assert.equal(r.data.scan.saved_count,0);
  for(const patch of [{scope:'root'},{scope:'single_item'},{source_url:source_url+'?token=secret'},{source_url:source_url+'#secret'},{source_url:source_url+'/unreviewed'}])assert.equal((await call(env,'bid_record_scan',{...scan,run_id:'invalid',...patch})).data.error,'invalid_scan');
  const c=(await call(env,'bid_scan_coverage',{run_id:scan.run_id})).data;const s=c.sources.find(x=>x.id===source_id);assert.ok(s.scan_urls.includes(source_url));assert.equal(s.check.source_url,source_url);assert.equal(c.all_completed,false);
 }
 assert.equal((await db.prepare('SELECT count(*) n FROM listings').first()).n,0);assert.equal((await db.prepare('SELECT count(*) n FROM reviews').first()).n,0);
 }finally{db.close();}});
