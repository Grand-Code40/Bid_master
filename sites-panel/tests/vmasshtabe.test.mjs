import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalUrl} from '../src/ingest.mjs';
import {handleMcp} from '../src/mcp.mjs';
import {handleApi} from '../src/api.mjs';
import {fixture} from './d1-fixture.mjs';
const owner={'oai-authenticated-user-id':'owner'};
const id='sdelat-chertezh-s-foto';
const observation={source_id:'vmasshtabe',external_id:id,canonical_url:'https://vmasshtabe.ru/task/'+id,title:'Isolated fixture, not a real import',observed_at:'2026-11-01T00:00:00Z',listing_kind:'order',availability:'unknown'};
const rpc=(method,params={})=>new Request('https://site.example/mcp',{method:'POST',headers:{...owner,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
test('vmasshtabe slug identity strips tracking and optional trailing slash',()=>{
 for(const suffix of ['', '/', '?utm_source=test#comment', '/?utm_source=test'])assert.equal(canonicalUrl('vmasshtabe',id,observation.canonical_url+suffix),observation.canonical_url);
});
test('vmasshtabe fails closed on host, route, identifier and protocol confusion',()=>{
 for(const url of ['https://vmasshtabe.ru.evil.test/task/'+id,'https://www.vmasshtabe.ru/task/'+id,'https://user@vmasshtabe.ru/task/'+id,'http://vmasshtabe.ru/task/'+id,'https://vmasshtabe.ru:444/task/'+id,'https://vmasshtabe.ru/task/another','https://vmasshtabe.ru/task/%73delat-chertezh-s-foto','https://vmasshtabe.ru/task/'+id+'/comments','https://vmasshtabe.ru/task/'+id+'//','https://vmasshtabe.ru/account','https://vmasshtabe.ru/task/'+id+'/../'+id,'https://vmasshtabe.ru/task/'+id+'/%2e%2e/'+id])assert.throws(()=>canonicalUrl('vmasshtabe',id,url),/invalid_observation/,url);
 for(const badId of ['','../'+id,id.toUpperCase(),'a'.repeat(129)])assert.throws(()=>canonicalUrl('vmasshtabe',badId,'https://vmasshtabe.ru/task/'+badId),/invalid_observation/);
});
test('vmasshtabe is discoverable and owner-scoped import/draft/readback preserves existing records',async()=>{
 const db=fixture(),env={DB:db,OWNER_USER_ID:'owner'};
 const call=async(name,args)=>{const body=await(await handleMcp(rpc('tools/call',{name,arguments:args}),env)).json();assert.equal(body.result.isError,undefined,JSON.stringify(body));return JSON.parse(body.result.content[0].text);};
 try{
  const discovery=await(await handleMcp(rpc('tools/list'),env)).json();
  for(const tool of discovery.result.tools.filter(t=>!['bid_scan_coverage','bid_read_mail','bid_link_mail_conversation'].includes(t.name))){const p=tool.inputSchema.properties;assert.ok((p.source_id??p.observations?.items.properties.source_id??p.reference.anyOf[1].properties.source_id).enum.includes('vmasshtabe'));}
  await call('bid_ingest',{observations:[{...observation,source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html',title:'Existing fixture'}]});
  assert.equal((await call('bid_ingest',{observations:[observation]})).written,1);
  assert.equal((await call('bid_draft',{source_id:'vmasshtabe',external_id:id,operation_id:'vm-test'})).state,'draft');
  assert.equal((await call('bid_readback',{source_id:'vmasshtabe',external_id:id})).listings[0].canonical_url,observation.canonical_url);
  const state=await(await handleApi(new Request('https://site.example/api/state',{headers:owner}),env)).json();
  assert.equal(state.listings.length,2);assert.equal(state.listings.find(x=>x.source_id==='fl').title,'Existing fixture');
  const source=state.sources.find(x=>x.id==='vmasshtabe');assert.equal(source.name,'В Масштабе');assert.equal(source.code,'agent_observed');assert.equal(source.implemented,false);
 }finally{db.close();}
});
