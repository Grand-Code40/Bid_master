import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {ReviewStore} from '../src/store.mjs';
import {transition,publicReview,manualDeliveryUrl} from '../src/review.mjs';
import {handleApi} from '../src/api.mjs';
const now='2026-11-03T09:00:00.000Z',ctx={role:'owner',now};
const item={source_id:'vmasshtabe',external_id:'synthetic-task',canonical_url:'https://vmasshtabe.ru/task/synthetic-task',title:'Synthetic only',listing_kind:'order',availability:'open'};
const details={text:'Exact sent text\nSecond line',observation:'Observed own response block and conversation; not a read receipt',observed_at:now,delivery_url:'https://vmasshtabe.ru/account/view-task?id=123&response_id=456'};
const command={action:'record_manual_delivery',revision:2,operation_id:'manual',details};
async function setup(){const db=fixture(),store=new ReviewStore(db);for(const owner of ['owner','other']){await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?)').bind(owner,item.source_id,item.external_id,JSON.stringify(item),'{}',now,now,1).run();await store.prepare(owner,item.source_id,item.external_id,now,'prepare');await store.act(owner,item.source_id,item.external_id,{action:'save',text:details.text,revision:1,operation_id:'save'},ctx);}return {db,store,act:(cmd=command,context=ctx,owner='owner')=>store.act(owner,item.source_id,item.external_id,cmd,context)};}
test('manual snapshot is separate terminal state, exact immutable content and retained history, owner isolated',async()=>{
 const {db,store,act}=await setup();try{
 const result=await act();assert.equal(result.state,'manual_sent');assert.equal(result.revision,2);assert.equal(result.manual_delivery.text,details.text);assert.equal(result.manual_delivery.observation,details.observation);assert.equal(result.manual_delivery.delivery_url,details.delivery_url);assert.equal(result.manual_delivery.recorded_at,now);assert.equal(result.evidence,null);
 assert.equal((await store.get('other',item.source_id,item.external_id)).data.state,'draft');
 assert.deepEqual(await act(),result);
 for(const action of ['save','approve','queue','cancel','record_manual_delivery','confirm_delivery'])await assert.rejects(()=>act({...command,action,operation_id:'blocked-'+action,text:'changed'}),/review_locked/);
 for(const action of ['claim','result'])assert.throws(()=>transition({...result,claim_token:'A'.repeat(32)},{action,outcome:'sent',evidence:'test',claim_token:'A'.repeat(32)},{role:'agent',now,newClaimToken:'A'.repeat(32)}),/review_locked/);
 for(const role of ['agent','sender',undefined])await assert.rejects(()=>act(command,{role,now}),/owner_required/);
 const events=(await db.prepare('SELECT * FROM review_events WHERE owner_id=? ORDER BY operation_id').bind('owner').all()).results;assert.equal(events.length,2);assert.equal(events.find(x=>x.action==='save').data.includes('"state":"draft"'),true);
 assert.deepEqual(JSON.parse(events.find(x=>x.action==='record_manual_delivery').data),result);
 assert.equal(await store.claimNext('owner',null,'claim',{role:'sender',enabled:true,now}),null);
 }finally{db.close();}
});
test('binding, unsupported states, exact dates, fields and changed idempotency payload fail closed',async()=>{
 const {db,store,act}=await setup();try{
 await assert.rejects(()=>act({...command,revision:1}),/stale_revision/);
 for(const change of [{text:'different'},{observed_at:'2026-11-03T10:00:00.000Z'},{observed_at:'2026-02-30T00:00:00.000Z'},{observed_at:'yesterday'},{observation:''},{extra:'no'},{delivery_url:'https://evil.test/'}])await assert.rejects(()=>act({...command,details:{...details,...change}}),/invalid_|confirmation_mismatch/);
 const row=(await store.get('owner',item.source_id,item.external_id)).data;
 for(const state of ['sending','uncertain','sent','manual_sent'])assert.throws(()=>transition({...row,state},command,ctx),/review_locked/);
 assert.throws(()=>transition({...row,source_id:'fl'},command,ctx),/invalid_manual_delivery/);
 await act();for(const change of [{observation:'other'},{observed_at:'2026-11-02T09:00:00.000Z'},{delivery_url:'https://vmasshtabe.ru/account/view-task?id=123&response_id=999'}])await assert.rejects(()=>act({...command,details:{...details,...change}}),/operation_conflict/);
 }finally{db.close();}
});
test('strict V Masshtabe URL accepts only exact host/path and bounded positive integer IDs',()=>{
 assert.equal(manualDeliveryUrl(details.delivery_url),details.delivery_url);
 for(const url of ['http://vmasshtabe.ru/account/view-task?id=123&response_id=456','https://www.vmasshtabe.ru/account/view-task?id=123&response_id=456','https://vmasshtabe.ru:443/account/view-task?id=123&response_id=456','https://x@vmasshtabe.ru/account/view-task?id=123&response_id=456',details.delivery_url+'#x',details.delivery_url+'&token=secret',details.delivery_url+'&id=9',details.delivery_url.replace('123','%31%32%33'),details.delivery_url.replace('123','0'),details.delivery_url.replace('123','1e2'),details.delivery_url.replace('123','9'.repeat(21)),details.delivery_url.replace('/account/','/x/../account/'),details.delivery_url.replace('456','456\n')])assert.throws(()=>manualDeliveryUrl(url),/invalid_manual_delivery/);
});
test('manual versus edit CAS commits one matching snapshot/event and safely retries',async()=>{
 const {db,store,act}=await setup();try{
 const results=await Promise.allSettled([act(),act({action:'save',revision:2,text:'new revision',operation_id:'edit'})]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const current=(await store.get('owner',item.source_id,item.external_id)).data;
 const events=(await db.prepare("SELECT * FROM review_events WHERE owner_id='owner' AND operation_id IN ('manual','edit')").all()).results;assert.equal(events.length,1);assert.equal(JSON.parse(events[0].data).state,current.state);
 if(current.state==='manual_sent')assert.deepEqual(await act(),publicReview(current));else await assert.rejects(()=>act(),/stale_revision/);
 }finally{db.close();}
});
test('concurrent manual operations produce one terminal write; retry same key recovers result',async()=>{
 const {db,store,act}=await setup();try{const results=await Promise.allSettled([act(),act()]);assert.ok(results.some(x=>x.status==='fulfilled'));const result=await act();assert.equal(result.state,'manual_sent');assert.equal((await db.prepare("SELECT * FROM review_events WHERE owner_id='owner' AND action='record_manual_delivery'").all()).results.length,1);}finally{db.close();}
});
test('queued manual record removes work from queue; historical closed listings can be recorded',async()=>{
 const {db,store,act}=await setup();try{
 await act({action:'approve',revision:2,operation_id:'approve'});await act({action:'queue',revision:2,operation_id:'queue'});
 await db.prepare('UPDATE listings SET data=? WHERE owner_id=?').bind(JSON.stringify({...item,availability:'closed'}),'owner').run();
 assert.equal((await act()).state,'manual_sent');assert.equal(await store.claimNext('owner',null,'claim',{role:'sender',enabled:true,now}),null);
 }finally{db.close();}
});
test('owner API enforces Origin, denies writer/MCP surface, validates keys and persists only authorized action',async()=>{
 const {db,store}=await setup();try{
 const env={DB:db,OWNER_USER_ID:'owner',WRITER_TOKEN:'test-writer-token-with-at-least-32-characters'},origin='https://private.example';
 const data={...item,operation_id:'api-manual',revision:2,details};delete data.title;delete data.canonical_url;delete data.listing_kind;delete data.availability;
 const req=(headers={},body=data,path='/api/review/record_manual_delivery')=>new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'owner',Origin:origin,...headers},body:JSON.stringify(body)});
 for(const headers of [{Origin:'https://evil.test'},{Origin:'null'},{Origin:''},{'oai-authenticated-user-id':'other'},{'oai-authenticated-user-id':'','X-Bid-Writer-Token':env.WRITER_TOKEN}])assert.ok([401,403].includes((await handleApi(req(headers),env)).status));
 assert.equal((await handleApi(req({}, {...data,role:'owner'}),env)).status,400);
 assert.equal((await handleApi(req({}, {...data,details:{...details,delivery_url:details.delivery_url+'&secret=x'}}),env)).status,400);
 assert.equal((await handleApi(req({'X-Bid-Writer-Token':env.WRITER_TOKEN},data,'/api/agent/record_manual_delivery'),env)).status,404);
 assert.equal((await store.get('owner',item.source_id,item.external_id)).data.state,'draft');
 const response=await handleApi(req(),env);assert.equal(response.status,200);assert.equal((await response.json()).state,'manual_sent');
 }finally{db.close();}
});
test('claim winning between read and CAS cannot be overwritten by manual record',async()=>{
 const {db,store,act}=await setup();try{
 await act({action:'approve',revision:2,operation_id:'approve'});await act({action:'queue',revision:2,operation_id:'queue'});
 const batch=db.batch.bind(db);db.batch=async statements=>{
  const row=(await store.get('owner',item.source_id,item.external_id)).data;
  const claimed=transition(row,{action:'claim'},{role:'agent',now,newClaimToken:'A'.repeat(32)});
  await db.prepare('UPDATE reviews SET data=?,storage_version=storage_version+1,last_operation=? WHERE owner_id=? AND source_id=? AND external_id=?').bind(JSON.stringify(claimed),'synthetic-claim','owner',item.source_id,item.external_id).run();
  return batch(statements);
 };
 await assert.rejects(()=>act(),/stale_revision/);const current=(await store.get('owner',item.source_id,item.external_id)).data;assert.equal(current.state,'sending');assert.equal(current.manual_delivery,undefined);assert.equal((await db.prepare("SELECT * FROM review_events WHERE action='record_manual_delivery'").all()).results.length,0);
 }finally{db.close();}
});
test('populated database upgrade requires no DDL/backfill; existing other-owner rows and audit bytes stay unchanged',async()=>{
 const {db,store,act}=await setup();try{
 const tables=['listings','reviews','review_events'];const read=()=>Promise.all(tables.map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY owner_id').all()));const before=await read();
 await store.snapshot('owner');await store.activeSnapshot('owner');assert.deepEqual(await read(),before);
 await act();const after=await read();assert.deepEqual(after[0],before[0]);
 for(let i=1;i<3;i++)assert.deepEqual(after[i].results.filter(x=>x.owner_id==='other'),before[i].results.filter(x=>x.owner_id==='other'));
 for(const event of before[2].results)assert.deepEqual(after[2].results.find(x=>x.owner_id===event.owner_id&&x.operation_id===event.operation_id),event);
 }finally{db.close();}
});
