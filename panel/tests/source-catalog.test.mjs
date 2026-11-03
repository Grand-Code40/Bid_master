import test from 'node:test';
import assert from 'node:assert/strict';
import {publicSources,telegramChannels} from '../src/sources.mjs';
import {canonicalUrl} from '../src/ingest.mjs';
const candidates=['zakaz3dmodels','in3ddd','work_club_engineers','arch_freelance'];
test('catalog keeps previous channels, adds honest candidate chats and has no duplicate identities',()=>{
 const sources=publicSources([]);assert.equal(new Set(sources.map(x=>x.id)).size,sources.length);
 for(const channel of ['cgfreelance','zakaz_design','job_design','profreel','designs_job'])assert.equal(telegramChannels.find(x=>x.channel===channel).state,'observed');
 for(const channel of candidates){const source=sources.find(x=>x.id==='telegram:'+channel);assert.ok(source,channel);assert.equal(source.state,'candidate');assert.equal(source.import_enabled,false);assert.equal(source.automation,'prohibited');assert.equal(source.evidence_url,'https://t.me/'+channel);assert.equal(source.content_date,null);}
 const help=sources.find(x=>x.id==='telegram:help_kirill_autocad');assert.ok(help);assert.equal(help.state,'observed');assert.equal(help.content_date,null);assert.equal(help.automation,'unverified');
});
test('generic Telegram transport bucket does not count as an independent source',()=>{
 const sources=publicSources([]);assert.equal(sources.find(x=>x.id==='telegram').counts_as_source,false);
 const counted=sources.filter(x=>x.counts_as_source);assert.equal(counted.length,22);assert.equal(counted.filter(x=>x.state==='observed').length,15);assert.equal(counted.filter(x=>x.state==='candidate').length,7);
});
test('candidate chats cannot bypass unavailable import status through generic Telegram transport',()=>{
 for(const channel of candidates)assert.throws(()=>canonicalUrl('telegram',channel+'/1','https://t.me/'+channel+'/1'),/invalid_observation/);
 assert.equal(canonicalUrl('telegram','help_kirill_autocad/1','https://t.me/help_kirill_autoCAD/1'),'https://t.me/help_kirill_autocad/1');
});

test('public request evidence does not claim dates, activity, scanning or unique repost orders',()=>{
 const sources=publicSources([]);
 for(const [channel,post,summary] of [['free_design1','9000016','STL/FBX'],['rueventjob','9000017','STEP']]){
  const source=sources.find(x=>x.id==='telegram:'+channel);assert.ok(source,channel);
  assert.equal(source.evidence_url.toLowerCase(),'https://t.me/'+channel+'/'+post);
  assert.equal(source.evidence_scope,'public_post');assert.equal(source.content_date,null);
  assert.equal(source.activity_status,'unverified');assert.equal(source.implemented,false);
  assert.equal(source.import_mode,'manual_observation');assert.equal(source.automation,'unverified');
  assert.equal(source.code,'not_scanned');assert.equal(source.last_success,null);
  assert.match(source.evidence_note,new RegExp(summary));assert.match(source.evidence_note,/дата неизвестна/);
 }
 const repost=sources.find(x=>x.id==='telegram:rueventjob');
 assert.equal(repost.unique_orders_verified,false);assert.equal(repost.dedup_required,true);
 assert.match(repost.evidence_note,/репост/);assert.match(repost.evidence_note,/не уникальные заказы/);
 assert.equal(sources.some(x=>['kwork','freelancer','freelancehunt'].includes(x.id)),false);
});
test('added channels validate canonical post identities, not other hosts or post ids',()=>{
 for(const [channel,post] of [['free_design1','9000016'],['rueventjob','9000017']]){
  const id=channel+'/'+post;
  assert.equal(canonicalUrl('telegram',id,'https://t.me/'+channel.toUpperCase()+'/'+post),'https://t.me/'+id);
  assert.throws(()=>canonicalUrl('telegram',id,'https://t.me.evil.test/'+id),/invalid_observation/);
  assert.throws(()=>canonicalUrl('telegram',id,'https://t.me/'+channel+'/999'),/invalid_observation/);
 }
});

