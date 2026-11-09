import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {ReviewStore} from '../src/store.mjs';
const item={source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html',title:'CAD order',listing_kind:'order',availability:'open'};
const now='2026-11-02T12:00:00.000Z';
async function setup(){const db=fixture();await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?)').bind('owner','fl','42',JSON.stringify(item),'{}',now,now,1).run();return {db,store:new ReviewStore(db)};}
const ctx={role:'owner',now};
const action=(store,action,revision,operation_id,extra={},context=ctx)=>store.act('owner','fl','42',{action,revision,operation_id,...extra},context);
test('prepare persists safely and repeat preserves edits',async()=>{
 const {db,store}=await setup();try{const row=await store.prepare('owner','fl','42',now,'p1');assert.equal(row.state,'draft');
 await action(store,'save',1,'s1',{text:'my text'}); assert.equal((await store.prepare('owner','fl','42',now,'p2')).text,'my text');
 assert.equal((await store.get('other','fl','42')),null); }finally{db.close();}
});
test('atomic revision CAS permits one concurrent change and matching event only',async()=>{
 const {db,store}=await setup();try{await store.prepare('owner','fl','42',now,'p1');
 const results=await Promise.allSettled([action(store,'save',1,'s1',{text:'one'}),action(store,'save',1,'s2',{text:'two'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const events=(await db.prepare('SELECT * FROM review_events WHERE action=?').bind('save').all()).results;assert.equal(events.length,1);
 assert.equal(JSON.parse(events[0].data).text,(await store.get('owner','fl','42')).data.text);
 }finally{db.close();}
});
test('operation replay returns original result and changed reuse rejects',async()=>{
 const {db,store}=await setup();try{await store.prepare('owner','fl','42',now,'p1');const saved=await action(store,'save',1,'s1',{text:'one'});
 assert.deepEqual(await action(store,'save',1,'s1',{text:'one'}),saved);
 await assert.rejects(()=>action(store,'approve',2,'s1'),/operation_conflict/);
 }finally{db.close();}
});
test('two claimers get exactly one token and no reclaim',async()=>{
 const {db,store}=await setup();try{await store.prepare('owner','fl','42',now,'p1');await action(store,'approve',1,'a1');await action(store,'queue',1,'q1');
 const row=(await store.get('owner','fl','42')).data;
 await action(store,'confirm_delivery',1,'confirm',{details:deliveryDetails(row)});
 const agent=senderCtx(row);
 const result=await Promise.all([store.claimNext('owner','fl','c1',agent),store.claimNext('owner','fl','c2',{...agent,newClaimToken:'B'.repeat(32)})]);
 assert.equal(result.filter(Boolean).length,1);assert.equal(result.find(Boolean).state,'sending');
 assert.equal(await store.claimNext('owner','fl','c3',agent),null);
 const pub=await store.snapshot('owner'); assert.equal('claim_token' in pub.reviews[0],false);
 }finally{db.close();}
});
test('closed listing blocks approval and queued claim',async()=>{
 const {db,store}=await setup();try{await store.prepare('owner','fl','42',now,'p1');await action(store,'approve',1,'a1');await action(store,'queue',1,'q1');
 await db.prepare('UPDATE listings SET data=?').bind(JSON.stringify({...item,availability:'closed'})).run();
 assert.equal(await store.claimNext('owner',null,'c1',{role:'sender',enabled:true,now,newClaimToken:'A'.repeat(32)}),null);
 }finally{db.close();}
});
test('closing listing after read but before CAS blocks approval',async()=>{
 const {db,store}=await setup();try{await store.prepare('owner','fl','42',now,'p1');
 const batch=db.batch.bind(db);db.batch=async statements=>{await db.prepare('UPDATE listings SET data=?').bind(JSON.stringify({...item,availability:'closed'})).run();return batch(statements);};
 await assert.rejects(()=>action(store,'approve',1,'a1'),/stale_revision|listing_unavailable/);
 assert.equal((await store.get('owner','fl','42')).data.state,'draft');
 }finally{db.close();}
});
const deliveryDetails=row=>({source_id:row.source_id,external_id:row.external_id,canonical_url:row.canonical_url,text:row.text,revision:row.revision,sender_account:'owner-fl',recipient_account:'customer-42',price:null,currency:null,deadline:null,credit_cost:0});
const senderCtx=row=>({role:'sender',now,enabled:true,newClaimToken:'A'.repeat(32),session:{source_id:'fl',sender_account:'owner-fl',authenticated:true,verified_at:now},preflight:{...deliveryDetails(row),verified_at:now,availability:'open',already_sent:false,form_supported:true}});
test('store refuses legacy queue claims and atomically persists explicit owner confirmation',async()=>{
 const {db,store}=await setup();try{
 const row=await store.prepare('owner','fl','42',now,'p');await action(store,'approve',1,'a');await action(store,'queue',1,'q');
 await assert.rejects(()=>action(store,'claim',undefined,'legacy',{},senderCtx(row)),/delivery_confirmation_required/);
 const details=deliveryDetails(row);
 await assert.rejects(()=>action(store,'confirm_delivery',1,'bad',{details},{role:'agent',now}),/owner_required/);
 const confirmed=await action(store,'confirm_delivery',1,'confirm',{details});
 assert.equal(confirmed.delivery_confirmation.recipient_account,'customer-42');
 assert.deepEqual(await action(store,'confirm_delivery',1,'confirm',{details}),confirmed);
 await assert.rejects(()=>action(store,'confirm_delivery',1,'confirm',{details:{...details,recipient_account:'other'}}),/operation_conflict/);
 const results=await Promise.allSettled([action(store,'claim',undefined,'c1',{},senderCtx(row)),action(store,'claim',undefined,'c2',{}, {...senderCtx(row),newClaimToken:'B'.repeat(32)})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await store.active('owner')).length,1);
 }finally{db.close();}
});
test('cancel racing owner confirmation wins or invalidates it, never leaves stale consent usable',async()=>{
 const {db,store}=await setup();try{
 const row=await store.prepare('owner','fl','42',now,'p');await action(store,'approve',1,'a');await action(store,'queue',1,'q');
 const results=await Promise.allSettled([action(store,'cancel',1,'cancel'),action(store,'confirm_delivery',1,'confirm',{details:deliveryDetails(row)})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 if((await store.get('owner','fl','42')).data.state!=='draft')await action(store,'cancel',1,'cancel2');
 const end=(await store.get('owner','fl','42')).data;assert.equal(end.state,'draft');assert.equal(end.delivery_confirmation,undefined);
 await assert.rejects(()=>action(store,'claim',undefined,'c',{},senderCtx(row)),/review_locked/);
 }finally{db.close();}
});
test('claim replay recovers same token, result recovery has sender capability and no automatic retry',async()=>{
 const {db,store}=await setup();try{
 const row=await store.prepare('owner','fl','42',now,'p');await action(store,'approve',1,'a');await action(store,'queue',1,'q');await action(store,'confirm_delivery',1,'confirm',{details:deliveryDetails(row)});
 const context=senderCtx(row),claim=await store.claimNext('owner','fl','claim',context);
 assert.equal((await store.claimNext('owner','fl','claim',context)).claim_token,claim.claim_token);
 await assert.rejects(()=>action(store,'claim',undefined,'claim',{}, {role:'agent',now}),/sender_required/);
 await assert.rejects(()=>action(store,'result',undefined,'result',{claim_token:claim.claim_token,outcome:'uncertain',evidence:'Lost platform response'},{role:'agent',now}),/sender_required/);
 await action(store,'result',undefined,'result',{claim_token:claim.claim_token,outcome:'uncertain',evidence:'Lost platform response'},context);
 assert.equal(await store.claimNext('owner','fl','another',context),null);
 await action(store,'result',undefined,'resolve',{claim_token:claim.claim_token,outcome:'not_sent',evidence:'Matching outgoing history checked; not sent'},context);
 const recovered=(await store.get('owner','fl','42')).data;assert.equal(recovered.state,'draft');assert.equal(recovered.delivery_confirmation,undefined);
 }finally{db.close();}
});
test('disabled or generic writer cannot scan a sender queue even when empty',async()=>{
 const {db,store}=await setup();try{
 await assert.rejects(()=>store.claimNext('owner','fl','c',{role:'agent',now}),/sender_required/);
 await assert.rejects(()=>store.claimNext('owner','fl','c',{role:'sender',enabled:false,now}),/sender_disabled/);
 }finally{db.close();}
});
test('existing deployed operation hashes remain compatible after adding delivery details',async()=>{
 const {db,store}=await setup();try{
 await store.prepare('owner','fl','42',now,'p');const saved=await action(store,'save',1,'old-save',{text:'one'});
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['fl','42','save',1,'one',null,null,null,null])));
 const oldHash=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
 await db.prepare('UPDATE review_events SET request_hash=? WHERE operation_id=?').bind(oldHash,'old-save').run();
 assert.deepEqual(await action(store,'save',1,'old-save',{text:'one'}),saved);
 }finally{db.close();}
});
