import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {handleMcp} from '../src/mcp.mjs';
import {handleApi} from '../src/api.mjs';
const now='2026-11-01T00:00:00.000Z';
const mail={mailbox:'owner@example.test',message_id:'18abc',thread_id:'18def',received_at:now,observed_at:now,sender:'Customer <client@example.test>',subject:'Reply',plain_text:'A relevant observed reply',reference:null};
const headers={'Content-Type':'application/json','oai-authenticated-user-id':'owner'};
async function record(db,args=mail,extra={}){const r=await handleMcp(new Request('https://site.test/mcp',{method:'POST',headers:{...headers,...extra},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bid_record_mail',arguments:args}})}),{DB:db,OWNER_USER_ID:'owner'});const b=await r.json();return {status:r.status,...(b.result?JSON.parse(b.result.content[0].text):b.error)};}
async function list(db,owner='owner'){return (await handleApi(new Request('https://site.test/api/inbox',{headers:{'oai-authenticated-user-id':owner}}),{DB:db,OWNER_USER_ID:owner})).json();}
test('single observed email saves once, immutable retries and owner/mailbox isolation',async()=>{const db=fixture();try{
 const first=await record(db);assert.equal(first.duplicate,false);assert.equal(first.message.kind,'email_notification');assert.equal(first.message.link_status,'unlinked');
 assert.equal((await record(db)).duplicate,true);
 assert.equal((await record(db,{...mail,subject:'changed'})).error,'mail_conflict');
 assert.equal((await list(db)).messages.length,1);assert.equal((await list(db,'other')).messages.length,0);
 assert.equal((await record(db,{...mail,mailbox:'second@example.test'})).duplicate,false);
 assert.equal((await record(db,mail,{'oai-authenticated-user-id':'other'})).status,403);
 }finally{db.close();}});
test('concurrent same-key observations cannot overwrite one another',async()=>{const db=fixture();try{const results=await Promise.all([record(db),record(db),record(db,{...mail,subject:'conflict'})]);assert.equal(results.filter(x=>x.error==='mail_conflict').length,1);assert.equal(results.filter(x=>x.duplicate===false).length,1);assert.equal((await list(db)).messages.length,1);}finally{db.close();}});
test('strict observed data rejects injections, oversized fields, future times and HTML-only inputs',async()=>{const db=fixture();try{
 for(const extra of [{owner_id:'other'},{html:'<img src=x>'},{credentials:'secret'},{plain_text:'x'.repeat(12001)},{subject:'x'.repeat(501)},{received_at:'2099-01-01T00:00:00.000Z'},{observed_at:'bad'},{message_id:'../x'},{mailbox:'not-a-mailbox'},{reference:{source_id:'fl',external_id:'42',canonical_url:'javascript:alert(1)'}}])assert.equal((await record(db,{...mail,...extra})).error,'invalid_mail',JSON.stringify(extra).slice(0,80));
 assert.equal((await list(db)).messages.length,0);
 }finally{db.close();}});
test('only exact observed canonical URL links an existing order; missing and ambiguous remain separate',async()=>{const db=fixture();try{
 const url='https://www.fl.ru/projects/42/test.html',listing={source_id:'fl',external_id:'42',canonical_url:url,listing_kind:'order'};
 await db.prepare('INSERT INTO listings (owner_id,source_id,external_id,data,first_seen,last_seen) VALUES (?,?,?,?,?,?)').bind('owner','fl','42',JSON.stringify(listing),now,now).run();
 const reference={source_id:'fl',external_id:'42',canonical_url:url};
 assert.equal((await record(db,{...mail,reference,plain_text:'See '+url})).message.link_status,'exact_url');
 assert.equal((await record(db,{...mail,message_id:'18abd',reference})).error,'invalid_mail');
 const missing={source_id:'fl',external_id:'43',canonical_url:'https://www.fl.ru/projects/43/missing.html'};
 assert.equal((await record(db,{...mail,message_id:'18abe',reference:missing,plain_text:missing.canonical_url})).message.link_status,'unresolved');
 assert.equal((await record(db,{...mail,message_id:'18abf',reference:null,plain_text:'42 maybe 43'})).message.source_id,null);
 }finally{db.close();}});
test('view marker is same-origin, owner-only, monotonic and never changes Gmail or message content',async()=>{const db=fixture();try{
 await record(db);
 const request=(origin='https://site.test',who='owner')=>new Request('https://site.test/api/inbox/viewed',{method:'POST',headers:{...headers,Origin:origin,'oai-authenticated-user-id':who},body:JSON.stringify({mailbox:mail.mailbox,message_id:mail.message_id})});
 const env={DB:db,OWNER_USER_ID:'owner'};
 assert.equal((await handleApi(request('https://evil.test'),env)).status,403);assert.equal((await handleApi(request('https://site.test','other'),env)).status,403);
 assert.equal((await handleApi(request(),env)).status,200);const first=(await list(db)).messages[0];assert.ok(first.panel_viewed_at);
 await handleApi(request(),env);assert.equal((await list(db)).messages[0].panel_viewed_at,first.panel_viewed_at);
 assert.equal((await record(db)).duplicate,true);assert.equal((await list(db)).messages[0].plain_text,mail.plain_text);
 }finally{db.close();}});
test('cursor pagination is complete across equal dates and strictly scoped',async()=>{const db=fixture();try{
 for(let n=1;n<=102;n++)await record(db,{...mail,message_id:n.toString(16)});
 const first=await list(db);assert.equal(first.messages.length,100);assert.ok(first.next_cursor);
 const r=await handleApi(new Request('https://site.test/api/inbox?cursor='+encodeURIComponent(first.next_cursor),{headers}),{DB:db,OWNER_USER_ID:'owner'});const second=await r.json();assert.equal(second.messages.length,2);assert.equal(second.next_cursor,null);assert.equal(new Set([...first.messages,...second.messages].map(m=>m.message_id)).size,102);
 for(const cursor of ['{}','null','[]','x','{"owner_id":"other"}'])assert.equal((await handleApi(new Request('https://site.test/api/inbox?cursor='+encodeURIComponent(cursor),{headers}),{DB:db,OWNER_USER_ID:'owner'})).status,400);
 }finally{db.close();}});
test('MCP foreign origin, writer-only access, unknown fields and missing viewed targets fail closed',async()=>{const db=fixture();try{
 assert.equal((await record(db,mail,{Origin:'https://evil.test'})).status,403);
 assert.equal((await record(db,mail,{'oai-authenticated-user-id':'','X-Bid-Writer-Token':'x'.repeat(32)})).status,401);
 assert.equal((await record(db,{...mail,reference:{source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html',confirmed:true}})).error,'invalid_mail');
 const r=await handleApi(new Request('https://site.test/api/inbox/viewed',{method:'POST',headers:{...headers,Origin:'https://site.test'},body:JSON.stringify({mailbox:mail.mailbox,message_id:mail.message_id})}),{DB:db,OWNER_USER_ID:'owner'});assert.equal(r.status,404);
 }finally{db.close();}});
test('later observations replay unchanged mail without changing first observation or panel marker',async()=>{const db=fixture();try{
 const first=await record(db);const viewedAt='2026-11-02T00:00:00.000Z';
 await db.prepare('UPDATE mail_notifications SET panel_viewed_at=? WHERE owner_id=? AND mailbox=? AND message_id=?').bind(viewedAt,'owner',mail.mailbox,mail.message_id).run();
 const replay=await record(db,{...mail,observed_at:'2026-11-02T00:00:00.000Z'});
 assert.equal(replay.duplicate,true);assert.equal(replay.message.observed_at,mail.observed_at);assert.equal(replay.message.recorded_at,first.message.recorded_at);assert.equal(replay.message.panel_viewed_at,viewedAt);
 assert.equal((await record(db,{...mail,observed_at:'2026-11-02T00:00:00.000Z',plain_text:'Changed content'})).error,'mail_conflict');
 }finally{db.close();}});
test('concurrent observation timestamps deduplicate while meaningful content still conflicts',async()=>{const db=fixture();try{
 const results=await Promise.all([record(db),record(db,{...mail,observed_at:'2026-11-02T00:00:00.000Z'}),record(db,{...mail,subject:'Changed subject',observed_at:'2026-11-02T00:00:00.000Z'})]);
 assert.equal(results.filter(x=>x.error==='mail_conflict').length,1);assert.equal(results.filter(x=>x.duplicate===false).length,1);assert.equal(results.filter(x=>x.duplicate===true).length,1);
 const messages=(await list(db)).messages;assert.equal(messages.length,1);assert.equal(messages[0].observed_at,mail.observed_at);
 }finally{db.close();}});
test('authentication secrets and verification/reset links fail closed without storing any mail',async()=>{const db=fixture();try{
 for(const plain_text of ['Код подтверждения: 123456','Your verification code is 123456','Your code is 123456','OTP: 123456','OTP 123456','Ваш код: 123456','Код для входа 123456','Reset your password using this link','Пароль: SuperPrivate42','password = SuperPrivate42','reset_token=very-private-token','https://accounts.example.test/reset?token=very-private-token','https://example.test/verify/secret-value','Authorization: Bearer abcdef1234','sk-proj-abcdefghijklmnopqrstuvwxyz0123456789','-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----']){
  assert.ok(['mail_auth_content','mail_secret_content','mail_unsafe_link'].includes((await record(db,{...mail,plain_text})).error),plain_text);
 }
 assert.equal((await list(db)).messages.length,0);
 }finally{db.close();}});
test('multiple distinct URLs cannot produce an exact order link even if one reference matches',async()=>{const db=fixture();try{
 const url='https://www.fl.ru/projects/42/test.html',reference={source_id:'fl',external_id:'42',canonical_url:url};
 await db.prepare('INSERT INTO listings (owner_id,source_id,external_id,data,first_seen,last_seen) VALUES (?,?,?,?,?,?)').bind('owner','fl','42',JSON.stringify({...reference,listing_kind:'order'}),now,now).run();
 const result=await record(db,{...mail,reference,plain_text:url+'\nhttps://www.fl.ru/projects/43/other.html'});
 assert.equal(result.message.link_status,'unlinked');assert.equal(result.message.source_id,null);assert.equal(result.message.external_id,null);assert.equal(result.message.reference,null);
 }finally{db.close();}});
test('pre-correction rows replay without backfill, preserving original timestamps and bytes',async()=>{const db=fixture();try{
 const legacy={...mail},bytes=JSON.stringify(legacy),recorded='2026-11-01T01:00:00.000Z',seen='2026-11-01T02:00:00.000Z';
 await db.prepare('INSERT INTO mail_notifications (owner_id,mailbox,message_id,received_at,recorded_at,data,source_id,external_id,link_status,panel_viewed_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('owner',mail.mailbox,mail.message_id,mail.received_at,recorded,bytes,null,null,'unlinked',seen).run();
 const replay=await record(db,{...mail,observed_at:'2026-11-02T00:00:00.000Z'});assert.equal(replay.duplicate,true);assert.equal(replay.message.recorded_at,recorded);assert.equal(replay.message.panel_viewed_at,seen);assert.equal(replay.message.observed_at,mail.observed_at);
 const row=await db.prepare('SELECT data FROM mail_notifications WHERE owner_id=? AND mailbox=? AND message_id=?').bind('owner',mail.mailbox,mail.message_id).first();assert.equal(row.data,bytes);
 for(const changes of [{sender:'different@example.test'},{thread_id:'ffff'},{received_at:'2026-10-31T00:00:00.000Z'},{subject:'Different'},{plain_text:'Different'}])assert.equal((await record(db,{...mail,...changes,observed_at:'2026-11-02T00:00:00.000Z'})).error,'mail_conflict');
 }finally{db.close();}});
test('secret guard checks subject and sender and opaque or encoded links too',async()=>{const db=fixture();try{
 for(const changes of [{subject:'Your code is 123456'},{sender:'password: hidden'},{plain_text:'https://example.test/path?code=abc'},{plain_text:'https://example.test/path#secret'},{plain_text:'https://example.test/%72eset/abc'},{plain_text:'https://user:secret@example.test/path'},{plain_text:'https://example.test/oauth/callback'}])assert.ok(['mail_auth_content','mail_secret_content','mail_unsafe_link'].includes((await record(db,{...mail,...changes})).error));
 assert.equal((await list(db)).messages.length,0);
 }finally{db.close();}});
test('ordinary project text and author URLs do not match authentication substrings',async()=>{const db=fixture();try{
 let n=1000;for(const plain_text of ['Blender render presets','Подтверждено техническое задание','Код детали 123456','https://example.test/author/designer','We need verification of the geometry','Please recover the drawing']){
  const result=await record(db,{...mail,message_id:(n++).toString(16),plain_text});assert.equal(result.error,undefined,plain_text);assert.equal(result.duplicate,false);
 }
 assert.equal((await list(db)).messages.length,6);
 }finally{db.close();}});
test('safety rejection reports only a stable content-free category',async()=>{const db=fixture();try{
 for(const [plain_text,category] of [['Your verification code is 123456','mail_auth_content'],['password = SuperPrivate42','mail_secret_content'],['https://example.test/reset?token=very-private-token','mail_unsafe_link']]){
  const result=await record(db,{...mail,plain_text});assert.equal(result.error,category);assert.equal(JSON.stringify(result).includes(plain_text),false);
 }
 }finally{db.close();}});
