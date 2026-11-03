import {recordMail} from '../src/inbox.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {listUnifiedInbox} from '../src/messages.mjs';
const mod=await import('../src/mail-sync.mjs').catch(()=>({}));
const now='2026-11-03T12:00:00.000Z';
const env={GMAIL_ACCESS_TOKEN:'synthetic-runtime-secret',GMAIL_MAILBOX:'owner@example.test',GMAIL_NOTIFICATION_QUERY:'from:notify@example.test newer_than:30d'};
async function setup(){const db=fixture();return db;}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const message=(id,text='Project notification')=>({id,threadId:'def',internalDate:String(Date.parse('2026-11-03T11:59:00.000Z')),payload:{mimeType:'text/plain',headers:[{name:'From',value:'Client <client@example.test>'},{name:'Subject',value:'Project reply'}],body:{size:Buffer.byteLength(text),data:Buffer.from(text).toString('base64url')}}});
function server({profile='owner@example.test',pages=[{messages:[{id:'abc'}]}],messages={},listStatus=200}={}){const calls=[];return {calls,fetch:async(raw,init)=>{const u=new URL(raw);calls.push({url:u.href,method:init.method});assert.ok(['gmail.googleapis.com','oauth2.googleapis.com'].includes(u.hostname));assert.equal(init.redirect,'error');if(u.pathname.endsWith('/profile'))return json({emailAddress:profile,messagesTotal:1,threadsTotal:1,historyId:'100'});if(u.pathname.endsWith('/messages'))return json(pages.shift()??{},listStatus);const id=u.pathname.split('/').at(-1);return json(messages[id]??message(id));}};}
test('unconfigured and unbounded Gmail never fetch; statuses distinguish paused and manual',async()=>{
 assert.equal(typeof mod.inboxChannels,'function');const db=await setup();try{
 const channels=await mod.inboxChannels(db,'owner',{},now);assert.equal(channels.channels.find(x=>x.channel==='gmail').status,'not_configured');assert.equal(channels.channels.find(x=>x.channel==='weblancer').status,'paused');
 for(const query of ['', 'in:inbox', 'newer_than:999d from:a@test', 'from:a@test OR newer_than:1d']){let calls=0;const result=await mod.syncMail(db,'owner',{...env,GMAIL_NOTIFICATION_QUERY:query},now,{fetch:async()=>{calls++;throw Error('unexpected');}});assert.equal(result.status,'configuration_required');assert.equal(calls,0);}
 }finally{db.close();}
});
test('bounded Gmail page imports plain notification, hides cursor and excludes initial backlog latency',async()=>{
 assert.equal(typeof mod.syncMail,'function');const db=await setup();try{
 const fake=server({pages:[{messages:[{id:'abc'}],nextPageToken:'private-page-2'},{messages:[{id:'abd'}]}]});
 const first=await mod.syncMail(db,'owner',env,now,{fetch:fake.fetch});assert.equal(first.status,'partial');assert.equal(first.imported,1);assert.equal(first.coverage,'partial_notifications_only');assert.equal(JSON.stringify(first).includes('private-page-2'),false);
 assert.equal((await listUnifiedInbox(db,'owner')).messages[0].provenance,'provider_verified');assert.equal((await listUnifiedInbox(db,'owner')).messages[0].receipt_to_storage_ms,null);
 const second=await mod.syncMail(db,'owner',env,now,{fetch:fake.fetch});assert.equal(second.status,'ready');assert.ok(fake.calls.some(c=>new URL(c.url).searchParams.get('pageToken')==='private-page-2'));
 const bytes=await db.prepare('SELECT data FROM mail_notifications WHERE owner_id=? AND message_id=?').bind('owner','abc').first();
 await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{messages:[{id:'abe'},{id:'abc'}]}]}).fetch});
 assert.equal((await listUnifiedInbox(db,'owner')).messages.find(x=>x.message_id==='abe').receipt_to_storage_ms,null);assert.equal((await db.prepare('SELECT data FROM mail_notifications WHERE owner_id=? AND message_id=?').bind('owner','abc').first()).data,bytes.data);
 assert.equal((await listUnifiedInbox(db,'other')).messages.length,0);assert.equal(fake.calls.filter(c=>c.method!=='GET').length,0);
 }finally{db.close();}
});
test('Gmail rejects account mismatch and classifies 401/403/429/timeout without retaining provider details',async()=>{
 assert.equal(typeof mod.syncMail,'function');const db=await setup();try{
 const mismatch=server({profile:'someone@example.test'});assert.equal((await mod.syncMail(db,'owner',env,now,{fetch:mismatch.fetch})).error_code,'account_mismatch');assert.equal(mismatch.calls.length,1);
 for(const [status,code] of [[401,'unauthorized'],[403,'forbidden'],[429,'rate_limited'],[500,'provider_unavailable'],[400,'configuration_error']]){
 const result=await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{error:{message:'RAW PRIVATE VALUE'}}],listStatus:status}).fetch});assert.equal(result.error_code,code);assert.equal(JSON.stringify(result).includes('RAW PRIVATE VALUE'),false);
 }
 const timeout=await mod.syncMail(db,'owner',env,now,{fetch:async()=>{throw new DOMException('private-timeout','TimeoutError');}});assert.equal(timeout.error_code,'timeout');
 assert.equal((await listUnifiedInbox(db,'owner')).messages.length,0);assert.equal(JSON.stringify(await mod.inboxChannels(db,'owner',env,now)).includes(env.GMAIL_ACCESS_TOKEN),false);
 }finally{db.close();}
});
test('unsafe auth content, HTML-only, malformed/oversized MIME and attachments are skipped without persistence',async()=>{
 assert.equal(typeof mod.syncMail,'function');const db=await setup();try{
 const html=message('abe');html.payload.mimeType='text/html';
 const attach=message('abf');attach.payload.filename='secret.txt';
 const invalid=message('ac0');invalid.payload.body.data='%%%';
 const oversized=message('ac1');oversized.payload.body.size=999999;
 const messages={abc:message('abc','Your verification code is 123456'),abd:message('abd','https://example.test/reset?token=secret'),abe:html,abf:attach,ac0:invalid,ac1:oversized};
 const result=await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{messages:Object.keys(messages).map(id=>({id}))}],messages}).fetch});assert.equal(result.skipped,6);assert.equal(result.imported,0);assert.equal(result.status,'ready');assert.equal((await listUnifiedInbox(db,'owner')).messages.length,0);
 }finally{db.close();}
});
test('page bound and private lease prevent concurrent upstream polls; failure preserves page cursor',async()=>{
 assert.equal(typeof mod.syncMail,'function');const db=await setup();try{
 let unblock,entered;const ready=new Promise(r=>{entered=r;});const gate=new Promise(r=>{unblock=r;});const fake=server({pages:[{messages:[{id:'abc'}],nextPageToken:'page-two'}]});
 const first=mod.syncMail(db,'owner',env,now,{fetch:async(url,init)=>{if(String(url).endsWith('/profile')){entered();await gate;}return fake.fetch(url,init);}});await ready;
 const second=await mod.syncMail(db,'owner',env,now,{fetch:fake.fetch});assert.equal(second.status,'busy');unblock();await first;
 const failed=await mod.syncMail(db,'owner',env,now,{fetch:async(url,init)=>String(url).includes('/profile')?fake.fetch(url,init):json({error:'private'},429)});assert.equal(failed.error_code,'rate_limited');
 const state=await db.prepare('SELECT page_cursor FROM inbox_sync_state WHERE owner_id=? AND channel=?').bind('owner','gmail').first();assert.equal(state.page_cursor,'page-two');
 const tooMany=server({pages:[{messages:Array.from({length:11},(_,i)=>({id:(i+256).toString(16)}))}]});assert.equal((await mod.syncMail(db,'owner',env,now,{fetch:tooMany.fetch})).error_code,'invalid_provider_response');assert.equal(tooMany.calls.filter(x=>/\/messages\//.test(x.url)).length,0);
 }finally{db.close();}
});
test('configuration changes restart bounded catchup and refresh credentials use only fixed token endpoint',async()=>{
 assert.equal(typeof mod.syncMail,'function');const db=await setup();try{
 await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{messages:[],nextPageToken:'old-private'}]}).fetch});
 const changed=server({pages:[{}]});await mod.syncMail(db,'owner',{...env,GMAIL_NOTIFICATION_QUERY:'from:new@example.test newer_than:7d'},now,{fetch:changed.fetch});assert.equal(changed.calls.some(c=>new URL(c.url).searchParams.has('pageToken')),false);
 const refresh={...env,GMAIL_ACCESS_TOKEN:undefined,GMAIL_CLIENT_ID:'synthetic-id',GMAIL_CLIENT_SECRET:'synthetic-secret',GMAIL_REFRESH_TOKEN:'synthetic-refresh'};const provider=server();let tokens=0;
 const result=await mod.syncMail(db,'owner',refresh,now,{fetch:async(url,init)=>{if(url==='https://oauth2.googleapis.com/token'){tokens++;assert.equal(init.method,'POST');assert.ok(String(init.body).includes('grant_type=refresh_token'));return json({access_token:'synthetic-access',expires_in:3600,token_type:'Bearer'});}return provider.fetch(url,init);}});assert.equal(result.status,'ready');assert.equal(tokens,1);
 }finally{db.close();}
});

