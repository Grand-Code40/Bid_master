import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {ingestObservations} from '../src/ingest.mjs';
import {handleApi} from '../src/api.mjs';
const now='2026-11-02T12:00:00.000Z';
const description='Требуется подготовить точную трехмерную модель корпуса по приложенным чертежам, с учетом размеров 125 x 85 x 20 мм, крепежных отверстий и технологических ограничений. Результат передать в STEP и PDF, включая сборочный чертеж и спецификацию деталей.';
const item=(id,extra={})=>({source_id:'telegram',external_id:id,canonical_url:'https://t.me/'+id,title:'CAD',description,detail_complete:true,observed_at:now,...extra});
test('repost advisory preserves both identities and previous records, is read-only and owner scoped',async()=>{
 const db=fixture();try{
 await ingestObservations(db,'owner',[item('cad_jobs/1')],now);
 const before=await db.prepare('SELECT * FROM listings').all();
 const result=await ingestObservations(db,'owner',[item('cad_work/2')],now);
 assert.equal(result.written,1);assert.equal(result.candidate_check.status,'checked');assert.equal(result.candidate_check.pairs.length,1);
 assert.deepEqual((await db.prepare('SELECT * FROM listings WHERE external_id=?').bind('cad_jobs/1').all()).results,before.results);
 assert.deepEqual(result.candidate_check.pairs[0].listings.map(x=>x.canonical_url),['https://t.me/cad_jobs/1','https://t.me/cad_work/2']);
 const response=await handleApi(new Request('https://site/api/state',{headers:{'oai-authenticated-user-id':'owner'}}),{DB:db,OWNER_USER_ID:'owner'});
 const state=await response.json();assert.equal(state.listings.length,2);assert.equal(state.candidate_check.pairs.length,1);
 const other=await ingestObservations(db,'other',[item('cad_work/3')],now);assert.equal(other.candidate_check.pairs.length,0);
 }finally{db.close();}
});
test('only substantial complete exact text matches; same-batch pairs unique and no self matches',async()=>{
 const db=fixture();try{
 const result=await ingestObservations(db,'owner',[item('cad_jobs/1'),item('cad_work/2',{description:description.replaceAll(' ','  ')}),item('cad_work/3',{description:description.replace('125','126')}),item('cad_work/4',{detail_complete:false}),item('cad_work/5',{description:'CAD'})],now);
 assert.equal(result.candidate_check.pairs.length,1);
 const repeated=await ingestObservations(db,'owner',[item('cad_jobs/1')],now);assert.equal(repeated.candidate_check.pairs.length,1);
 }finally{db.close();}
});
test('advisory failure does not report committed imports as failed',async()=>{
 const db=fixture();try{
 const prepare=db.prepare;db.prepare=sql=>{if(sql.includes('LIMIT 501'))throw new Error('advisory unavailable');return prepare(sql);};
 const result=await ingestObservations(db,'owner',[item('cad_jobs/1')],now);
 assert.equal(result.written,1);assert.equal(result.candidate_check.status,'unavailable');
 assert.equal((await db.prepare('SELECT * FROM listings').all()).results.length,1);
 }finally{db.close();}
});
test('queued reviews remain byte-identical and stale/incomplete input uses stored content',async()=>{
 const {ReviewStore}=await import('../src/store.mjs');const db=fixture();try{
 await ingestObservations(db,'owner',[item('cad_jobs/1',{listing_kind:'order',availability:'open'})],now);const store=new ReviewStore(db);
 await store.prepare('owner','telegram','cad_jobs/1',now,'p');
 await store.act('owner','telegram','cad_jobs/1',{action:'approve',revision:1,operation_id:'a'},{role:'owner',now});
 await store.act('owner','telegram','cad_jobs/1',{action:'queue',revision:1,operation_id:'q'},{role:'owner',now});
 const before=(await db.prepare('SELECT * FROM reviews').all()).results;
 await ingestObservations(db,'owner',[item('cad_work/2')],now);
 const result=await ingestObservations(db,'owner',[item('cad_jobs/1',{description:'old summary',detail_complete:false,observed_at:'2026-11-01T00:00:00Z'})],now);
 assert.equal(result.candidate_check.pairs.length,1);assert.deepEqual((await db.prepare('SELECT * FROM reviews').all()).results,before);
 }finally{db.close();}
});
test('bounded owner window and pair cap disclose incomplete coverage',async()=>{
 const {candidateWarnings}=await import('../src/candidates.mjs');const db=fixture();try{
 for(let i=1;i<=501;i++)await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,1)').bind('owner','telegram','cad_jobs/'+i,JSON.stringify(item('cad_jobs/'+i)),'{}',now,now).run();
 const result=await candidateWarnings(db,'owner');assert.equal(result.examined,500);assert.equal(result.pairs.length,100);assert.equal(result.truncated,true);assert.equal(result.may_miss_matches,true);
 const keys=result.pairs.map(p=>JSON.stringify(p.listings.map(x=>x.external_id)));assert.equal(new Set(keys).size,100);
 }finally{db.close();}
});
test('legacy excluded sources never leak or displace active candidates from bounded window',async()=>{
 const {candidateWarnings}=await import('../src/candidates.mjs');const db=fixture();try{
 await ingestObservations(db,'owner',[item('cad_jobs/1'),item('cad_work/2')],now);
 for(let i=1;i<=501;i++)await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,1)').bind('owner','kwork',String(i),JSON.stringify({...item('cad_jobs/'+i),source_id:'kwork',external_id:String(i)}),'{}',now,'2026-11-02T13:00:00Z').run();
 const before=(await db.prepare('SELECT * FROM listings WHERE source_id=?').bind('kwork').all()).results;
 const result=await candidateWarnings(db,'owner');assert.equal(result.pairs.length,1);assert.equal(result.examined,2);assert.equal(result.truncated,false);assert.ok(result.pairs.flatMap(p=>p.listings).every(x=>x.source_id==='telegram'));
 assert.deepEqual((await db.prepare('SELECT * FROM listings WHERE source_id=?').bind('kwork').all()).results,before);
 }finally{db.close();}
});
test('invalid stored provenance is skipped without modifying historical rows',async()=>{
 const {candidateWarnings}=await import('../src/candidates.mjs');const db=fixture();try{
 await ingestObservations(db,'owner',[item('cad_jobs/1'),item('cad_work/2')],now);
 for(const url of ['https://evil.example/phish','https://user:secret@t.me/cad_work/2','https://t.me/cad_work/999']){
 await db.prepare('UPDATE listings SET data=? WHERE external_id=?').bind(JSON.stringify(item('cad_work/2',{canonical_url:url})),'cad_work/2').run();
 const result=await candidateWarnings(db,'owner');assert.equal(result.pairs.length,0);assert.ok(!JSON.stringify(result).includes('secret'));assert.equal(JSON.parse((await db.prepare('SELECT data FROM listings WHERE external_id=?').bind('cad_work/2').first()).data).canonical_url,url);
 }
 }finally{db.close();}
});
test('threshold counts NFC Unicode codepoints, not UTF16 units, and response excludes content',async()=>{
 for(const [text,expected] of [['😀'.repeat(199),0],['😀'.repeat(200),1],['e\u0301'.repeat(199),0],['e\u0301'.repeat(200),1]]){
 const db=fixture();try{const result=await ingestObservations(db,'owner',[item('cad_jobs/1',{description:text}),item('cad_work/2',{description:text.normalize('NFC')})],now);
 assert.equal(result.candidate_check.pairs.length,expected);const payload=JSON.stringify(result.candidate_check);assert.ok(!payload.includes(text));assert.ok(!payload.includes('"description":'));assert.ok(!payload.includes('claim_token'));
 }finally{db.close();}}
});
