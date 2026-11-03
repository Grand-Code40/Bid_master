import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './d1-fixture.mjs';
import {handleApi} from '../src/api.mjs';
import {handleMcp} from '../src/mcp.mjs';
const origin='https://private.example.test',identity={source_id:'fl',external_id:'42',revision:1};
const req=(path,body,headers={})=>new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':'owner',...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function setup(){
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner',WRITER_TOKEN:'synthetic-writer-token-with-32-characters',SENDER_ENABLED:'true',SENDER_TRANSPORT_ID:'synthetic-v1'};
 let submits=0;
 env.SENDER_SERVICE={async fetch(request){const body=await request.json(),path=new URL(request.url).pathname;
 if(path==='/inspect')return Response.json({version:1,transport_id:'synthetic-v1',details:body.snapshot,authenticated:true,availability:'open',already_sent:false,form_supported:true,idempotency_supported:true,verified_at:new Date().toISOString()});
 if(path==='/submit'){submits++;return Response.json({version:1,status:'accepted'});}
 if(path==='/readback')return Response.json({version:1,transport_id:'synthetic-v1',status:'published',details:body.snapshot,response_id:'synthetic-response',delivery_url:body.snapshot.canonical_url,observed_at:new Date().toISOString()});
 throw Error('Unexpected path');}};
 const item={source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html',title:'Synthetic',listing_kind:'order',availability:'open'};
 await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,1)').bind('owner','fl','42',JSON.stringify(item),'{}','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z').run();
 const p=await handleApi(req('/api/review/prepare',{source_id:'fl',external_id:'42',operation_id:'prepare'}),env),review=await p.json();
 await handleApi(req('/api/review/approve',{...identity,operation_id:'approve'}),env);
 const details={...identity,canonical_url:item.canonical_url,text:review.text,sender_account:'owner-account',recipient_account:'customer-account',price:null,currency:null,deadline:null,credit_cost:0};
 await handleApi(req('/api/review/confirm_delivery',{...identity,operation_id:'confirm',details}),env);
 return {db,env,get submits(){return submits;}};
}

test('owner preflight/send routes deliver exact approved snapshot and remain protected from writer/origin escalation',async()=>{
 const s=await setup();try{
  const status=await handleApi(req('/api/sender/status'),s.env);assert.equal(status.status,200);assert.equal((await status.json()).configured,true);assert.equal(s.submits,0);
  const response=await handleApi(req('/api/review/preflight',identity),s.env);assert.equal(response.status,200);const p=await response.json();
  const args={...identity,operation_id:'send',preflight_id:p.preflight_id,confirmation_digest:p.confirmation_digest};
  assert.equal((await handleApi(req('/api/review/send',args,{Origin:'https://other.example.test'}),s.env)).status,403);
  assert.equal((await handleApi(req('/api/review/send',args,{'oai-authenticated-user-id':'other'}),s.env)).status,403);
  const writer=new Request(origin+'/api/review/send',{method:'POST',headers:{'Content-Type':'application/json','X-Bid-Writer-Token':s.env.WRITER_TOKEN},body:JSON.stringify(args)});
  assert.equal((await handleApi(writer,s.env)).status,401);
  const sent=await handleApi(req('/api/review/send',args),s.env);assert.equal(sent.status,200);assert.equal((await sent.json()).review.state,'sent');
  assert.equal((await handleApi(req('/api/review/send',args),s.env)).status,200);assert.equal(s.submits,1);
 }finally{s.db.close();}
});

test('unified Inbox and safe channel status distinguish observations without exposing provider secrets',async()=>{
 const s=await setup();try{
  const channel=await handleApi(req('/api/inbox/channels'),s.env);assert.equal(channel.status,200);const channels=await channel.json();
  assert.equal(channels.channels.find(x=>x.channel==='gmail').status,'not_configured');assert.equal(channels.channels.find(x=>x.channel==='weblancer').status,'paused');
  const args={source_id:'fl',account_id:'owner-account',message_id:'m1',thread_id:'t1',received_at:'2026-11-01T00:00:00.000Z',observed_at:'2026-11-01T00:01:00.000Z',sender:'Synthetic customer',plain_text:'Please clarify DXF layers.',reference:{source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html'}};
  assert.equal((await handleApi(req('/api/inbox/platform-message',args),s.env)).status,200);
  const inbox=await handleApi(req('/api/inbox/unified'),s.env);assert.equal(inbox.status,200);const list=await inbox.json();assert.equal(list.messages[0].kind,'platform_message');assert.equal(list.messages[0].provenance,'caller_observed');
  assert.equal((await handleApi(req('/api/inbox/message-viewed',{message_key:list.messages[0].message_key}),s.env)).status,200);
  assert.equal((await handleApi(req('/api/inbox/sync',{channel:'gmail'}),s.env)).status,200);
  assert.equal((await handleApi(req('/api/inbox/sync',{channel:'weblancer'}),s.env)).status,409);
  assert.equal((await handleApi(req('/api/inbox/sync',{channel:'gmail',GMAIL_ACCESS_TOKEN:'forged'}),s.env)).status,400);
  assert.equal((await handleApi(req('/api/inbox/unified?cursor=one&cursor=two'),s.env)).status,400);
 }finally{s.db.close();}
});

test('MCP records and reads observed platform messages but exposes no send or approval tool',async()=>{
 const s=await setup();try{
  const rpc=async(method,params)=>handleMcp(req('/mcp',{jsonrpc:'2.0',id:1,method,...(params?{params}:{})}),s.env);
  const tools=(await(await rpc('tools/list')).json()).result.tools;
  assert.ok(tools.some(x=>x.name==='bid_record_platform_message'));assert.ok(tools.some(x=>x.name==='bid_read_inbox'));assert.equal(tools.some(x=>/approve|claim|bid_send$/.test(x.name)),false);
  const args={source_id:'fl',account_id:'owner-account',message_id:'m1',thread_id:'t1',received_at:'2026-11-01T00:00:00.000Z',observed_at:'2026-11-01T00:01:00.000Z',sender:'Synthetic customer',plain_text:'Please clarify DXF layers.',reference:{source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html'}};
  const recorded=await(await rpc('tools/call',{name:'bid_record_platform_message',arguments:args})).json();assert.equal(recorded.result.isError,undefined);
  const read=await(await rpc('tools/call',{name:'bid_read_inbox',arguments:{}})).json(),data=JSON.parse(read.result.content[0].text);assert.equal(data.messages.length,1);assert.equal(data.messages[0].provenance,'caller_observed');
 }finally{s.db.close();}
});