test('provider completion clock controls storage time, success and subsequent latency samples',async()=>{
 const db=await setup();try{
 await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{}]}).fetch});
 const recent=message('aaa');recent.internalDate=String(Date.parse(now));let instant=now;const provider=server({pages:[{messages:[{id:'aaa'}]}],messages:{aaa:recent}});const done='2026-11-03T12:00:05.000Z';
 const result=await mod.syncMail(db,'owner',env,()=>instant,{fetch:async(url,init)=>{if(String(url).includes('/messages/'))instant=done;return provider.fetch(url,init);}});
 assert.equal(result.last_attempt,now);assert.equal(result.last_success,done);const saved=(await listUnifiedInbox(db,'owner')).messages[0];assert.equal(saved.recorded_at,done);assert.equal(saved.observed_at,done);assert.equal(saved.receipt_to_storage_ms,5000);
 }finally{db.close();}
});
test('rate limit Retry-After is bounded and content free; forbidden is separate and unscheduled',async()=>{
 const db=await setup();try{
 for(const [header,want] of [['120',120],['99999999',null],['private-text',null]]){
 const provider=server();const result=await mod.syncMail(db,'header-'+header,env,now,{fetch:async(url,init)=>String(url).includes('/profile')?provider.fetch(url,init):new Response('{"error":"private"}',{status:429,headers:{'Retry-After':header}})});
 assert.equal(result.error_code,'rate_limited');assert.equal(result.retry_after_seconds,want);assert.equal(result.mode,'manual_sync');assert.equal(JSON.stringify(result).includes('private-text'),false);
 }
 const forbidden=await mod.syncMail(db,'owner',env,now,{fetch:async()=>new Response('private',{status:403,headers:{'Retry-After':'120'}})});assert.equal(forbidden.error_code,'forbidden');assert.equal(forbidden.retry_after_seconds,null);
 }finally{db.close();}
});
test('mid-page failure retains old cursor and committed data; repeated catchup pages do not overwrite duplicates',async()=>{
 const db=await setup();try{
 await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{messages:[{id:'aaa'}],nextPageToken:'cursor-2'}]}).fetch});
 const provider=server({pages:[{messages:[{id:'aab'},{id:'aac'}],nextPageToken:'cursor-3'}]});const failed=await mod.syncMail(db,'owner',env,now,{fetch:async(url,init)=>String(url).includes('/messages/aac')?json({error:'private'},500):provider.fetch(url,init)});
 assert.equal(failed.error_code,'provider_unavailable');assert.equal(failed.has_more,true);assert.equal((await listUnifiedInbox(db,'owner')).messages.length,2);
 const state=await db.prepare('SELECT page_cursor FROM inbox_sync_state WHERE owner_id=?').bind('owner').first();assert.equal(state.page_cursor,'cursor-2');
 const next=server({pages:[{messages:[{id:'aab'},{id:'aac'}],nextPageToken:'cursor-3'},{messages:[]}]});assert.equal((await mod.syncMail(db,'owner',env,now,{fetch:next.fetch})).status,'partial');assert.equal((await mod.syncMail(db,'owner',env,now,{fetch:next.fetch})).status,'ready');assert.equal((await listUnifiedInbox(db,'owner')).messages.length,3);
 const actual=next.calls.filter(x=>new URL(x.url).pathname.endsWith('/messages')).map(x=>new URL(x.url).searchParams.get('pageToken'));assert.deepEqual(actual,['cursor-2','cursor-3']);
 }finally{db.close();}
});
test('mailbox change never reuses old cursor; mismatch does not import or advance either account',async()=>{
 const db=await setup();try{
 await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{messages:[],nextPageToken:'owner-one-cursor'}]}).fetch});
 const secondEnv={...env,GMAIL_MAILBOX:'second@example.test'};const wrong=server();assert.equal((await mod.syncMail(db,'owner',secondEnv,now,{fetch:wrong.fetch})).error_code,'account_mismatch');assert.equal(wrong.calls.length,1);
 const second=server({profile:'second@example.test',pages:[{messages:[{id:'aaa'}]}]});await mod.syncMail(db,'owner',secondEnv,now,{fetch:second.fetch});assert.equal(second.calls.some(x=>new URL(x.url).searchParams.has('pageToken')),false);assert.equal((await listUnifiedInbox(db,'owner')).messages[0].mailbox,'second@example.test');
 const returning=server({pages:[{}]});await mod.syncMail(db,'owner',env,now,{fetch:returning.fetch});assert.equal(returning.calls.some(x=>new URL(x.url).searchParams.has('pageToken')),false);
 }finally{db.close();}
});
test('multipart ignores HTML and attachments, and long auth mail is rejected before any truncation',async()=>{
 const db=await setup();try{
 const multi=message('aaa');const plain=multi.payload;multi.payload={mimeType:'multipart/mixed',headers:plain.headers,parts:[{mimeType:'text/html',body:{data:Buffer.from('<b>private HTML</b>').toString('base64url'),size:19}},plain,{mimeType:'text/plain',filename:'auth.txt',body:{attachmentId:'not-fetched',size:10}}]};
 const unsafe=message('aab','x'.repeat(11900)+' Your verification code is 123456');
 const result=await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{messages:[{id:'aaa'},{id:'aab'}]}],messages:{aaa:multi,aab:unsafe}}).fetch});assert.equal(result.imported,1);assert.equal(result.skipped,1);const saved=(await listUnifiedInbox(db,'owner')).messages;assert.equal(saved.length,1);assert.equal(saved[0].plain_text,'Project notification');assert.equal(result.skip_reasons.mail_auth_content,1);
 }finally{db.close();}
});

