import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
test('additive generated migration preserves every existing table, legacy identity, review queue and session bytes',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec(readFileSync(new URL('../drizzle/0000_yummy_glorian.sql',import.meta.url),'utf8'));
 db.exec("INSERT INTO listings VALUES ('owner','kwork','legacy','{\"title\":\"legacy\"}','{}','old','old',7); INSERT INTO reviews VALUES ('owner','kwork','legacy','{\"state\":\"queued\",\"claim_token\":\"synthetic\"}',3,'op'); INSERT INTO review_events VALUES ('owner','op','kwork','legacy','queue','old','{}','hash'); CREATE TABLE legacy_sessions (identity TEXT, cookie TEXT); INSERT INTO legacy_sessions VALUES ('owner','synthetic-session');");
 const tables=['listings','reviews','review_events','legacy_sessions'];const before=Object.fromEntries(tables.map(t=>[t,{rows:db.prepare('SELECT * FROM '+t).all(),schema:db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(t).sql}]));
 const files=readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')&&!f.startsWith('0000'));assert.ok(['0001_daily_tarantula.sql','0002_happy_the_enforcers.sql','0003_woozy_fallen_one.sql'].every(file=>files.includes(file)));
 for(const file of files.sort()){const migration=readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8');assert.doesNotMatch(migration,/\b(DROP|ALTER|UPDATE|DELETE|REPLACE)\b/i);db.exec(migration);}
 for(const t of tables){assert.deepEqual(db.prepare('SELECT * FROM '+t).all(),before[t].rows);assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(t).sql,before[t].schema);}
 assert.equal(db.prepare('SELECT count(*) n FROM scan_runs').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM mail_notifications').get().n,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('inbox migration alone preserves populated current database, manual delivery audit, scans and migration journal',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec('PRAGMA foreign_keys=ON');
 for(const file of ['0000_yummy_glorian.sql','0001_daily_tarantula.sql'])db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC); CREATE TABLE legacy_sessions (identity TEXT, cookie TEXT)');
 db.prepare('INSERT INTO __drizzle_migrations VALUES (?,?,?)').run(1,'synthetic-existing-hash',1793652415715);
 db.prepare('INSERT INTO legacy_sessions VALUES (?,?)').run('owner','synthetic-session');
 const timestamp='2026-11-03T09:00:00.000Z';
 for(const owner of ['owner','other'])for(const state of ['manual_sent','queued','sending','uncertain','sent','draft']){
  const review={state,revision:7,text:'Exact saved text\nsecond line',manual_delivery:state==='manual_sent'?{text:'Exact saved text\nsecond line',observation:'Synthetic own-response evidence',observed_at:timestamp,recorded_at:timestamp,delivery_url:'https://vmasshtabe.ru/account/view-task?id=123&response_id=456'}:null};
  db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?)').run(owner,'vmasshtabe',state,JSON.stringify({title:'Synthetic preserved '+state,listing_kind:'order'}),'{}',timestamp,timestamp,9);
  db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?)').run(owner,'vmasshtabe',state,JSON.stringify(review),11,state);
  db.prepare('INSERT INTO review_events VALUES (?,?,?,?,?,?,?,?)').run(owner,state,'vmasshtabe',state,state==='manual_sent'?'record_manual_delivery':'save',timestamp,JSON.stringify(review),'synthetic-request-hash');
  db.prepare('INSERT INTO scan_runs VALUES (?,?,?,?,?,?)').run(owner,state,'vmasshtabe',timestamp,timestamp,JSON.stringify({status:'success',scope:'single_item'}));
 }
 const tables=['listings','reviews','review_events','scan_runs','legacy_sessions','__drizzle_migrations'];
 const snapshot=()=>Object.fromEntries(tables.map(t=>[t,{rows:db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all(),objects:db.prepare('SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type,name').all(t)}]));
 const before=snapshot(),migration=readFileSync(new URL('../drizzle/0002_happy_the_enforcers.sql',import.meta.url),'utf8');
 assert.doesNotMatch(migration,/\b(DROP|ALTER|UPDATE|DELETE|REPLACE)\b/i);db.exec(migration);
 assert.deepEqual(snapshot(),before);
 db.prepare('INSERT INTO mail_notifications (owner_id,mailbox,message_id,received_at,recorded_at,data,link_status) VALUES (?,?,?,?,?,?,?)').run('owner','owner@example.test','abc',timestamp,timestamp,JSON.stringify({subject:'Synthetic mail'}),'unlinked');
 assert.equal(db.prepare('SELECT count(*) n FROM mail_notifications').get().n,1);
 assert.deepEqual(snapshot(),before);
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{db.close();}
});

test('delivery migration preserves populated current tables, old manual state, immutable review audit and inbox exactly',()=>{
 const db=new DatabaseSync(':memory:');try{
 for(const file of ['0000_yummy_glorian.sql','0001_daily_tarantula.sql','0002_happy_the_enforcers.sql'])db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 for(const owner of ['owner','other']){
  const listing=JSON.stringify({title:'Old actual data',canonical_url:'https://vmasshtabe.ru/task/old'}),review=JSON.stringify({state:'manual_sent',manual_delivery:{text:'Original text',observation:'Original observation'},revision:7});
  db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?)').run(owner,'vmasshtabe','old',listing,'{}','old','old',8);
  db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?)').run(owner,'vmasshtabe','old',review,12,'old-operation');
  db.prepare('INSERT INTO review_events VALUES (?,?,?,?,?,?,?,?)').run(owner,'old-operation','vmasshtabe','old','record_manual_delivery','old',review,'old-hash');
  db.prepare('INSERT INTO scan_runs VALUES (?,?,?,?,?,?)').run(owner,'scan','vmasshtabe','old','old','{}');
  db.prepare('INSERT INTO mail_notifications VALUES (?,?,?,?,?,?,?,?,?,?)').run(owner,'synthetic@example.test','abc','old','old','{"plain_text":"Original email"}','vmasshtabe','old','exact_url','old-viewed');
 }
 db.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT); INSERT INTO __drizzle_migrations VALUES (1,'original');");
 const tables=['listings','reviews','review_events','scan_runs','mail_notifications','__drizzle_migrations'];const snapshot=()=>Object.fromEntries(tables.map(t=>[t,{rows:db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all(),schema:db.prepare('SELECT name,type,sql FROM sqlite_master WHERE tbl_name=? ORDER BY name').all(t)}]));const before=snapshot();
 const migration=readFileSync(new URL('../drizzle/0003_woozy_fallen_one.sql',import.meta.url),'utf8');assert.doesNotMatch(migration,/\b(DROP|ALTER|UPDATE|DELETE|REPLACE)\b/i);db.exec(migration);assert.deepEqual(snapshot(),before);assert.equal(db.prepare('SELECT count(*) n FROM delivery_records').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM delivery_events').get().n,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{db.close();}
});
