import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {handleApi} from '../src/api.mjs';
import {handleMcp} from '../src/mcp.mjs';
const origin='https://private.example';
const token='test-token-with-at-least-32-characters';
const item={source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html',title:'CAD order',listing_kind:'order',availability:'open',observed_at:'2026-11-01T00:00:00Z'};
const req=(path,method='GET',body,headers={})=>new Request(origin+path,{method,headers:{...(method==='POST'?{'Content-Type':'application/json',Origin:origin}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
const owner={'oai-authenticated-user-id':'owner'};
test('bootstrap identity is read-only, signed-in self only, and does not configure ownership',async()=>{
 const db=fixture();try{
 assert.equal((await handleApi(req('/api/identity'),{})).status,401);
 const identity=await handleApi(req('/api/identity','GET',undefined,owner),{});
 assert.equal(identity.status,200);assert.deepEqual(await identity.json(),{user_id:'owner',owner_configured:false});
 assert.equal((await handleApi(req('/api/identity','POST',{owner:'attacker'},owner),{})).status,405);
 assert.equal((await handleApi(req('/api/state','GET',undefined,owner),{DB:db})).status,503);
 }finally{db.close();}
});
test('identity and config fail closed, forged body role cannot authorize',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner',WRITER_TOKEN:token};try{
 assert.equal((await handleApi(req('/api/state'),env)).status,401);
 assert.equal((await handleApi(req('/api/state','GET',undefined,{'oai-authenticated-user-id':'other'}),env)).status,403);
 assert.equal((await handleApi(req('/api/state','GET',undefined,owner),{DB:db})).status,503);
 assert.equal((await handleApi(req('/api/review/approve','POST',{role:'owner'}),env)).status,401);
 }finally{db.close();}
});
test('writer can import actual observations and owner reads same persisted cards',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner',WRITER_TOKEN:token};try{
 const response=await handleApi(req('/api/agent/ingest','POST',[item],{'X-Bid-Writer-Token':token}),env);assert.equal(response.status,200);assert.equal((await response.json()).written,1);
 const state=await handleApi(req('/api/state','GET',undefined,owner),env);assert.equal(state.status,200);assert.equal((await state.json()).listings[0].title,'CAD order');
 assert.equal((await handleApi(req('/api/review/approve','POST',{}, {'X-Bid-Writer-Token':token}),env)).status,401);
 assert.equal((await handleApi(req('/api/agent/approve','POST',{}, {'X-Bid-Writer-Token':token}),env)).status,404);
 assert.equal((await handleApi(req('/api/agent/claim','POST',{}, {'X-Bid-Writer-Token':token}),env)).status,404);
 }finally{db.close();}
});
test('owner save workflow and origin restrictions; no fake scheduler',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner',WRITER_TOKEN:token};try{
 await handleApi(req('/api/agent/ingest','POST',[item],{'X-Bid-Writer-Token':token}),env);
 const body={source_id:'fl',external_id:'42',operation_id:'op1'};
 assert.equal((await handleApi(req('/api/review/prepare','POST',body,{...owner,Origin:'https://evil.test'}),env)).status,403);
 const prepared=await handleApi(req('/api/review/prepare','POST',body,owner),env);assert.equal(prepared.status,200);
 const saved=await handleApi(req('/api/review/save','POST',{...body,operation_id:'op2',revision:1,text:'my actual draft'},owner),env);assert.equal(saved.status,200);assert.equal((await saved.json()).revision,2);
 assert.equal((await handleApi(req('/api/review/approve','POST',{...body,operation_id:'op3',revision:1},owner),env)).status,409);
 assert.equal((await handleApi(req('/api/monitor','POST',{enabled:true},owner),env)).status,501);
 const state=await (await handleApi(req('/api/state','GET',undefined,owner),env)).json();assert.equal(state.monitor.enabled,false);assert.equal(state.reviews[0].text,'my actual draft');
 }finally{db.close();}
});
test('wrong writer secret, oversized body and unknown route rejected',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner',WRITER_TOKEN:token};try{
 assert.equal((await handleApi(req('/api/agent/ingest','POST',[item],{'X-Bid-Writer-Token':'wrong'}),env)).status,401);
 assert.equal((await handleApi(req('/api/review/save','POST',{text:'x'.repeat(40001)},owner),env)).status,413);
 assert.equal((await handleApi(req('/api/nothing','GET',undefined,owner),env)).status,404);
 }finally{db.close();}
});
test('delivery confirmation is separate owner-only exact snapshot and never exposes sender routes',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner',WRITER_TOKEN:token};try{
 await handleApi(req('/api/agent/ingest','POST',[item],{'X-Bid-Writer-Token':token}),env);
 const identity={source_id:'fl',external_id:'42'};
 const row=await (await handleApi(req('/api/review/prepare','POST',{...identity,operation_id:'p'},owner),env)).json();
 await handleApi(req('/api/review/approve','POST',{...identity,revision:1,operation_id:'a'},owner),env);
 const data={...identity,revision:1,operation_id:'confirm',details:{...identity,revision:1,canonical_url:item.canonical_url,text:row.text,sender_account:'me',recipient_account:'customer',price:null,currency:null,deadline:null,credit_cost:0}};
 assert.equal((await handleApi(req('/api/review/confirm_delivery','POST',data,{'X-Bid-Writer-Token':token}),env)).status,401);
 assert.equal((await handleApi(req('/api/review/confirm_delivery','POST',{...data,role:'owner'},owner),env)).status,400);
 const result=await handleApi(req('/api/review/confirm_delivery','POST',data,owner),env);assert.equal(result.status,200);assert.equal((await result.json()).delivery_confirmation.recipient_account,'customer');
 for(const path of ['/api/agent/confirm_delivery','/api/agent/claim','/api/agent/result'])assert.equal((await handleApi(req(path,'POST',data,{'X-Bid-Writer-Token':token}),env)).status,404);
 assert.equal((await handleApi(req('/api/review/claim','POST',data,owner),env)).status,404);
 const state=await (await handleApi(req('/api/state','GET',undefined,owner),env)).json();assert.equal(state.sender.enabled,false);assert.equal(state.sender.connected,false);assert.equal(state.sender.configured,false);
 }finally{db.close();}
});