test('quoted search phrases cannot hide the required positive Gmail time bound',async()=>{
 const db=await setup();try{
 for(const query of ['subject:"all newer_than:30d from:anything"','from:notify@example.test "newer_than:30d"','from:notify@example.test newer_than:30d | in:anywhere']){
 let calls=0;const result=await mod.syncMail(db,'owner',{...env,GMAIL_NOTIFICATION_QUERY:query},now,{fetch:async()=>{calls++;return json({});}});assert.equal(result.status,'configuration_required');assert.equal(calls,0);
 }
 }finally{db.close();}
});

test('numeric Retry-After blocks repeated owner syncs until the provider-completion deadline',async()=>{
 const db=await setup();try{
 let instant=now;const end='2026-11-03T12:00:05.000Z';const limited=await mod.syncMail(db,'owner',env,()=>instant,{fetch:async()=>{instant=end;return new Response('private',{status:429,headers:{'Retry-After':'120'}});}});assert.equal(limited.error_code,'rate_limited');
 let requests=0;const provider=server({pages:[{}]});const fetch=async(...args)=>{requests++;return provider.fetch(...args);};
 const blocked=await mod.syncMail(db,'owner',env,'2026-11-03T12:02:04.999Z',{fetch});assert.equal(blocked.error_code,'rate_limited');assert.equal(blocked.last_attempt,now);assert.equal(requests,0);
 assert.equal((await mod.syncMail(db,'other',env,'2026-11-03T12:01:00.000Z',{fetch})).status,'ready');assert.equal(requests,2);
 assert.equal((await mod.syncMail(db,'owner',env,'2026-11-03T12:02:05.000Z',{fetch})).status,'ready');assert.equal(requests,4);
 }finally{db.close();}
});
test('proven bad saved cursor resets only that owner and next explicit sync starts fresh',async()=>{
 const db=await setup();try{
 const before=await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{messages:[{id:'aaa'}],nextPageToken:'bad-page'}]}).fetch});assert.equal(before.status,'partial');
 await mod.syncMail(db,'other',env,now,{fetch:server({pages:[{messages:[],nextPageToken:'other-page'}]}).fetch});
 const failed=await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{error:{code:400,message:'Invalid pageToken',errors:[{reason:'invalidArgument'}]}}],listStatus:400}).fetch});assert.equal(failed.status,'resync_required');assert.equal(failed.has_more,false);assert.equal(failed.initial_catchup_complete,false);
 assert.equal((await db.prepare('SELECT page_cursor FROM inbox_sync_state WHERE owner_id=?').bind('other').first()).page_cursor,'other-page');assert.equal((await listUnifiedInbox(db,'owner')).messages.length,1);
 const retry=server({pages:[{}]});assert.equal((await mod.syncMail(db,'owner',env,now,{fetch:retry.fetch})).status,'ready');assert.equal(retry.calls.some(c=>new URL(c.url).searchParams.has('pageToken')),false);
 }finally{db.close();}
});
test('400 without saved cursor is a configuration error and transient cursor errors do not reset it',async()=>{
 const db=await setup();try{
 const badQuery=await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{error:'private'}],listStatus:400}).fetch});assert.equal(badQuery.status,'configuration_required');assert.equal(badQuery.error_code,'configuration_error');
 await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{messages:[],nextPageToken:'kept-page'}]}).fetch});
 for(const failing of [async()=>json({error:{message:'Invalid query'}},400),async()=>json({error:'private'},503),async()=>{throw new DOMException('private','TimeoutError');}]){
 const profile=server();await mod.syncMail(db,'owner',env,now,{fetch:(url,init)=>String(url).includes('/profile')?profile.fetch(url,init):failing()});assert.equal((await db.prepare('SELECT page_cursor FROM inbox_sync_state WHERE owner_id=?').bind('owner').first()).page_cursor,'kept-page');
 }
 }finally{db.close();}
});
test('last_success tracks completed scan and historical new mail has no latency sample',async()=>{
 const db=await setup();try{
 const partial=await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{messages:[],nextPageToken:'initial-page'}]}).fetch});assert.equal(partial.last_success,null);
 await mod.syncMail(db,'owner',env,now,{fetch:server({pages:[{}]}).fetch});
 const recent=message('aab');recent.internalDate=String(Date.parse('2026-11-03T12:00:30.000Z'));
 const current='2026-11-03T12:01:00.000Z';const page=await mod.syncMail(db,'owner',env,current,{fetch:server({pages:[{messages:[{id:'aaa'},{id:'aab'}],nextPageToken:'remaining'}],messages:{aaa:message('aaa'),aab:recent}}).fetch});assert.equal(page.last_success,now);assert.equal(page.status,'partial');
 const saved=(await listUnifiedInbox(db,'owner')).messages;assert.equal(saved.find(x=>x.message_id==='aaa').receipt_to_storage_ms,null);assert.equal(saved.find(x=>x.message_id==='aab').receipt_to_storage_ms,30000);
 const complete=await mod.syncMail(db,'owner',env,'2026-11-03T12:02:00.000Z',{fetch:server({pages:[{}]}).fetch});assert.equal(complete.last_success,'2026-11-03T12:02:00.000Z');
 }finally{db.close();}
});


