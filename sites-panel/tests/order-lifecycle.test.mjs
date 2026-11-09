import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {ReviewStore} from '../src/store.mjs';
import {handleApi} from '../src/api.mjs';
import {ingestObservations} from '../src/ingest.mjs';
const now='2026-11-09T12:00:00.000Z';
async function add(db,id,{owner='owner',availability='closed',state=null,delivery=null,last=now}={}){
 const item={source_id:'fl',external_id:id,title:'Synthetic only '+id,canonical_url:'https://www.fl.ru/projects/'+id+'/test.html',listing_kind:'order',availability,raw_date:'8 ноября 2026; часовой пояс неизвестен'};
 await db.prepare('INSERT INTO listings(owner_id,source_id,external_id,data,field_times,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)').bind(owner,'fl',id,JSON.stringify(item),JSON.stringify({raw_date:'2026-11-08T12:00:00.000Z'}),now,last).run();
 if(state)await db.prepare('INSERT INTO reviews(owner_id,source_id,external_id,data,last_operation) VALUES(?,?,?,?,?)').bind(owner,'fl',id,JSON.stringify({source_id:'fl',external_id:id,state,text:'Keep exact saved text',claim_token:'SECRET'}),'fixture').run();
 if(delivery)await db.prepare('INSERT INTO delivery_records(owner_id,source_id,external_id,version,data,last_operation) VALUES(?,?,?,?,?,?)').bind(owner,'fl',id,1,JSON.stringify({status:delivery}),'fixture').run();
}
test('closed unanswered orders leave active feed, while response history and uncertain sends remain',async()=>{
 const db=fixture(),store=new ReviewStore(db);try{
 await add(db,'1');await add(db,'2',{state:'draft'});await add(db,'3',{state:'approved'});await add(db,'4',{state:'queued'});
 await add(db,'5',{state:'sent'});await add(db,'6',{state:'manual_sent'});await add(db,'7',{delivery:'observed'});await add(db,'8',{delivery:'erroneous'});
 await add(db,'9',{state:'sending'});await add(db,'10',{state:'uncertain'});await add(db,'11',{availability:'unknown'});await add(db,'12',{availability:'open'});
 const active=await store.activeSnapshot('owner');assert.deepEqual(active.listings.map(x=>x.external_id).sort(),['10','11','12','5','6','7','9']);
 assert.equal(active.listings.find(x=>x.external_id==='7').has_saved_response,true);
 assert.deepEqual(active.reviews.map(x=>x.external_id).sort(),['10','5','6','9']);
 assert.equal(JSON.stringify(active).includes('SECRET'),false);
 const history=await store.snapshot('owner');assert.equal(history.listings.length,12);assert.equal(history.reviews.length,7);assert.equal((await store.get('owner','fl','2')).data.text,'Keep exact saved text');
 }finally{db.close();}
});
test('filtering happens before feed limit and other owners cannot preserve a closed item',async()=>{
 const db=fixture(),store=new ReviewStore(db);try{
 for(let i=1;i<=1001;i++)await add(db,String(i));await add(db,'1002',{availability:'open',last:'2026-11-01T12:00:00.000Z'});
 await add(db,'1',{owner:'other',state:'sent'});
 assert.deepEqual((await store.activeSnapshot('owner')).listings.map(x=>x.external_id),['1002']);
 }finally{db.close();}
});
test('API counts active rows, exposes raw date provenance and a new observation can reopen without deleting history',async()=>{
 const db=fixture(),store=new ReviewStore(db);try{
 await add(db,'1',{state:'draft'});await add(db,'2',{availability:'unknown'});
 const state=await (await handleApi(new Request('https://site.test/api/state',{headers:{'oai-authenticated-user-id':'owner'}}),{DB:db,OWNER_USER_ID:'owner'})).json();
 assert.equal(state.summary.total,1);assert.equal(state.summary.orders,1);assert.equal(state.listings[0].raw_date_observed_at,'2026-11-08T12:00:00.000Z');
 const row=await store.listing('owner','fl','1');await ingestObservations(db,'owner',[{...row,availability:'open',observed_at:now}],now);
 assert.equal((await store.activeSnapshot('owner')).listings.length,2);assert.equal((await store.get('owner','fl','1')).data.text,'Keep exact saved text');
 }finally{db.close();}
});
test('hidden closed Vmasshtabe orders remain available to correct delivery accounting',async()=>{
 const db=fixture();try{
 const data={source_id:'vmasshtabe',external_id:'qa-closed',title:'Synthetic accounting only',canonical_url:'https://vmasshtabe.ru/task/qa-closed',availability:'closed',listing_kind:'order'};
 await db.prepare('INSERT INTO listings(owner_id,source_id,external_id,data,first_seen,last_seen) VALUES(?,?,?,?,?,?)').bind('owner',data.source_id,data.external_id,JSON.stringify(data),now,now).run();
 const state=await new ReviewStore(db).activeSnapshot('owner');assert.equal(state.listings.length,0);assert.equal(state.delivery_listings[0].external_id,'qa-closed');assert.equal((await new ReviewStore(db).activeSnapshot('other')).delivery_listings.length,0);
 }finally{db.close();}
});