test('repeat observations of new Telegram sources preserve one row per canonical post',async()=>{
 const {fixture}=await import('./d1-fixture.mjs');const {ingestObservations}=await import('../src/ingest.mjs');
 const db=fixture();const now='2026-11-02T12:00:00Z';
 try{
  for(const [channel,post] of [['free_design1','9000016'],['rueventjob','9000017']]){
   const row={source_id:'telegram',external_id:channel+'/'+post,canonical_url:'https://t.me/'+channel+'/'+post,title:'Synthetic test only',observed_at:now,published_at:null,availability:'unknown'};
   await ingestObservations(db,'owner',[row],now);
   await ingestObservations(db,'owner',[{...row,canonical_url:'https://t.me/s/'+channel.toUpperCase()+'/'+post+'?single'}],now);
  }
  const rows=(await db.prepare('SELECT * FROM listings WHERE owner_id=?').bind('owner').all()).results;
  assert.equal(rows.length,2);
  for(const row of rows){const data=JSON.parse(row.data);assert.equal(data.published_at,null);assert.equal(data.availability,'unknown');}
 }finally{db.close();}
});

test('PRO-PTO stays a catalog-only candidate with honest evidence and no import',async()=>{
 const {importSourceIds,sourceHosts}=await import('../src/sources.mjs');
 const {scanSources}=await import('../src/scans.mjs');
 const source=publicSources([]).find(s=>s.id==='pro_pto');
 assert.ok(source);assert.equal(source.state,'candidate');assert.equal(source.import_enabled,false);
 assert.equal(source.import_mode,'unavailable');assert.equal(source.implemented,false);
 assert.equal(source.automation,'unverified');assert.equal(source.rules_status,'unverified');
 assert.equal(source.content_date,null);assert.equal(source.activity_status,'unverified');
 assert.equal(source.code,'not_scanned');assert.equal(source.last_success,null);assert.equal(source.last_checked_at,null);
 assert.equal(source.evidence_url,'https://pro-pto.ru/projects');
 assert.match(source.evidence_note,/даты без года/);assert.match(source.evidence_note,/актуальность и RSS не подтверждены/);
 assert.deepEqual([...importSourceIds],['fl','freelance','telegram','vmasshtabe','weblancer','3ddd','dwg','enginer']);
 assert.equal(importSourceIds.includes('pro_pto'),false);assert.equal(Object.hasOwn(sourceHosts,'pro_pto'),false);
 assert.throws(()=>canonicalUrl('pro_pto','33','https://pro-pto.ru/projects/33'),/invalid_observation/);
 assert.deepEqual(scanSources.find(s=>s.id==='pro_pto').scan_targets,[{url:'https://pro-pto.ru/projects',scope:'section'}]);
});

test('3Dtoday is a manual-view candidate excluded from import and scan coverage',async()=>{
 const {importSourceIds,sourceHosts}=await import('../src/sources.mjs');
 const {scanSources,recordScan}=await import('../src/scans.mjs');
 const {ingestObservations}=await import('../src/ingest.mjs');
 const s=publicSources([]).find(s=>s.id==='3dtoday');assert.ok(s);
 assert.equal(s.state,'candidate');assert.equal(s.counts_as_source,false);
 assert.equal(s.automation,'prohibited');assert.equal(s.rules_status,'restricted');
 assert.equal(s.import_enabled,false);assert.equal(s.import_mode,'unavailable');assert.equal(s.implemented,false);
 assert.equal(s.evidence_url,'https://3dtoday.ru/board');assert.equal(s.content_date,null);assert.equal(s.activity_status,'unverified');
 assert.equal(s.code,'not_scanned');assert.equal(s.last_checked_at,null);
 assert.match(s.evidence_note,/ручного просмотра/);assert.match(s.evidence_note,/7\.3\.5/);assert.match(s.evidence_note,/11\.4/);assert.match(s.evidence_note,/RSS не подтверждены/);
 assert.equal(importSourceIds.includes(s.id),false);assert.equal(Object.hasOwn(sourceHosts,s.id),false);
 assert.equal(scanSources.some(x=>x.id===s.id),false);assert.equal(scanSources.length,22);
 const noWrites={prepare(){throw Error('Unexpected database access');}};
 await assert.rejects(()=>ingestObservations(noWrites,'owner',[{source_id:s.id,external_id:'1',canonical_url:s.evidence_url,title:'Synthetic only',observed_at:'2026-11-03T00:00:00.000Z'}],'2026-11-03T01:00:00.000Z'),/invalid_observation/);
 await assert.rejects(()=>recordScan(noWrites,'owner',{run_id:'test',source_id:s.id,source_url:s.evidence_url,scope:'section',checked_at:'2026-11-03T00:00:00.000Z',status:'success',reason:'checked',observed_count:1,saved_count:0},'2026-11-03T01:00:00.000Z'),/invalid_scan/);
});
