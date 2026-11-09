import test from 'node:test';
import assert from 'node:assert/strict';
import {handleApi} from '../src/api.mjs';
import {handleMcp} from '../src/mcp.mjs';
import {validateObservations,canonicalUrl} from '../src/ingest.mjs';
import {fixture} from './d1-fixture.mjs';
const now='2026-11-02T12:00:00Z';
const item={source_id:'vmasshtabe',external_id:'test',canonical_url:'https://vmasshtabe.ru/task/test',title:'Synthetic only',observed_at:now};
test('registry separates candidate sources from manual import and excluded sources',async()=>{
 const db=fixture();try{const env={DB:db,OWNER_USER_ID:'owner'};
 const state=await(await handleApi(new Request('https://site.example/api/state',{headers:{'oai-authenticated-user-id':'owner'}}),env)).json();
 for(const id of ['profi','youdo']){const source=state.sources.find(x=>x.id===id);assert.ok(source,id);assert.equal(source.import_enabled,false);assert.equal(source.state,'candidate');}
 for(const id of ['kwork','freelancer','freelancehunt'])assert.equal(state.sources.some(x=>x.id===id),false);
 const vm=state.sources.find(x=>x.id==='vmasshtabe');assert.equal(vm.automation,'prohibited');assert.equal(vm.import_mode,'single_observation');
 const req=new Request('https://site.example/mcp',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'owner'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
 const tools=(await(await handleMcp(req,env)).json()).result.tools;
 const ingest=tools.find(t=>t.name==='bid_ingest').inputSchema.properties.observations.items.properties.source_id.enum;
 assert.equal(ingest.includes('kwork'),false);assert.equal(ingest.includes('weblancer'),true);
 assert.equal(tools.find(t=>t.name==='bid_readback').inputSchema.properties.source_id.enum.includes('kwork'),true);
 }finally{db.close();}
});
test('excluded imports reject and vmasshtabe is limited to single observation',()=>{
 assert.throws(()=>validateObservations([{...item,source_id:'kwork',external_id:'5',canonical_url:'https://kwork.ru/projects?id=5'}],now),/invalid_observation/);
 assert.throws(()=>validateObservations([item,item],now),/invalid_observation/);
 assert.equal(validateObservations([item],now).length,1);
});
test('all sources reject normalized dot segments before canonicalization',()=>{
 for(const path of ['/a/../projects/42/test.html','/%2e%2e/projects/42/test.html'])assert.throws(()=>canonicalUrl('fl','42','https://www.fl.ru'+path),/invalid_observation/);
 assert.throws(()=>canonicalUrl('telegram','test/5','https://t.me/wrong/../test/5'),/invalid_observation/);
});

test('confirmed observed routes bind canonical identity without enabling automation',()=>{
 for(const [source,id,url] of [['weblancer','1270205','https://www.weblancer.net/freelance/chertezhi-i-skhemi-78/proektirovanie-printsipialnoi-skhemi-1270205/'],['3ddd','12719','https://3ddd.ru/work/task_show/12719'],['dwg','43114','https://dwg.ru/board/43114'],['enginer','razrabotka-himstojkogo-ventilyatora-i-filtra-vfg-v-kompas-3d','https://enginer.ru/request/razrabotka-himstojkogo-ventilyatora-i-filtra-vfg-v-kompas-3d/']]) {
  assert.ok(canonicalUrl(source,id,url).startsWith('https://'));
  assert.throws(()=>canonicalUrl(source,'different',url),/invalid_observation/);
  assert.throws(()=>canonicalUrl(source,id,url.replace(new URL(url).hostname,new URL(url).hostname+'.evil.test')),/invalid_observation/);
 }
});
test('legacy records remain readable while new imports are blocked; owner isolation unchanged',async()=>{
 const db=fixture();try{
 const old={...item,source_id:'kwork',external_id:'5',canonical_url:'https://kwork.ru/projects?id=5'};
 await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,1)').bind('owner','kwork','5',JSON.stringify(old),'{}',now,now).run();
 const env={DB:db,OWNER_USER_ID:'owner'};
 const request=identity=>new Request('https://site.example/mcp',{method:'POST',headers:{'Content-Type':'application/json',...(identity?{'oai-authenticated-user-id':identity}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bid_readback',arguments:{source_id:'kwork',external_id:'5'}}})});
 const response=await(await handleMcp(request('owner'),env)).json();assert.equal(JSON.parse(response.result.content[0].text).listings[0].source_id,'kwork');
 assert.equal((await handleMcp(request('other'),env)).status,403);assert.equal((await handleMcp(request(null),env)).status,401);
 assert.throws(()=>validateObservations([old],now),/invalid_observation/);
 const state=await(await handleApi(new Request('https://site.example/api/state',{headers:{'oai-authenticated-user-id':'owner'}}),env)).json();assert.equal(state.listings.length,0);assert.equal(state.sources.some(x=>x.id==='kwork'),false);
 }finally{db.close();}
});
test('verified public channels have separate evidence without changing telegram storage keys',async()=>{
 const {telegramChannels,publicSources}=await import('../src/sources.mjs');assert.equal(telegramChannels.length,12);
 const sources=publicSources([{source_id:'telegram',external_id:'cgfreelance/20742',last_seen:now}]);
 assert.equal(sources.find(x=>x.id==='telegram:cgfreelance').code,'agent_observed');
 assert.equal(sources.find(x=>x.id==='telegram:job_design').code,'not_scanned');
 for(const source of telegramChannels){assert.equal(source.rules_status,'unverified');assert.equal(source.automation,source.state==='candidate'?'prohibited':'unverified');assert.equal(new URL(source.evidence_url).hostname,'t.me');}
});
test('source lookup fails closed on inherited object keys',()=>{
 for(const source of ['constructor','__proto__','toString'])assert.throws(()=>canonicalUrl(source,'1','https://fl.ru/projects/1/test.html'),/invalid_observation/);
});
test('Enginer slug length matches the MCP exact identity limit of 128 characters',async()=>{
 const id='a'.repeat(128),long='a'.repeat(129),url='https://enginer.ru/request/'+id;
 assert.equal(canonicalUrl('enginer',id,url),url);
 for(const rejected of [long,'a'.repeat(256)])assert.throws(()=>validateObservations([{...item,source_id:'enginer',external_id:rejected,canonical_url:'https://enginer.ru/request/'+rejected}],now),/invalid_observation/);
 const db=fixture();try{
 const env={DB:db,OWNER_USER_ID:'owner'};
 const call=async(name,args)=>{const req=new Request('https://site.example/mcp',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'owner'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const body=await(await handleMcp(req,env)).json();assert.equal(body.result.isError,undefined,JSON.stringify(body));return JSON.parse(body.result.content[0].text);};
 assert.equal((await call('bid_ingest',{observations:[{...item,source_id:'enginer',external_id:id,canonical_url:url,listing_kind:'order',availability:'open',observed_at:'2026-11-01T00:00:00Z'}]})).written,1);
 assert.equal((await call('bid_readback',{source_id:'enginer',external_id:id})).listings[0].external_id,id);
 assert.equal((await call('bid_draft',{source_id:'enginer',external_id:id,operation_id:'enginer-boundary'})).state,'draft');
 }finally{db.close();}
});

test('every new import enforces the same 128-character identity boundary as MCP',()=>{const id='1'.repeat(129);assert.throws(()=>canonicalUrl('fl',id,'https://www.fl.ru/projects/'+id+'/test.html'),/invalid_observation/);});