test('legacy excerpt conflict is visible omitted data without blocking later Gmail messages or changing original bytes',async()=>{
 const db=await setup();try{
  await recordMail(db,'owner',{mailbox:env.GMAIL_MAILBOX,message_id:'abc',thread_id:'def',received_at:'2026-11-03T11:59:00.000Z',observed_at:now,sender:'Client <client@example.test>',subject:'Project reply',plain_text:'A relevant excerpt previously observed by the agent',reference:null},now);
  await db.prepare('UPDATE mail_notifications SET panel_viewed_at=? WHERE owner_id=?').bind(now,'owner').run();const original=await db.prepare('SELECT * FROM mail_notifications WHERE owner_id=? AND message_id=?').bind('owner','abc').first();
  const provider=server({pages:[{messages:[{id:'abc'},{id:'abd'}]}]});const result=await mod.syncMail(db,'owner',env,now,{fetch:provider.fetch});
  assert.equal(result.status,'ready');assert.equal(result.imported,1);assert.equal(result.skipped,1);assert.equal(result.skip_reasons.mail_conflict,1);
  assert.ok(provider.calls.some(c=>new URL(c.url).pathname.endsWith('/messages/abd')));
  assert.deepEqual(await db.prepare('SELECT * FROM mail_notifications WHERE owner_id=? AND message_id=?').bind('owner','abc').first(),original);
  const messages=(await listUnifiedInbox(db,'owner')).messages;assert.equal(messages.length,2);assert.equal(messages.find(m=>m.message_id==='abc').provenance,'caller_observed');assert.equal(messages.find(m=>m.message_id==='abd').provenance,'provider_verified');
 }finally{db.close();}
});
