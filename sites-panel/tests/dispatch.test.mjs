import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {ReviewStore} from '../src/store.mjs';
const now='2026-11-03T18:00:00.000Z';
const item={source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html',title:'Synthetic CAD order',listing_kind:'order',availability:'open'};
async function component(){const api=await import('../src/dispatch.mjs').catch(()=>({}));assert.equal(typeof api.sendDelivery,'function','owner delivery orchestration is missing');return api;}
async function setup(){
 const api=await component(),db=fixture(),store=new ReviewStore(db);
 await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,1)').bind('owner','fl','42',JSON.stringify(item),'{}',now,now).run();
 let row=await store.prepare('owner','fl','42',now,'prepare');
 row=await store.act('owner','fl','42',{action:'approve',revision:1,operation_id:'approve'},{role:'owner',now});
 const details={source_id:'fl',external_id:'42',canonical_url:item.canonical_url,text:row.text,revision:1,sender_account:'my-platform-account',recipient_account:'customer-42',price:100,currency:'RUB',deadline:'3 days',credit_cost:0};
 await store.act('owner','fl','42',{action:'confirm_delivery',revision:1,operation_id:'confirm',details},{role:'owner',now});
 let submitCount=0,readback='published',submitError=false;
 const requests=[];
 const env={SENDER_ENABLED:'true',SENDER_TRANSPORT_ID:'test-browser-v1',SENDER_SERVICE:{async fetch(request){
  const body=await request.json(),path=new URL(request.url).pathname;requests.push({path,body});
  if(path==='/inspect')return Response.json({version:1,transport_id:'test-browser-v1',details:body.snapshot,authenticated:true,availability:'open',already_sent:false,form_supported:true,idempotency_supported:true,verified_at:now});
  if(path==='/submit'){submitCount++;if(submitError)throw new Error('synthetic network failure');return Response.json({version:1,status:'accepted'});}
  if(path==='/readback')return Response.json(readback==='unknown'?{version:1,status:'unknown'}:{version:1,transport_id:'test-browser-v1',status:readback==='not_submitted'?'not_submitted':'published',details:readback==='mismatch'?{...body.snapshot,text:'Different text'}:body.snapshot,observed_at:now,...(readback==='not_submitted'?{proof:'durable_executor_ledger',action_started:false,terminal:true}:{response_id:'response-1',delivery_url:item.canonical_url})});
  throw new Error('Unexpected transport path');
 }}};
 return {api,db,store,env,details,requests,get submits(){return submitCount;},set readback(value){readback=value;},set submitError(value){submitError=value;}};
}
const identity={source_id:'fl',external_id:'42',revision:1};
async function ready(s){const p=await s.api.preflightDelivery(s.db,'owner',identity,s.env,now);return {...identity,operation_id:'send-one',preflight_id:p.preflight_id,confirmation_digest:p.confirmation_digest};}

test('fresh owner send is published only after exact readback and retry never submits again',async()=>{
 const s=await setup();try{
  const args=await ready(s),result=await s.api.sendDelivery(s.db,'owner',args,s.env,now);
  assert.equal(result.review.state,'sent');assert.equal(result.attempt.status,'sent');assert.equal(result.attempt.verification,'executor_readback');
  assert.equal(s.submits,1);assert.equal(s.requests.find(x=>x.path==='/submit').body.snapshot.text,s.details.text);
  assert.deepEqual(await s.api.sendDelivery(s.db,'owner',args,s.env,now),result);assert.equal(s.submits,1);
  assert.equal(JSON.stringify(result).includes('claim_token'),false);
 }finally{s.db.close();}
});

test('concurrent identical owner requests recover one durable attempt and one submit',async()=>{
 const s=await setup();try{
  const args=await ready(s),results=await Promise.all([s.api.sendDelivery(s.db,'owner',args,s.env,now),s.api.sendDelivery(s.db,'owner',args,s.env,now)]);
  assert.equal(s.submits,1);assert.equal(results[0].attempt.operation_id,results[1].attempt.operation_id);
  assert.equal((await s.db.prepare('SELECT count(*) AS n FROM delivery_attempts').first()).n,1);
  await assert.rejects(()=>s.api.sendDelivery(s.db,'owner',{...args,confirmation_digest:'changed'},s.env,now),/operation_conflict/);
 }finally{s.db.close();}
});

