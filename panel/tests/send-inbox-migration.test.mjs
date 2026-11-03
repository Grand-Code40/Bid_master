import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
const migrationDir=new URL('../drizzle/',import.meta.url);
const originals=['0000_yummy_glorian.sql','0001_daily_tarantula.sql','0002_happy_the_enforcers.sql','0003_woozy_fallen_one.sql'];
const run=(db,file)=>db.exec(readFileSync(new URL(file,migrationDir),'utf8'));

test('v23 upgrade preserves all legacy records, manual guards, history and unknown session tables byte for byte',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');for(const file of originals)run(db,file);
  db.exec('CREATE TABLE legacy_sessions (owner_id TEXT,opaque TEXT); CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER)');
  db.prepare('INSERT INTO __drizzle_migrations VALUES (?,?,?)').run(1,'synthetic-old-hash',123);
  const at='2026-11-01T00:00:00.000Z';
  for(const owner of ['owner','other'])for(const state of ['draft','approved','queued','sending','uncertain','sent','manual_sent']){
   const listing=JSON.stringify({source_id:'fl',external_id:state,title:'Synthetic preserved record',canonical_url:'https://www.fl.ru/projects/42/test.html'});
   const review=JSON.stringify({state,revision:7,text:'Exact synthetic saved text\nwith newline',claim_token:state==='sending'||state==='uncertain'?'synthetic-private-claim':null,manual_delivery:state==='manual_sent'?{observation:'Synthetic manual evidence'}:null});
   db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?)').run(owner,'fl',state,listing,'{}',at,at,4);
   db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?)').run(owner,'fl',state,review,9,'old-'+state);
   db.prepare('INSERT INTO review_events VALUES (?,?,?,?,?,?,?,?)').run(owner,'old-'+state,'fl',state,'old',at,review,'old-request-hash');
   db.prepare('INSERT INTO scan_runs VALUES (?,?,?,?,?,?)').run(owner,state,'fl',at,at,'{}');
   db.prepare('INSERT INTO delivery_records VALUES (?,?,?,?,?,?)').run(owner,'fl',state,2,JSON.stringify({status:'erroneous',details:{text:'Old observation'}}),'old-'+state);
   db.prepare('INSERT INTO delivery_events VALUES (?,?,?,?,?,?,?,?,?)').run(owner,'guard-'+state,'fl',state,2,'mark_error',at,'{}','old-request-hash');
  }
  db.prepare('INSERT INTO legacy_sessions VALUES (?,?)').run('owner','synthetic-session-bytes');
  db.prepare('INSERT INTO mail_notifications VALUES (?,?,?,?,?,?,?,?,?,?)').run('owner','owner@example.test','abc',at,at,JSON.stringify({plain_text:'Original notification',observed_at:at}),'fl','draft','exact_url',at);
  const tables=['listings','reviews','review_events','scan_runs','delivery_records','delivery_events','mail_notifications','legacy_sessions','__drizzle_migrations'];
  const snapshot=()=>Object.fromEntries(tables.map(t=>[t,{rows:db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all(),schema:db.prepare('SELECT name,type,sql FROM sqlite_master WHERE tbl_name=? ORDER BY name').all(t)}]));
  const before=snapshot(),newFiles=readdirSync(migrationDir).filter(f=>f.endsWith('.sql')&&!originals.includes(f)).sort();assert.ok(newFiles.length>0);
  for(const file of newFiles)run(db,file);
  assert.deepEqual(snapshot(),before);for(const t of ['delivery_preflights','delivery_attempts','platform_messages','inbox_sync_state','mail_provider_provenance'])assert.equal(db.prepare('SELECT count(*) AS n FROM '+t).get().n,0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{db.close();}
});

test('fresh schema and generated migrations agree on columns and uniqueness for new tables',()=>{
 const fresh=new DatabaseSync(':memory:'),migrated=new DatabaseSync(':memory:');try{
  fresh.exec(readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8'));
  for(const file of readdirSync(migrationDir).filter(f=>f.endsWith('.sql')).sort())run(migrated,file);
  for(const table of ['delivery_preflights','delivery_attempts','platform_messages','inbox_sync_state','mail_provider_provenance']){
   assert.deepEqual(fresh.prepare('PRAGMA table_info('+table+')').all(),migrated.prepare('PRAGMA table_info('+table+')').all());
   const unique=db=>db.prepare('PRAGMA index_list('+table+')').all().filter(x=>x.unique).map(x=>db.prepare('PRAGMA index_info('+JSON.stringify(x.name)+')').all().map(y=>y.name).join(',')).sort();
   assert.deepEqual(unique(fresh),unique(migrated));
  }
 }finally{fresh.close();migrated.close();}
});
