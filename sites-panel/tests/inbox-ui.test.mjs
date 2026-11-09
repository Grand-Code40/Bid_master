import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,existsSync} from 'node:fs';
const file=new URL('../web/inbox.js',import.meta.url);
function setup(){
 const nodes=new Map(),pending=[],timers=[],listeners={};class Element{constructor(tag){this.tagName=tag;this.children=[];this.hidden=false;}append(...xs){this.children.push(...xs);}replaceChildren(...xs){this.children=xs;}set innerHTML(_){throw Error('HTML sink forbidden');}setAttribute(k,v){this[k]=v;}scrollIntoView(){this.scrolled=true;}focus(){this.focused=true;}}
 const $=id=>nodes.get(id)||nodes.set(id,new Element('div')).get(id);
 const document={getElementById:$,createElement:t=>new Element(t),hidden:false,addEventListener:(name,fn)=>listeners[name]=fn};
 const context=vm.createContext({document,URLSearchParams,Date,JSON,fetch:(url,options)=>new Promise(resolve=>pending.push({url,options,resolve})),setInterval:fn=>timers.push(fn)});
 vm.runInContext(readFileSync(file,'utf8'),context);
 return {$,pending,timers,context,listeners,document};
}
const flush=()=>new Promise(r=>setImmediate(r));
const malicious={mailbox:'test@example.test',message_id:'abcd',subject:'<img src=https://evil.test onerror=alert(1)>',sender:'<script>alert(1)</script>',plain_text:'<iframe src=https://evil.test>hello</iframe>',received_at:'2026-11-01T00:00:00.000Z',link_status:'unlinked',panel_viewed_at:null};
test('inbox client exists as independent safe renderer',()=>assert.equal(existsSync(file),true));
test('untrusted notification is rendered as text only and mark-viewed requires an explicit click',async()=>{
 const x=setup();assert.equal(x.pending[0].url,'/api/inbox');x.pending[0].resolve({ok:true,json:async()=>({messages:[malicious],next_cursor:null})});await flush();
 const tree=[];function walk(n){tree.push(n);for(const c of n.children??[])walk(c);}walk(x.$('inbox-unlinked'));
 assert.ok(tree.some(n=>n.textContent===malicious.subject));assert.ok(tree.some(n=>n.textContent===malicious.plain_text));assert.equal(tree.some(n=>['img','iframe','script'].includes(n.tagName)),false);assert.equal(x.pending.length,1);
 const button=tree.find(n=>n.tagName==='button');const work=button.onclick();assert.equal(x.pending[1].url,'/api/inbox/viewed');assert.equal(button.disabled,true);
 x.pending[1].resolve({ok:true,json:async()=>({panel_viewed:true})});await work;
 assert.equal(x.pending.length,2);
});
test('polling does not overlap and failures retain content with a visible error',async()=>{
 const x=setup();x.timers[0]();assert.equal(x.pending.length,1);x.pending[0].resolve({ok:true,json:async()=>({messages:[malicious],next_cursor:null})});await flush();
 x.timers[0]();x.pending[1].resolve({ok:false,json:async()=>({error:'storage_unavailable'})});await flush();assert.match(x.$('inbox-status').textContent,/Не удалось/);assert.ok(x.$('inbox-unlinked').children.length);
});
const reply=(request,messages,next_cursor=null)=>request.resolve({ok:true,json:async()=>({messages,next_cursor})});
test('unchanged polling preserves card identity, open text and scroll position',async()=>{
 const x=setup();reply(x.pending[0],[malicious]);await flush();const card=x.$('inbox-unlinked').children[0],details=card.children.find(n=>n.tagName==='details'),body=details.children.find(n=>n.tagName==='pre');details.open=true;body.scrollTop=100;
 x.timers[0]();reply(x.pending[1],[malicious]);await flush();assert.equal(x.$('inbox-unlinked').children[0],card);assert.equal(details.open,true);assert.equal(body.scrollTop,100);
});
test('stale poll cannot undo viewed status or enable a pending duplicate click',async()=>{
 const x=setup();reply(x.pending[0],[malicious]);await flush();const card=x.$('inbox-unlinked').children[0],button=card.children.find(n=>n.tagName==='button');const marked=button.onclick();
 x.timers[0]();reply(x.pending[2],[malicious]);await flush();assert.equal(x.$('inbox-unlinked').children[0],card);assert.equal(button.disabled,true);await button.onclick();assert.equal(x.pending.length,3);
 x.pending[1].resolve({ok:true});await marked;x.timers[0]();reply(x.pending[3],[malicious]);await flush();assert.equal(button.disabled,true);assert.equal(button.textContent,'Просмотрено в панели');
});
test('new first-page overflow resets older cursor with an explicit gap notice and retains opened cards',async()=>{
 const x=setup(),mail=n=>({...malicious,message_id:n.toString(16),subject:'message '+n}),batch=(start,count)=>Array.from({length:count},(_,i)=>mail(start-i));
 reply(x.pending[0],batch(200,100),'cursor-101');await flush();x.$('inbox-more').onclick();reply(x.pending[1],batch(100,100),null);await flush();
 const old=x.$('inbox-unlinked').children[0],details=old.children.find(n=>n.tagName==='details');details.open=true;
 // 150 incoming messages: page 1 contains 350..251, leaving 250..201 unseen.
 x.timers[0]();reply(x.pending[2],batch(350,100),'cursor-251');await flush();assert.equal(details.open,true);assert.equal(x.$('inbox-more').hidden,false);assert.match(x.$('inbox-status').textContent,/новые|Новые/);
 x.$('inbox-more').onclick();assert.match(x.pending[3].url,/cursor-251/);reply(x.pending[3],batch(250,100),'cursor-151');await flush();assert.equal(x.$('inbox-count').textContent,'350');
 x.timers[0]();reply(x.pending[4],batch(350,100),'cursor-251');await flush();x.$('inbox-more').onclick();assert.match(x.pending[5].url,/cursor-151/);
 reply(x.pending[5],batch(150,100),'cursor-51');await flush();
});
test('older server snapshots cannot clear a previously observed viewed timestamp',async()=>{
 const x=setup();reply(x.pending[0],[{...malicious,panel_viewed_at:'2026-11-01T01:00:00.000Z'}]);await flush();const button=x.$('inbox-unlinked').children[0].children.find(n=>n.tagName==='button');
 x.timers[0]();reply(x.pending[1],[malicious]);await flush();assert.equal(button.disabled,true);assert.equal(button.textContent,'Просмотрено в панели');
});

