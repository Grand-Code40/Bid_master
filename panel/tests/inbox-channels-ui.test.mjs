import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,existsSync} from 'node:fs';
const file=new URL('../web/inbox-channels.js',import.meta.url),flush=()=>new Promise(r=>setImmediate(r));
function setup(){
 assert.equal(existsSync(file),true,'live Inbox channel UI is missing');const nodes=new Map(),pending=[],timers=[];
 class Element{constructor(tag='div'){this.tagName=tag;this.children=[];}append(...xs){this.children.push(...xs);}replaceChildren(...xs){this.children=xs;}set innerHTML(_){throw Error('HTML sink forbidden');}}
 const $=id=>nodes.get(id)||nodes.set(id,new Element()).get(id);
 const document={getElementById:$,createElement:t=>new Element(t),hidden:false,dispatchEvent(){}};
 vm.runInContext(readFileSync(file,'utf8'),vm.createContext({document,Date,JSON,Math,fetch:(url,options)=>new Promise(resolve=>pending.push({url,options,resolve})),setInterval:fn=>timers.push(fn)}));return {$,pending,timers};
}
const channel=status=>({channel:'gmail',status,mode:'manual_sync',coverage:'partial_notifications_only',last_success:null,skipped:0});
const reply=(r,data)=>r.resolve({ok:true,json:async()=>data});
test('unconfigured channels disable upstream sync and refreshing status never polls Gmail',async()=>{
 const x=setup();assert.equal(x.pending[0].url,'/api/inbox/channels');reply(x.pending[0],{channels:[channel('not_configured'),{channel:'weblancer',status:'paused'}]});await flush();
 assert.equal(x.$('inbox-sync-gmail').disabled,true);x.timers[0]();assert.equal(x.pending[1].url,'/api/inbox/channels');assert.equal(x.pending.some(r=>r.options?.method==='POST'),false);
});
test('only explicit click syncs a configured Gmail channel; failures retain independent channel status',async()=>{
 const x=setup();reply(x.pending[0],{channels:[channel('not_checked'),{channel:'fl',status:'caller_observed_only'},{channel:'weblancer',status:'paused'}]});await flush();
 assert.equal(x.$('inbox-sync-gmail').disabled,false);const work=x.$('inbox-sync-gmail').onclick();assert.equal(x.pending[1].url,'/api/inbox/sync');assert.equal(JSON.parse(x.pending[1].options.body).channel,'gmail');assert.equal(x.$('inbox-sync-gmail').disabled,true);
 x.pending[1].resolve({ok:false,status:503,json:async()=>({error:'storage_unavailable'})});await work;assert.match(x.$('inbox-sync-status').textContent,/Не удалось/);assert.equal(x.$('inbox-channels').children.length,3);
});
