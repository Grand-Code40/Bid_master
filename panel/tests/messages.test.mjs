import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {recordMail} from '../src/inbox.mjs';
const mod=await import('../src/messages.mjs').catch(()=>({}));
const now='2026-11-03T12:00:00.000Z';
const ref={source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html'};
const input={source_id:'fl',account_id:'acct-1',message_id:'message-1',thread_id:'thread-1',received_at:now,observed_at:now,sender:'Client',plain_text:'Please update the drawing',reference:ref};
async function setup(){const db=fixture();await db.prepare('INSERT INTO listings(owner_id,source_id,external_id,data,first_seen,last_seen) VALUES (?,?,?,?,?,?)').bind('owner','fl','42',JSON.stringify({...ref,listing_kind:'order'}),now,now).run();return db;}
test('platform observations are immutable, owner scoped and retain caller provenance',async()=>{
 assert.equal(typeof mod.recordPlatformMessage,'function');const db=await setup();try{
 const first=await mod.recordPlatformMessage(db,'owner',input,now);assert.equal(first.duplicate,false);assert.equal(first.message.provenance,'caller_observed');assert.equal(first.message.kind,'platform_message');assert.equal(first.message.link_status,'exact_url');
 assert.equal((await mod.recordPlatformMessage(db,'owner',{...input,observed_at:'2026-11-03T12:01:00.000Z'},'2026-11-03T12:01:00.000Z')).duplicate,true);
 await assert.rejects(mod.recordPlatformMessage(db,'owner',{...input,plain_text:'Changed'},now),/message_conflict/);
 assert.equal((await mod.listUnifiedInbox(db,'other')).messages.length,0);assert.equal((await mod.listUnifiedInbox(db,'owner')).messages[0].plain_text,input.plain_text);
 }finally{db.close();}
});
test('platform input rejects paused/unsupported sources, unknown fields, wrong links and unsafe content',async()=>{
 assert.equal(typeof mod.recordPlatformMessage,'function');const db=await setup();try{
 for(const [change,code] of [[{source_id:'weblancer'},'source_paused'],[{source_id:'kwork'},'source_unsupported'],[{extra:1},'invalid_message'],[{account_id:'x'.repeat(129)},'invalid_message'],[{reference:null},'invalid_message'],[{reference:{...ref,canonical_url:'https://evil.test/42'}},'invalid_message'],[{reference:{...ref,external_id:'43',canonical_url:'https://www.fl.ru/projects/43/no.html'}},'message_listing_not_found'],[{plain_text:'<b>HTML</b>'},'invalid_message'],[{plain_text:'password: private'},'mail_secret_content'],[{plain_text:'Your code is 123456'},'mail_auth_content'],[{plain_text:'https://example.test/path?token=private'},'mail_unsafe_link']])await assert.rejects(mod.recordPlatformMessage(db,'owner',{...input,...change},now),new RegExp(code));
 assert.equal((await mod.listUnifiedInbox(db,'owner')).messages.length,0);
 }finally{db.close();}
});
test('unified pagination traverses equal dates without merging email and platform content; viewed is local',async()=>{
 assert.equal(typeof mod.listUnifiedInbox,'function');const db=await setup();try{
 for(let i=0;i<101;i++)await mod.recordPlatformMessage(db,'owner',{...input,message_id:'message-'+i},now);
 await recordMail(db,'owner',{mailbox:'owner@example.test',message_id:'abc',thread_id:'def',received_at:now,observed_at:now,sender:'Client',subject:'Reply',plain_text:input.plain_text,reference:null},now);
 const first=await mod.listUnifiedInbox(db,'owner');assert.equal(first.messages.length,100);assert.ok(first.next_cursor);
 const second=await mod.listUnifiedInbox(db,'owner',first.next_cursor);assert.equal(second.messages.length,2);assert.equal(second.next_cursor,null);
 const all=[...first.messages,...second.messages];assert.equal(new Set(all.map(x=>x.message_key)).size,102);assert.equal(all.find(x=>x.kind==='email_notification').provenance,'caller_observed');
 const key=all.find(x=>x.kind==='platform_message').message_key;assert.deepEqual(await mod.markMessageViewed(db,'owner',{message_key:key},now),{panel_viewed:true,provider_changed:false});
 await mod.markMessageViewed(db,'owner',{message_key:key},'2026-11-03T13:00:00.000Z');const again=[...(await mod.listUnifiedInbox(db,'owner')).messages,...(await mod.listUnifiedInbox(db,'owner',first.next_cursor)).messages];assert.equal(again.find(x=>x.message_key===key).panel_viewed_at,now);
 await assert.rejects(mod.markMessageViewed(db,'other',{message_key:key},now),/message_not_found/);
 for(const cursor of ['{}','[]','null','bad'])await assert.rejects(mod.listUnifiedInbox(db,'owner',cursor),/invalid_message_cursor/);
 }finally{db.close();}
});

test('platform reference is exact saved order; text cannot introduce arbitrary URLs and email-shaped sender is text',async()=>{
 const db=await setup();try{
 await assert.rejects(mod.recordPlatformMessage(db,'other',input,now),/message_listing_not_found/);
 await assert.rejects(mod.recordPlatformMessage(db,'owner',{...input,plain_text:'https://evil.test/path'},now),/invalid_message/);
 await assert.rejects(mod.recordPlatformMessage(db,'owner',{...input,reference:{...ref,source_id:'freelance'}},now),/invalid_message/);
 const valid=await mod.recordPlatformMessage(db,'owner',{...input,sender:'Client <client@example.test>',plain_text:'See '+ref.canonical_url},now);assert.equal(valid.message.sender,'Client <client@example.test>');
 }finally{db.close();}
});
test('mixed keyset timeline reaches an older new import without modifying legacy email bytes',async()=>{
 const db=await setup();try{
 for(let i=0;i<60;i++)await mod.recordPlatformMessage(db,'owner',{...input,message_id:'m-'+i},now);
 for(let i=1;i<=60;i++)await recordMail(db,'owner',{mailbox:'owner@example.test',message_id:i.toString(16),thread_id:'def',received_at:now,observed_at:now,sender:'Client',subject:'Reply',plain_text:'Legacy '+i,reference:null},now);
 const original=await db.prepare('SELECT data FROM mail_notifications WHERE owner_id=? AND message_id=?').bind('owner','1').first();
 const first=await mod.listUnifiedInbox(db,'owner');assert.ok(first.next_cursor);assert.equal(first.messages.length,100);
 const old='2026-10-01T00:00:00.000Z';await mod.recordPlatformMessage(db,'owner',{...input,message_id:'older-new-import',received_at:old},now);
 const second=await mod.listUnifiedInbox(db,'owner',first.next_cursor);assert.equal(second.messages.length,21);assert.equal(second.messages.at(-1).message_id,'older-new-import');
 const email=first.messages.find(x=>x.kind==='email_notification');await mod.markMessageViewed(db,'owner',{message_key:email.message_key},now);assert.equal((await db.prepare('SELECT data FROM mail_notifications WHERE owner_id=? AND message_id=?').bind('owner','1').first()).data,original.data);
 assert.equal(new Set([...first.messages,...second.messages].map(x=>x.message_key)).size,121);
 }finally{db.close();}
});
