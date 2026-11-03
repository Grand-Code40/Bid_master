import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {validateObservations,ingestObservations} from '../src/ingest.mjs';
import {ReviewStore} from '../src/store.mjs';
const now='2026-11-02T12:00:00.000Z';
const item=()=>({source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html',title:'CAD order',observed_at:now,listing_kind:'order',budget_min:'100.50',bids_count:0,availability:'open'});
test('rejects unapproved fields, bad source URL and future date before any writes',async()=>{
 const db=fixture();try{for(const change of [{state:'approved'},{source_id:'evil'},{canonical_url:'https://evil.test/projects/42/a.html'},{canonical_url:'https://www.fl.ru/projects/43/a.html'},{observed_at:'2027-01-01T00:00:00Z'},{observed_at:'2026-11-02'},{bids_count:-1},{budget_min:'NaN'},{external_id:'../42'}]){
 await assert.rejects(()=>ingestObservations(db,'owner',[item(),{...item(),...change}],now),/invalid_observation/);}
 assert.equal((await new ReviewStore(db).snapshot('owner')).listings.length,0);
 }finally{db.close();}
});
test('partial merge preserves budget; null clears; zero remains zero; owners isolated',async()=>{
 const db=fixture();try{await ingestObservations(db,'owner',[item()],now);const shorter=item();delete shorter.budget_min;shorter.title='new';
 await ingestObservations(db,'owner',[shorter],now);let row=(await new ReviewStore(db).snapshot('owner')).listings[0];assert.equal(row.budget_min,'100.50');assert.equal(row.bids_count,0);
 await ingestObservations(db,'owner',[{...shorter,budget_min:null}],now);row=(await new ReviewStore(db).snapshot('owner')).listings[0];assert.equal(row.budget_min,null);
 assert.equal((await new ReviewStore(db).snapshot('other')).listings.length,0);
 }finally{db.close();}
});
test('old observation cannot replace new fields and detail summary cannot erase full text',async()=>{
 const db=fixture();try{await ingestObservations(db,'owner',[{...item(),description:'full',detail_complete:true}],now);
 await ingestObservations(db,'owner',[{...item(),budget_min:'1',observed_at:'2026-11-01T12:00:00Z',description:'short',detail_complete:false}],now);
 const row=(await new ReviewStore(db).snapshot('owner')).listings[0];assert.equal(row.budget_min,'100.50');assert.equal(row.description,'full');assert.equal(row.detail_complete,true);
 }finally{db.close();}
});
test('bounded package and source registry accept only canonical IDs',()=>{
 assert.throws(()=>validateObservations([],now));assert.throws(()=>validateObservations(Array(201).fill(item()),now));
 for(const [source_id,external_id,canonical_url] of [['freelance','5','https://freelance.ru/task/view/5'],['telegram','cad_jobs/5','https://t.me/s/cad_jobs/5']]) assert.equal(validateObservations([{...item(),source_id,external_id,canonical_url}],now).length,1);
});
