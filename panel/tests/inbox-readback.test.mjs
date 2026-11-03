import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {handleMcp} from '../src/mcp.mjs';
const now='2026-11-01T00:00:00.000Z';
async function rpc(db,args={},headers={},method='tools/call'){
 const response=await handleMcp(new Request('https://site.test/mcp',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'owner',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:method==='tools/call'?{name:'bid_read_mail',arguments:args}:{}})}),{DB:db,OWNER_USER_ID:'owner'});
 const body=await response.json();return {status:response.status,body,data:body.result?.content?JSON.parse(body.result.content[0].text):null};
}
async function seed(db,owner='owner',count=1){for(let n=1;n<=count;n++){
 const mail={mailbox:'owner@example.test',message_id:n.toString(16).padStart(4,'0'),thread_id:'abc',received_at:now,observed_at:now,sender:'client@example.test',subject:'Observed notification',plain_text:'Stored text '+n,reference:null};
 await db.prepare('INSERT INTO mail_notifications (owner_id,mailbox,message_id,received_at,recorded_at,data,link_status) VALUES (?,?,?,?,?,?,?)').bind(owner,mail.mailbox,mail.message_id,now,now,JSON.stringify(mail),'unlinked').run();
}}
test('MCP mail read exposes stored owner notifications without writing or marking viewed',async()=>{const db=fixture();try{
 await seed(db);await seed(db,'other');
 const before=await db.prepare('SELECT * FROM mail_notifications ORDER BY owner_id').all();
 // Real SQLite enforces a read-only connection for the operation under test.
 await db.prepare('PRAGMA query_only=ON').run();
 const result=await rpc(db);assert.equal(result.status,200);assert.equal(result.body.result.isError,undefined);
 assert.equal(result.data.messages.length,1);assert.equal(result.data.messages[0].plain_text,'Stored text 1');assert.equal(result.data.messages[0].kind,'email_notification');assert.equal(result.data.messages[0].panel_viewed_at,null);assert.equal(result.data.next_cursor,null);assert.equal(result.data.import_mode,'observed_notifications_only');
 assert.deepEqual(await db.prepare('SELECT * FROM mail_notifications ORDER BY owner_id').all(),before);
 }finally{db.close();}});
test('MCP mail cursor traverses all saved messages with tied timestamps without duplicates',async()=>{const db=fixture();try{
 await seed(db,'owner',102);await seed(db,'other',103);
 const first=(await rpc(db)).data;assert.equal(first.messages?.length,100);assert.ok(first.next_cursor);
 const second=(await rpc(db,{cursor:first.next_cursor})).data;assert.equal(second.messages.length,2);assert.equal(second.next_cursor,null);
 assert.equal(new Set([...first.messages,...second.messages].map(x=>x.message_id)).size,102);
 assert.equal(first.messages[0].message_id,'0066');assert.equal(second.messages.at(-1).message_id,'0001');
 }finally{db.close();}});
test('MCP mail read validates arguments and rejects owner overrides and malformed cursors',async()=>{const db=fixture();try{
 for(const args of [{owner_id:'other'},{mailbox:'other@example.test'},{limit:1000},[],{cursor:5},{cursor:false},{cursor:''},{cursor:'{}'},{cursor:'null'},{cursor:'x'.repeat(1025)},{cursor:JSON.stringify({received_at:now,mailbox:'owner@example.test',message_id:'01',owner_id:'other'})}]){
 const result=await rpc(db,args);assert.ok(['invalid_arguments','invalid_mail'].includes(result.data?.error),JSON.stringify(args));
 }
 assert.deepEqual((await rpc(db)).data.messages,[]);assert.deepEqual((await rpc(db,{cursor:null})).data.messages,[]);
 }finally{db.close();}});
test('MCP mail read rejects non-owner, missing identity, writer-only and foreign-origin callers',async()=>{const db=fixture();try{
 await seed(db);
 for(const [headers,status] of [[{'oai-authenticated-user-id':'other'},403],[{'oai-authenticated-user-id':''},401],[{'oai-authenticated-user-id':'','X-Bid-Writer-Token':'x'.repeat(32)},401],[{Origin:'https://evil.test'},403]]){
 const result=await rpc(db,{},headers);assert.equal(result.status,status);assert.equal(JSON.stringify(result).includes('Stored text 1'),false);
 }
 }finally{db.close();}});
test('MCP advertises mail read as read-only with bounded optional cursor',async()=>{const db=fixture();try{
 const result=await rpc(db,{}, {},'tools/list');const tool=result.body.result.tools.find(x=>x.name==='bid_read_mail');assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.inputSchema.properties.cursor.maxLength,1024);
 }finally{db.close();}});