test('timeout and unverified readback remain uncertain; recovery reads without another submission',async()=>{
 const s=await setup();try{
  s.submitError=true;s.readback='unknown';const args=await ready(s);
  const result=await s.api.sendDelivery(s.db,'owner',args,s.env,now);assert.equal(result.review.state,'uncertain');assert.equal(s.submits,1);
  await assert.rejects(()=>s.api.sendDelivery(s.db,'owner',{...args,operation_id:'new-send'},s.env,now),/review_locked|preflight_used|stale_revision/);
  s.readback='published';const recovered=await s.api.recoverDelivery(s.db,'owner',{operation_id:'send-one'},s.env,now);
  assert.equal(recovered.review.state,'sent');assert.equal(s.submits,1);
  await assert.rejects(()=>s.api.recoverDelivery(s.db,'other',{operation_id:'send-one'},s.env,now),/attempt_not_found/);
 }finally{s.db.close();}
});

test('different text in published readback never becomes sent',async()=>{
 const s=await setup();try{s.readback='mismatch';const result=await s.api.sendDelivery(s.db,'owner',await ready(s),s.env,now);assert.equal(result.review.state,'uncertain');assert.equal(result.attempt.status,'uncertain');}finally{s.db.close();}
});

test('old confirmation without fresh preflight cannot start sending and disabled bindings fail closed',async()=>{
 const s=await setup();try{
  await assert.rejects(()=>s.api.sendDelivery(s.db,'owner',{...identity,operation_id:'old'},s.env,now),/invalid_dispatch/);
  await assert.rejects(()=>s.api.preflightDelivery(s.db,'owner',identity,{},now),/sender_disabled|sender_not_configured/);
  await assert.rejects(()=>s.api.preflightDelivery(s.db,'owner',{...identity,source_id:'weblancer'},s.env,now),/source_paused|source_not_supported/);
  assert.equal(s.submits,0);
 }finally{s.db.close();}
});

test('acknowledged cancel or closed order after preflight blocks external action',async()=>{
 for(const change of ['cancel','close']){
  const s=await setup();try{
   const args=await ready(s);
   if(change==='cancel')await s.store.act('owner','fl','42',{action:'cancel',revision:1,operation_id:'cancel'},{role:'owner',now});
   else await s.db.prepare('UPDATE listings SET data=?').bind(JSON.stringify({...item,availability:'closed'})).run();
   await assert.rejects(()=>s.api.sendDelivery(s.db,'owner',args,s.env,now),/stale_revision|review_locked|listing_unavailable/);assert.equal(s.submits,0);
  }finally{s.db.close();}
 }
});

test('expired preflight and independent manual-send guard prevent submit',async()=>{
 const s=await setup();try{
  const args=await ready(s);
  await assert.rejects(()=>s.api.sendDelivery(s.db,'owner',args,s.env,'2026-11-03T18:03:00.000Z'),error=>error.message==='preflight_expired'&&error.attempt_started===false);
  await s.db.prepare('INSERT INTO delivery_records VALUES (?,?,?,?,?,?)').bind('owner','fl','42',1,'{}','observation').run();
  await assert.rejects(()=>s.api.sendDelivery(s.db,'owner',args,s.env,now),/delivery_guard/);assert.equal(s.submits,0);
 }finally{s.db.close();}
});

test('only terminal executor ledger proving no action started can restore a new draft',async()=>{
 const s=await setup();try{s.readback='not_submitted';const result=await s.api.sendDelivery(s.db,'owner',await ready(s),s.env,now);assert.equal(result.review.state,'draft');assert.equal(result.review.revision,2);assert.equal(result.review.delivery_confirmation,undefined);assert.equal(result.attempt.status,'not_sent');}finally{s.db.close();}
});

test('storage failure after external submit leaves sending blocked and replay does not submit',async()=>{
 const s=await setup();try{
  const args=await ready(s),batch=s.db.batch.bind(s.db);let calls=0;
  s.db.batch=async statements=>{if(++calls===2)throw new Error('synthetic storage failure');return batch(statements);};
  await assert.rejects(()=>s.api.sendDelivery(s.db,'owner',args,s.env,now));
  assert.equal((await s.store.get('owner','fl','42')).data.state,'sending');assert.equal(s.submits,1);
  s.db.batch=batch;const replay=await s.api.sendDelivery(s.db,'owner',args,s.env,now);assert.equal(replay.review.state,'sending');assert.equal(s.submits,1);
  assert.equal((await s.api.recoverDelivery(s.db,'owner',{operation_id:'send-one'},s.env,now)).review.state,'sent');assert.equal(s.submits,1);
 }finally{s.db.close();}
});