test('active state excludes all legacy sources and counts without changing stored listings, reviews or audit',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner',WRITER_TOKEN:token};try{
 await handleApi(req('/api/agent/ingest','POST',[{...item,budget_min:100}],{'X-Bid-Writer-Token':token}),env);
 for(const source_id of ['fl','freelancer','kwork','freelancehunt']){
  if(source_id!=='fl')await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,1)').bind('owner',source_id,'42',JSON.stringify({...item,source_id,budget_min:100}),'{}',item.observed_at,item.observed_at).run();
  assert.equal((await handleApi(req('/api/review/prepare','POST',{source_id,external_id:'42',operation_id:'prepare-'+source_id},owner),env)).status,200);
 }
 const tables=['listings','reviews','review_events'];
 const snapshot=()=>Promise.all(tables.map(t=>db.prepare('SELECT * FROM '+t).all()));
 const before=await snapshot();
 const state=await(await handleApi(req('/api/state','GET',undefined,owner),env)).json();
 assert.deepEqual(state.listings.map(x=>x.source_id),['fl']);
 assert.deepEqual(state.reviews.map(x=>x.source_id),['fl']);
 assert.deepEqual(state.summary,{total:1,orders:1,vacancies:0,priced_orders:1});
 assert.equal(state.sources.some(x=>['freelancer','kwork','freelancehunt'].includes(x.id)),false);
 for(const source_id of ['freelancer','kwork','freelancehunt']){
  const response=await handleMcp(req('/mcp','POST',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bid_readback',arguments:{source_id,external_id:'42'}}},owner),env);
  const readback=JSON.parse((await response.json()).result.content[0].text);
  assert.equal(readback.listings[0].source_id,source_id);assert.equal(readback.reviews[0].source_id,source_id);
 }
 assert.deepEqual(await snapshot(),before);
 }finally{db.close();}
});
test('1000 newer legacy records cannot displace active listings or reviews before the snapshot limit',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner'};try{
 for(let i=0;i<=1001;i++){
  const source_id=i<1000?'kwork':'weblancer',external_id=String(i),owner_id=i===1001?'other':'owner';
  const at=i<1000?'2026-11-02T00:00:00Z':'2026-11-01T00:00:00Z';
  const listing={...item,source_id,external_id,budget_min:100};
  await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,1)').bind(owner_id,source_id,external_id,JSON.stringify(listing),'{}',at,at).run();
  await db.prepare('INSERT INTO reviews VALUES (?,?,?,?,1,?)').bind(owner_id,source_id,external_id,JSON.stringify({source_id,external_id,text:'Saved',state:'draft',revision:1}),'seed-'+i).run();
 }
 const state=await(await handleApi(req('/api/state','GET',undefined,owner),env)).json();
 assert.deepEqual(state.listings.map(x=>[x.source_id,x.external_id]),[['weblancer','1000']]);
 assert.deepEqual(state.reviews.map(x=>[x.source_id,x.external_id]),[['weblancer','1000']]);
 assert.deepEqual(state.summary,{total:1,orders:1,vacancies:0,priced_orders:1});
 // The historical snapshot used by unfiltered MCP readback is not redefined.
 const {ReviewStore}=await import('../src/store.mjs');
 const historical=await new ReviewStore(db).snapshot('owner');
 assert.equal(historical.listings.length,1000);assert.ok(historical.listings.every(x=>x.source_id==='kwork'));
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM listings').first()).n,1002);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM reviews').first()).n,1002);
 }finally{db.close();}
});