test('header inbox button opens the panel, focuses it and does not mark mail viewed',async()=>{
 const x=setup();reply(x.pending[0],[malicious]);await flush();
 assert.equal(typeof x.$('inbox-open').onclick,'function');
 x.$('inbox-open').onclick();assert.equal(x.$('inbox-panel').open,true);assert.equal(x.$('inbox-panel').focused,true);
 assert.equal(x.pending.filter(p=>p.options?.method==='POST').length,0);
 x.$('inbox-panel').open=false;x.$('inbox-panel').ontoggle();assert.equal(x.$('inbox-open')['aria-expanded'],'false');
});
test('unviewed badge describes only loaded records and updates after local view',async()=>{
 const x=setup();reply(x.pending[0],[malicious],'older');await flush();assert.equal(x.$('inbox-unviewed').textContent,'1 непросмотрено среди загруженных');
 const button=x.$('inbox-unlinked').children[0].children.find(n=>n.tagName==='button');const work=button.onclick();x.pending[1].resolve({ok:true});await work;
 assert.equal(x.$('inbox-unviewed').textContent,'0 непросмотрено среди загруженных');
});
test('returning to a visible tab refreshes saved data without overlapping requests',async()=>{
 const x=setup();assert.equal(typeof x.listeners.visibilitychange,'function');x.listeners.visibilitychange();assert.equal(x.pending.length,1);
 reply(x.pending[0],[]);await flush();x.document.hidden=true;x.listeners.visibilitychange();assert.equal(x.pending.length,1);
 x.document.hidden=false;x.listeners.visibilitychange();assert.equal(x.pending.length,2);
});
test('card distinguishes reception and persistence timestamps without inferring sync health',async()=>{
 const x=setup();reply(x.pending[0],[{...malicious,recorded_at:'2026-11-01T01:00:00.000Z'}]);await flush();
 const texts=x.$('inbox-unlinked').children[0].children.map(c=>c.textContent).join(' ');
 assert.match(texts,/Получено:/);assert.match(texts,/Сохранено в панели: 2026-11-01T01:00:00.000Z/);
});
test('notification is not labelled as full conversation and only a strict observed link is navigable',async()=>{
 const x=setup(),url='https://vmasshtabe.ru/account/view-task?id=1&response_id=2';reply(x.pending[0],[{...malicious,conversation_url:url}]);await flush();const card=x.$('inbox-unlinked').children[0],tree=[];const walk=n=>{tree.push(n);for(const c of n.children??[])walk(c);};walk(card);
 assert.ok(tree.some(n=>n.textContent==='Показать текст уведомления'));assert.ok(tree.some(n=>/не полная синхронизация переписки/.test(n.textContent??'')));
 const link=tree.find(n=>n.tagName==='a');assert.equal(link.href,url);assert.equal(link.target,'_blank');assert.match(link.rel,/noreferrer/);assert.equal(x.pending.length,1);
});
test('link enrichment updates an open card without losing text selection, and rejects cached unsafe links',async()=>{
 const x=setup();reply(x.pending[0],[malicious]);await flush();const card=x.$('inbox-unlinked').children[0],details=card.children.find(n=>n.tagName==='details');details.open=true;
 x.timers[0]();reply(x.pending[1],[{...malicious,conversation_url:'https://vmasshtabe.ru/account/view-task?id=1&response_id=2&token=secret'}]);await flush();
 const links=()=>card.children.flatMap(n=>n.children??[]).filter(n=>n.tagName==='a');assert.equal(links().length,0);
 x.timers[0]();reply(x.pending[2],[{...malicious,conversation_url:'https://vmasshtabe.ru/account/view-task?id=1&response_id=2'}]);await flush();assert.equal(x.$('inbox-unlinked').children[0],card);assert.equal(details.open,true);assert.equal(links().length,1);
});