test('identical retry arriving after initial replay lookup still returns the original attempt',async()=>{
 const s=await setup();try{
  const args=await ready(s),prepare=s.db.prepare.bind(s.db);let pause,continueRead;const waiting=new Promise(r=>pause=r),gate=new Promise(r=>continueRead=r);let hold=true;
  s.db.prepare=sql=>{const statement=prepare(sql);if(sql==='SELECT * FROM reviews WHERE owner_id=? AND source_id=? AND external_id=?'&&hold){hold=false;const first=statement.first.bind(statement);statement.first=async()=>{pause();await gate;return first();};}return statement;};
  const delayed=s.api.sendDelivery(s.db,'owner',args,s.env,now);await waiting;
  const first=await s.api.sendDelivery(s.db,'owner',args,s.env,now);continueRead();
  assert.equal((await delayed).attempt.operation_id,first.attempt.operation_id);assert.equal(s.submits,1);
 }finally{s.db.close();}
});

test('proof observed after request starts uses the trusted completion clock',async()=>{
 const s=await setup();try{
  let instant=now;const fetch=s.env.SENDER_SERVICE.fetch.bind(s.env.SENDER_SERVICE);
  s.env.SENDER_SERVICE.fetch=async request=>{const response=await fetch(request);if(new URL(request.url).pathname==='/inspect'){instant='2026-11-03T18:00:01.000Z';const proof=await response.json();proof.verified_at=instant;return Response.json(proof);}return response;};
  const p=await s.api.preflightDelivery(s.db,'owner',identity,s.env,()=>instant);
  assert.equal(p.verified_at,'2026-11-03T18:00:01.000Z');assert.equal(p.expires_at,'2026-11-03T18:02:01.000Z');
 }finally{s.db.close();}
});


test('configured HTTPS executor uses one fixed origin and never forwards browser-selected destinations',async()=>{
 const s=await setup(),originalFetch=globalThis.fetch;try{
  const binding=s.env.SENDER_SERVICE;delete s.env.SENDER_SERVICE;
  Object.assign(s.env,{SENDER_SERVICE_URL:'https://executor.example.test',SENDER_SERVICE_TOKEN:'synthetic-executor-token-at-least-32-characters'});
  globalThis.fetch=async request=>{assert.equal(new URL(request.url).origin,'https://executor.example.test');assert.equal(request.headers.get('Authorization'),'Bearer synthetic-executor-token-at-least-32-characters');assert.equal(request.redirect,'error');return binding.fetch(request);};
  const args=await ready(s);assert.equal((await s.api.sendDelivery(s.db,'owner',args,s.env,now)).review.state,'sent');assert.equal(s.submits,1);
  assert.equal(JSON.stringify(s.api.senderStatus(s.env)).includes('synthetic-executor-token'),false);
  s.env.SENDER_SERVICE_URL='http://localhost:1234';assert.equal(s.api.senderStatus(s.env).configured,false);
  await assert.rejects(()=>s.api.preflightDelivery(s.db,'owner',identity,s.env,now),/sender_not_configured/);
 }finally{globalThis.fetch=originalFetch;s.db.close();}
});


test('changing executor configuration invalidates an earlier owner-visible preflight',async()=>{
 const s=await setup();try{
  const args=await ready(s);delete s.env.SENDER_SERVICE;Object.assign(s.env,{SENDER_SERVICE_URL:'https://replacement.example.test',SENDER_SERVICE_TOKEN:'synthetic-executor-token-at-least-32-characters'});
  await assert.rejects(()=>s.api.sendDelivery(s.db,'owner',args,s.env,now),/confirmation_mismatch|transport_changed/);assert.equal(s.submits,0);
 }finally{s.db.close();}
});


test('a queued executor entry with no action yet cannot prove terminal non-delivery',async()=>{
 const s=await setup();try{
  s.readback='not_submitted';const fetch=s.env.SENDER_SERVICE.fetch.bind(s.env.SENDER_SERVICE);
  s.env.SENDER_SERVICE.fetch=async request=>{const response=await fetch(request);if(new URL(request.url).pathname==='/readback'){const body=await response.json();body.terminal=false;return Response.json(body);}return response;};
  const result=await s.api.sendDelivery(s.db,'owner',await ready(s),s.env,now);assert.equal(result.review.state,'uncertain');assert.equal(result.review.revision,1);
 }finally{s.db.close();}
});
