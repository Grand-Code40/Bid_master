// No server or database: execute reviewed cloud UI against a tiny synthetic DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
function setup(){
 const nodes=new Map(),pending=[];
 let active;
 class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.value='';this.hidden=false;this.dataset={};this.handlers={};this.className='';this.classList={add(){},remove(){},toggle(){}};}
  append(...x){this.children.push(...x);} replaceChildren(...x){this.children=x;}
  setAttribute(){} addEventListener(type,fn){this.handlers[type]=fn;} focus(){active=this;}
  showModal(){this.open=true;} close(){this.open=false;}
  getBoundingClientRect(){return {left:10,right:800,top:10,bottom:800};}
  querySelector(sel){return this.children.find(x=>sel==='.'+x.className)||this.children.map(x=>x.querySelector(sel)).find(Boolean)||null;}
 }
 const $=id=>nodes.get(id)||nodes.set(id,new Element()).get(id);
 for(const id of ['source-filter','kind-filter'])$(id).value='all';
 const listing={source_id:'fl',external_id:'0',title:'Synthetic',description:'Test only',canonical_url:'https://fl.ru/projects/1',listing_kind:'order',availability:'open'};
 const review={source_id:'fl',external_id:'0',text:'Saved',state:'draft',revision:1};
 const state={listings:[listing,{...listing,external_id:'1'}],reviews:[review],sources:[],summary:{orders:2,total:2}};
 const document={getElementById:$,createElement:t=>new Element(t),createTextNode:text=>({textContent:text}),body:new Element(),querySelector:s=>$(s),querySelectorAll:s=>s==='.listing'?$('listings').children:[]};
 const context=vm.createContext({document,window:{addEventListener(){}},URL,Intl,crypto:{randomUUID:()=> 'synthetic-operation'},Option:class extends Element{constructor(text,value){super('option');this.textContent=text;this.value=value;}},setInterval(){},confirm:()=>false,fetch:async(path,options)=>path==='/api/state'?{ok:true,json:async()=>state}:await new Promise(resolve=>pending.push({path,options,resolve}))});
 const nativeOpen=()=>null;
 context.window=context;context.addEventListener=()=>{};context.open=nativeOpen;
 vm.runInContext(script,context);
 return {$,context,state,review,listing,pending,nativeOpen,run:s=>vm.runInContext(s,context),active:()=>active};
}
const flush=()=>new Promise(r=>setImmediate(r));
test('one Reply action per listing and native modal with protected close/focus',async()=>{
 const x=setup();await flush();
 const row=x.$('listings').children[0];
 const buttons=row.children.flatMap(n=>n.children).filter(n=>n.tagName==='button');
 assert.deepEqual(buttons.map(n=>n.textContent),['Ответить']);
 await x.run('openEditor(state.listings[0])');assert.equal(x.$('editor-panel').open,true);
 x.$('reply-text').value='Unsaved';x.$('close-details').onclick();assert.equal(x.$('editor-panel').open,true);
 x.context.confirm=()=>true;x.$('editor-panel').handlers.cancel({preventDefault(){}});assert.equal(x.$('editor-panel').open,false);
 assert.equal(x.active().className,'listing-action');
});
test('late prepare cannot replace another editor session',async()=>{
 const x=setup();await flush();const request=x.run('openEditor(state.listings[1])');await flush();
 x.$('close-details').onclick();assert.equal(x.$('editor-panel').open,false);
 await x.run('openEditor(state.listings[0])');
 x.pending[0].resolve({ok:true,json:async()=>({...x.review,external_id:'1',text:'Late'})});await request;
 assert.equal(x.$('reply-text').value,'Saved');assert.equal(x.$('editor-panel').open,true);
});
test('backdrop requires both pointer-down and click outside',async()=>{
 const x=setup();await flush();await x.run('openEditor(state.listings[0])');const d=x.$('editor-panel');
 d.handlers.pointerdown({target:d,clientX:20,clientY:20});d.handlers.click({target:d,clientX:0,clientY:0});assert.equal(d.open,true);
 d.handlers.pointerdown({target:d,clientX:0,clientY:0});d.handlers.click({target:d,clientX:0,clientY:0});assert.equal(d.open,false);
});
test('late save cannot replace reopened editor',async()=>{
 const x=setup();await flush();await x.run('openEditor(state.listings[0])');x.$('reply-text').value='Changed';const request=x.run("act('save')");await flush();
 x.context.confirm=()=>true;x.$('close-details').onclick();await x.run('openEditor(state.listings[0])');
 x.pending[0].resolve({ok:true,json:async()=>({...x.review,text:'Late saved',revision:2})});await request;
 assert.equal(x.$('reply-text').value,'Saved');
 assert.equal(JSON.parse(x.pending[0].options.body).operation_id,'synthetic-operation');
});
test('prepare failure is visible inside the modal, including without a draft',async()=>{
 const x=setup();await flush();const request=x.run('openEditor(state.listings[1])');await flush();
 x.pending[0].resolve({ok:false,json:async()=>({error:'storage_unavailable'})});await request;
 assert.equal(x.$('review-message').hidden,false);
 assert.match(x.$('review-message').textContent,/Хранилище/);
});
test('delivery confirmation needs a separate explicit prompt binding recipient, account and exact text',async()=>{
 const x=setup();await flush();x.review.state='queued';x.review.approved_revision=1;x.review.canonical_url=x.listing.canonical_url;await x.run('openEditor(state.listings[0])');
 x.$('sender-account').value='owner-account';x.$('recipient-account').value='customer-account';x.$('delivery-credit').value='0';
 await x.run('confirmDeliveryFromUi()');assert.equal(x.pending.length,0);
 let prompt='';x.context.confirm=text=>{prompt=text;return true;};
 const saving=x.run('confirmDeliveryFromUi()');await flush();
 assert.match(prompt,/owner-account/);assert.match(prompt,/customer-account/);assert.match(prompt,/Saved/);assert.match(prompt,/https:\/\/fl.ru\/projects\/1/);
 assert.equal(x.pending[0].path,'/api/review/confirm_delivery');
 const payload=JSON.parse(x.pending[0].options.body);assert.equal(payload.details.text,'Saved');assert.equal(payload.details.recipient_account,'customer-account');
 x.pending[0].resolve({ok:true,json:async()=>({...x.review,delivery_confirmation:payload.details})});await saving;
 assert.match(x.$('delivery-note').textContent,/отключён/);
});
test('dirty text cannot receive delivery consent and disconnected sender is visible',async()=>{
 const x=setup();await flush();x.review.state='approved';x.review.approved_revision=1;await x.run('openEditor(state.listings[0])');
 x.$('reply-text').value='Unsaved';x.context.confirm=()=>true;
 await x.run('confirmDeliveryFromUi()');assert.equal(x.pending.length,0);
 assert.match(x.$('delivery-note').textContent,/отключён/);
});
test('source candidates show unavailable label and Telegram channel filters existing storage identities',async()=>{
 const x=setup();await flush();
 x.state.sources=[{id:'profi',name:'Профи',state:'candidate'},{id:'telegram:cgfreelance',source_id:'telegram',channel:'cgfreelance',name:'Telegram · @cgfreelance',state:'observed',automation:'unverified'}];
 x.state.listings=[{...x.listing,source_id:'telegram',external_id:'cgfreelance/9000011'},{...x.listing,source_id:'telegram',external_id:'job_design/9000013'}];
 await x.run('refresh()');
 assert.equal(x.$('sources').children[0].children[1].textContent,'Журнала проверок нет · Парсинг ограничен правилами · Кандидат · импорт недоступен');
 x.$('source-filter').value='telegram:cgfreelance';x.run('renderList()');assert.equal(x.$('listings').children.length,1);assert.equal(x.$('listings').children[0].dataset.listingKey,'telegram:cgfreelance/9000011');
});

test('excluded historical sources never enter active tabs, counters or source options, even with stale API data',async()=>{
 const x=setup();await flush();
 x.state.sources=[{id:'fl',name:'FL.ru'},...['freelancer','kwork','freelancehunt'].map(id=>({id,name:id}))];
 x.state.listings=[x.listing,...['freelancer','kwork','freelancehunt'].map(source_id=>({...x.listing,source_id}))];
 x.state.reviews=[x.review,...['freelancer','kwork','freelancehunt'].flatMap(source_id=>['draft','queued','sent'].map(state=>({...x.review,source_id,state})))];
 x.state.summary={orders:4,total:4};x.$('source-filter').value='kwork';
 await x.run('refresh()');
 assert.equal(x.$('source-filter').value,'all');
 assert.deepEqual(x.$('source-filter').children.map(x=>x.value),['all','fl']);
 assert.equal(x.$('sources').children.length,1);
 assert.equal(x.$('order-total').textContent,1);
 assert.match(x.$('updated-at').textContent,/1 записей/);
 for(const [view,count] of [['all',1],['draft',1],['queue',0],['sent',0]]){
  x.run(`view='${view}';renderList()`);
  assert.equal(x.$('shown-count').textContent,'Показано: '+count);
 }
 assert.equal(x.$('draft-count').textContent,1);assert.equal(x.$('queue-count').textContent,0);assert.equal(x.$('sent-count').textContent,0);
 x.run("view='all';renderList()");await x.run('openEditor(state.listings[0])');x.$('close-details').onclick();
 assert.equal(x.active().className,'listing-action');
 // Filtering is a read projection, not mutation of the server payload.
 assert.equal(x.state.listings.length,4);assert.equal(x.state.reviews.length,10);
});
test('closing a filtered-out listing returns focus to search',async()=>{
 const x=setup();await flush();await x.run('openEditor(state.listings[0])');
 x.$('search').value='no match';x.run('renderList()');x.$('close-details').onclick();
 assert.equal(x.$('editor-panel').open,false);assert.equal(x.active(),x.$('search'));
});
test('legacy-only payload renders empty active state without phantom tab counts',async()=>{
 const x=setup();await flush();x.state.listings=[{...x.listing,source_id:'freelancehunt'}];x.state.reviews=[{...x.review,source_id:'freelancehunt',state:'sent'}];
 await x.run('refresh()');assert.equal(x.$('shown-count').textContent,'Показано: 0');assert.equal(x.$('order-total').textContent,0);assert.equal(x.$('sent-count').textContent,0);assert.equal(x.$('listings').children[0].className,'empty');
});

test('new public source evidence displays unknown date and repost warning as text',async()=>{
 const {publicSources}=await import('../src/sources.mjs');const x=setup();await flush();
 x.state.sources=publicSources([]).filter(s=>['telegram:free_design1','telegram:rueventjob'].includes(s.id));
 await x.run('refresh()');
 const text=x.$('sources').children.map(row=>row.children.map(child=>child.textContent).join(' ')).join(' ');
 assert.match(text,/дата неизвестна/);assert.match(text,/активность не подтверждена/);
 assert.match(text,/не уникальные заказы/);assert.match(text,/Сбор данных для AI ограничен условиями/);
});
test('source panel distinguishes reported empty and blocked checks from saved listings',async()=>{
 const x=setup();await flush();x.state.sources=[{id:'fl',name:'FL',code:'empty',last_check:{status:'empty',checked_at:'2026-11-01T00:00:00.000Z',run_id:'cycle-1',reason:'no_matches',observed_count:0,saved_count:0}},{id:'telegram:cgfreelance',name:'Channel',code:'blocked',last_check:{status:'blocked',checked_at:'2026-11-01T00:00:00.000Z',run_id:'cycle-1',reason:'access_denied',observed_count:0,saved_count:0}}];
 await x.run('refresh()');const texts=x.$('sources').children.map(s=>s.children[1].textContent);assert.match(texts[0],/Подходящих заказов не найдено/);assert.match(texts[0],/cycle-1/);assert.match(texts[1],/Доступ заблокирован/);assert.doesNotMatch(texts.join(' '),/Сохранено/);
});
test('coverage panel reports missing records and does not imply successful checks for a fully reported skipped cycle',async()=>{
 const x=setup();await flush();x.state.scan={coverage:{run_id:'cycle-skipped',recorded:21,expected:21,completed:0,missing:0,status_counts:{success:0,empty:0,blocked:0,auth_required:0,error:0,skipped:21}}};
 await x.run('refresh()');const text=x.$('scan-coverage').textContent;
 assert.match(text,/проверено с результатом или пусто: 0/);assert.match(text,/нет отчёта: 0/);assert.match(text,/пропущено: 21/);assert.match(text,/не гарантия/);
});
test('candidate warnings keep all cards/actions and display escaped provenance plus limits',async()=>{
 const x=setup();await flush();x.state.candidate_check={status:'checked',pairs:[{listings:[x.listing,{...x.listing,external_id:'1'}]}]};
 await x.run('refresh()');const cards=x.$('listings').children.filter(x=>x.tagName==='article');assert.equal(cards.length,2);
 for(const card of cards){const warning=card.children[0].children.find(x=>x.className==='repost-warning');assert.ok(warning);assert.match(warning.children[0].textContent,/не подтверждённый/);const link=warning.children.find(x=>x.tagName==='a');assert.equal(link.rel,'noopener noreferrer');assert.equal(link.target,'_blank');assert.ok(card.children[1].children.some(x=>x.tagName==='button'));}
 assert.match(x.$('listings').children.at(-1).textContent,/могут быть пропущены/);assert.equal(x.pending.length,0);
 x.state.candidate_check={status:'unavailable',pairs:[]};await x.run('refresh()');assert.match(x.$('listings').children.at(-1).textContent,/недоступна/);
});
test('cached candidate payload does not expose excluded counterpart links',async()=>{
 const x=setup();await flush();x.state.candidate_check={status:'checked',pairs:[{listings:[x.listing,{...x.listing,source_id:'kwork',external_id:'legacy'}]}]};
 await x.run('refresh()');const cards=x.$('listings').children.filter(x=>x.tagName==='article');assert.equal(cards.length,2);
 assert.ok(cards.every(card=>!card.children[0].children.some(x=>x.className==='repost-warning')));assert.equal(x.pending.length,0);
});
test('candidate provenance never renders credentialed HTTPS links',async()=>{
 const x=setup();await flush();x.state.candidate_check={status:'checked',pairs:[{listings:[x.listing,{...x.listing,external_id:'1',canonical_url:'https://user:secret@t.me/cad_jobs/1'}]}]};
 await x.run('refresh()');const card=x.$('listings').children[0];const warning=card.children[0].children.find(x=>x.className==='repost-warning');assert.ok(warning);assert.ok(!warning.children.some(x=>x.tagName==='a'));
});
test('scope and exact checked URL distinguish a single card from a source section and legacy unknown scope',async()=>{
 const x=setup();await flush();
 x.state.sources=['single_item','section','legacy_unknown'].map((scope,i)=>({id:'source'+i,name:'Source',last_check:{scope,status:'success',checked_at:'2026-11-01T00:00:00.000Z',run_id:'cycle',reason:'checked',observed_count:1,saved_count:0,source_url:'https://vmasshtabe.ru/task/synthetic-scan-target'}}));
 await x.run('refresh()');const texts=x.$('sources').children.map(s=>s.children[1].textContent);
 assert.match(texts[0],/Единичная карточка — не скан площадки/);assert.match(texts[0],/https:\/\/vmasshtabe.ru\/task\/synthetic-scan-target/);assert.match(texts[0],/просмотрено 1/);
 assert.match(texts[1],/Раздел или лента — не вся площадка/);assert.match(texts[2],/Область старой проверки неизвестна/);
});

test('copy keeps current unsaved text intact and never saves, approves or queues',async()=>{
 const x=setup();await flush();x.listing.source_id=x.review.source_id='freelance';x.listing.external_id=x.review.external_id='123';x.listing.canonical_url='https://freelance.ru/task/view/123';await x.run('refresh()');await x.run('openEditor(state.listings[0])');
 const copied=[];x.context.navigator={clipboard:{writeText:async text=>copied.push(text)}};
 x.$('reply-text').value='  Личный ответ\nС уточнениями.  ';x.run('renderEditor()');
 assert.equal(typeof x.$('copy-reply').onclick,'function');
 await x.$('copy-reply').onclick();
 assert.deepEqual(copied,['  Личный ответ\nС уточнениями.  ']);assert.equal(x.$('reply-text').value,'  Личный ответ\nС уточнениями.  ');
 assert.equal(x.review.text,'Saved');assert.equal(x.review.state,'draft');assert.equal(x.pending.length,0);
 assert.match(x.$('review-message').textContent,/Скопирован/);assert.equal(x.$('original-link').href,x.listing.canonical_url);
 x.$('reply-text').value='Другая версия';await x.$('copy-reply').onclick();assert.equal(copied[1],'Другая версия');
});
test('clipboard denial preserves text and offers manual copying without write requests',async()=>{
 const x=setup();await flush();await x.run('openEditor(state.listings[0])');
 x.context.navigator={clipboard:{writeText:async()=>{throw new Error('Denied');}}};
 assert.equal(typeof x.$('copy-reply').onclick,'function');await x.$('copy-reply').onclick();
 assert.equal(x.$('reply-text').value,'Saved');assert.match(x.$('review-message').textContent,/вручную/);assert.equal(x.pending.length,0);
});
test('copy is unavailable for empty text but remains available for queued read-only text',async()=>{
 const x=setup();await flush();x.review.state='queued';await x.run('openEditor(state.listings[0])');
 assert.equal(x.$('reply-text').readOnly,true);assert.equal(x.$('copy-reply').disabled,false);
 x.$('reply-text').value='  ';x.run('renderEditor()');assert.equal(x.$('copy-reply').disabled,true);
});
test('late clipboard failure does not replace a reopened editor notice',async()=>{
 const x=setup();await flush();await x.run('openEditor(state.listings[0])');let rejectCopy;
 x.context.navigator={clipboard:{writeText:()=>new Promise((resolve,reject)=>{rejectCopy=reject;})}};
 assert.equal(typeof x.$('copy-reply').onclick,'function');const copying=x.$('copy-reply').onclick();
 x.$('close-details').onclick();await x.run('openEditor(state.listings[0])');x.run("notice('New editor notice')");rejectCopy(new Error('Denied'));await copying;
 assert.equal(x.$('review-message').textContent,'New editor notice');
});

test('source policy labels distinguish collection restrictions without granting manual collection rights',async()=>{
 const x=setup();await flush();
 x.state.sources=[{id:'profi',name:'Профи',state:'candidate'},{id:'telegram',name:'Telegram'},{id:'telegram:cgfreelance',source_id:'telegram',channel:'cgfreelance',name:'Channel'},{id:'vmasshtabe',name:'В Масштабе',automation:'prohibited'}];
 const before=JSON.stringify(x.state);await x.run('refresh()');
 const rows=x.$('sources').children;
 assert.match(rows[0].children[1].textContent,/Парсинг ограничен правилами/);
 assert.equal(rows[0].children[1].children[1].href,'https://profi.ru/documents/terms-of-use/');
 for(const row of rows.slice(1,3)){
  assert.match(row.children[1].textContent,/Сбор данных для AI ограничен условиями; автоматический сбор отключён в задании/);
  assert.equal(row.children[1].children[1].href,'https://telegram.org/tos/content-licensing');
 }
 assert.match(rows[3].children[1].textContent,/Автоматизация запрещена/);
 for(const row of rows)assert.doesNotMatch(row.children[1].textContent,/Только единичные наблюдения/);
 assert.equal(JSON.stringify(x.state),before);assert.equal(x.pending.length,0);
});
test('scan labels distinguish no matching orders from terms-restricted checks',async()=>{
 const x=setup();await flush();
 const check={scope:'section',source_url:'https://example.com/',checked_at:'2026-11-03T00:00:00.000Z',run_id:'synthetic',observed_count:0,saved_count:0};
 x.state.sources=[{id:'fl',name:'FL',last_check:{...check,status:'empty',reason:'no_matches'}},{id:'profi',name:'Профи',last_check:{...check,status:'blocked',reason:'terms_restricted'}},{id:'dwg',name:'DWG',last_check:{...check,status:'blocked',reason:'access_denied'}}];
 await x.run('refresh()');const rows=x.$('sources').children;
 assert.match(rows[0].children[1].textContent,/^Подходящих заказов не найдено/);
 assert.match(rows[1].children[1].textContent,/^Проверка ограничена условиями/);
 assert.match(rows[2].children[1].textContent,/^Доступ заблокирован/);
});

test('candidate evidence link is clickable without enabling import or claiming a scan',async()=>{
 const x=setup();await flush();
 x.state.sources=[{id:'pro_pto',name:'PRO-PTO',state:'candidate',code:'not_scanned',evidence_url:'https://pro-pto.ru/projects',evidence_note:'даты без года · актуальность и RSS не подтверждены'}];
 await x.run('refresh()');
 const detail=x.$('sources').children[0].children[1],link=detail.children.find(n=>n.tagName==='a');
 assert.ok(link);assert.equal(link.href,'https://pro-pto.ru/projects');assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
 assert.match(detail.textContent,/Кандидат · импорт недоступен/);assert.match(detail.textContent,/Журнала проверок нет/);
 for(const url of ['javascript:alert(1)','data:text/html,evil','http://pro-pto.ru/projects','https://pro-pto.ru.evil.test/projects','https://user@pro-pto.ru/projects','https://pro-pto.ru/projects?token=secret','https://pro-pto.ru/projects#fragment']){
  x.state.sources[0].evidence_url=url;await x.run('refresh()');
  assert.equal(x.$('sources').children[0].children[1].children.some(n=>n.tagName==='a'),false,url);
 }
 for(const id of ['unreviewed','constructor','__proto__']){
  x.state.sources[0]={...x.state.sources[0],id,evidence_url:'https://pro-pto.ru/projects'};await x.run('refresh()');
  assert.equal(x.$('sources').children[0].children[1].children.some(n=>n.tagName==='a'),false,id);
 }
});

test('legacy manual-sent records remain visible and locked without offering irreversible write UI',async()=>{
 const x=setup();await flush();x.listing.source_id='vmasshtabe';x.review.source_id='vmasshtabe';x.review.state='manual_sent';x.review.manual_delivery={text:'Saved',observed_at:'2026-11-03T00:00:00.000Z',observation:'Historical owner observation',delivery_url:'https://vmasshtabe.ru/account/view-task?id=1&response_id=2'};await x.run('openEditor(state.listings[0])');
 assert.equal(x.$('reply-text').readOnly,true);assert.equal(x.$('review-state').textContent,'Отправлено вручную');assert.match(x.$('manual-delivery-record').textContent,/Прочтение заказчиком не подтверждено/);assert.equal(x.$('sent-count').textContent,1);assert.equal(x.pending.length,0);
 assert.doesNotMatch(script,/recordManualDeliveryFromUi|api\/review\/record_manual_delivery/);
 const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');assert.doesNotMatch(html,/id="record-manual-delivery"/);assert.match(html,/id="delivery-panel"/);
});

test('3Dtoday candidate shows restrictions and exact safe manual-view links only',async()=>{
 const {publicSources}=await import('../src/sources.mjs');const x=setup();await flush();
 x.state.sources=publicSources([]).filter(s=>s.id==='3dtoday');await x.run('refresh()');
 assert.equal(x.$('sources').children.length,1);
 const detail=x.$('sources').children[0].children[1];
 assert.match(detail.textContent,/Кандидат · импорт недоступен/);assert.match(detail.textContent,/автоматический сбор запрещён/);
 const links=detail.children.filter(n=>n.tagName==='a');
 assert.deepEqual(links.map(l=>l.href),['https://3dtoday.ru/conditions','https://3dtoday.ru/board']);
 for(const l of links){assert.equal(l.target,'_blank');assert.equal(l.rel,'noopener noreferrer');}
 for(const url of ['javascript:alert(1)','https://3dtoday.ru.evil.test/board','https://3dtoday.ru/board?token=secret','https://3dtoday.ru/board#fragment']){
  x.state.sources[0].evidence_url=url;await x.run('refresh()');
  assert.deepEqual(x.$('sources').children[0].children[1].children.filter(n=>n.tagName==='a').map(n=>n.href),['https://3dtoday.ru/conditions']);
 }
 assert.equal(x.pending.length,0);
});

function copyOpenSetup(x){
 x.listing.external_id=x.review.external_id='123';x.listing.canonical_url='https://www.fl.ru/projects/123/test.html';
 const visits=[],tabs=[],copied=[];
 x.context.window.open=()=>{const tab={opener:{},closed:false,close(){this.closed=true;},document:{head:{append(){}},createElement(){return {};}},location:{replace(url){visits.push(url);}}};tabs.push(tab);return tab;};
 x.context.navigator={clipboard:{writeText:async text=>copied.push(text)}};
 return {visits,tabs,copied};
}
test('copy and open copies exact visible text then opens only the original order without mutations',async()=>{
 const x=setup();await flush();const io=copyOpenSetup(x);await x.run('openEditor(state.listings[0])');
 x.$('reply-text').value='  Личный текст\nБез отправки  ';x.run('renderEditor()');
 assert.equal(typeof x.$('copy-open-reply').onclick,'function');await x.$('copy-open-reply').onclick();
 assert.deepEqual(io.copied,['  Личный текст\nБез отправки  ']);assert.deepEqual(io.visits,[x.listing.canonical_url]);assert.equal(io.tabs[0].opener,null);
 assert.equal(x.$('reply-text').value,io.copied[0]);assert.equal(x.review.text,'Saved');assert.equal(x.review.state,'draft');assert.equal(x.pending.length,0);
 assert.match(x.$('review-message').textContent,/Вставьте.*самостоятельно/);
});
test('copy and open clipboard rejection closes blank tab, preserves text and never navigates',async()=>{
 const x=setup();await flush();const io=copyOpenSetup(x);await x.run('openEditor(state.listings[0])');
 x.context.navigator.clipboard.writeText=async()=>{throw new Error('Denied');};
 assert.equal(typeof x.$('copy-open-reply').onclick,'function');await x.$('copy-open-reply').onclick();
 assert.deepEqual(io.visits,[]);assert.equal(io.tabs[0].closed,true);assert.equal(x.$('reply-text').value,'Saved');assert.match(x.$('review-message').textContent,/Не удалось скопировать/);assert.equal(x.pending.length,0);
});
test('blocked popup still copies and offers explicit manual link without claiming opened',async()=>{
 const x=setup();await flush();const io=copyOpenSetup(x);x.context.window.open=()=>null;await x.run('openEditor(state.listings[0])');
 assert.equal(typeof x.$('copy-open-reply').onclick,'function');await x.$('copy-open-reply').onclick();
 assert.deepEqual(io.copied,['Saved']);assert.deepEqual(io.visits,[]);assert.match(x.$('review-message').textContent,/Скопирован.*не удалось открыть/);assert.equal(x.$('original-link').href,x.listing.canonical_url);
});
test('new action rejects unsafe or mismatched destinations before clipboard or popup',async()=>{
 const x=setup();await flush();const io=copyOpenSetup(x);
 for(const url of ['javascript:alert(1)','https://evil.test/projects/123/test.html','https://www.fl.ru.evil.test/projects/123/test.html','https://user@www.fl.ru/projects/123/test.html','http://www.fl.ru/projects/123/test.html','https://www.fl.ru/projects/999/test.html','https://www.fl.ru/projects/123/test.html?text=secret','https://www.fl.ru/projects/123/test.html#secret','https://www.fl.ru/../projects/123/test.html']){
  x.listing.canonical_url=url;await x.run('openEditor(state.listings[0])');assert.equal(x.$('copy-open-reply').disabled,true,url);assert.equal(x.$('original-link').hidden,true,url);
  assert.equal(typeof x.$('copy-open-reply').onclick,'function');await x.$('copy-open-reply').onclick();
 }
 assert.deepEqual(io.copied,[]);assert.deepEqual(io.tabs,[]);assert.equal(x.pending.length,0);
});
test('repeated clicks and editor dismissal cannot cause late navigation',async()=>{
 const x=setup();await flush();const io=copyOpenSetup(x);await x.run('openEditor(state.listings[0])');let resolveCopy;
 x.context.navigator.clipboard.writeText=()=>new Promise(resolve=>{resolveCopy=resolve;});
 assert.equal(typeof x.$('copy-open-reply').onclick,'function');const pending=x.$('copy-open-reply').onclick();await x.$('copy-open-reply').onclick();assert.equal(io.tabs.length,1);
 x.$('close-details').onclick();await x.run('openEditor(state.listings[0])');x.run("notice('New session')");resolveCopy();await pending;
 assert.deepEqual(io.visits,[]);assert.equal(io.tabs[0].closed,true);assert.equal(x.$('review-message').textContent,'New session');
});

test('safe order links support every existing import source and reject cross-source identity',async()=>{
 const x=setup();await flush();
 const examples=[['fl','123','https://www.fl.ru/projects/123/test.html'],['freelance','123','https://freelance.ru/task/view/123'],['freelance','123','https://freelance.ru/projects/test-123.html'],['vmasshtabe','test-order','https://vmasshtabe.ru/task/test-order'],['telegram','cad_jobs/123','https://t.me/cad_jobs/123'],['weblancer','123','https://www.weblancer.net/freelance/chertezhi-78/test-123/'],['3ddd','123','https://3ddd.ru/work/task_show/123'],['dwg','123','https://dwg.ru/board/123'],['enginer','test-order','https://enginer.ru/request/test-order/']];
 for(const [source_id,external_id,canonical_url] of examples){
  const item={source_id,external_id,canonical_url};assert.equal(x.run(`safeOrderUrl(${JSON.stringify(item)})`),canonical_url);
  assert.equal(x.run(`safeOrderUrl(${JSON.stringify({...item,external_id:'wrong'})})`),null);
 }
 for(const source_id of ['__proto__','constructor','kwork'])assert.equal(x.run(`safeOrderUrl(${JSON.stringify({source_id,external_id:'123',canonical_url:examples[0][2]})})`),null);
});
test('closed popup and navigation exception retain copied text and manual path',async()=>{
 for(const mode of ['closed','throw']){
  const x=setup();await flush();const io=copyOpenSetup(x);const originalOpen=x.context.window.open;
  x.context.window.open=()=>{const tab=originalOpen();if(mode==='closed')tab.closed=true;else tab.location.replace=()=>{throw new Error('Navigation failed');};return tab;};
  await x.run('openEditor(state.listings[0])');await x.$('copy-open-reply').onclick();
  assert.deepEqual(io.copied,['Saved']);assert.deepEqual(io.visits,[]);assert.match(x.$('review-message').textContent,/не удалось открыть/);assert.equal(x.$('reply-text').value,'Saved');assert.equal(x.pending.length,0);
 }
});
test('missing clipboard API fails safely without opening a blank tab',async()=>{
 const x=setup();await flush();const io=copyOpenSetup(x);x.context.navigator={};await x.run('openEditor(state.listings[0])');await x.$('copy-open-reply').onclick();
 assert.equal(io.tabs.length,0);assert.equal(x.$('reply-text').value,'Saved');assert.match(x.$('review-message').textContent,/Не удалось скопировать/);assert.equal(x.$('copy-open-reply').disabled,false);
});
test('new action label and manual delivery instructions are explicit in real markup',()=>{
 const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
 assert.match(html,/id="copy-open-reply"[^>]*>Скопировать и открыть заказ/);
 assert.match(html,/Эта кнопка не отправляет отклик и не меняет его статус/);
 assert.match(html,/id="original-link" target="_blank" rel="noopener noreferrer"/);
});


test('classic script preserves native window.open in the shared browser global namespace',async()=>{
 const x=setup();await flush();
 assert.equal(x.run('window === globalThis'),true);
 assert.equal(x.context.open,x.nativeOpen,'loading the editor must not replace the browser popup API');
 const io=copyOpenSetup(x);
 await x.$('listings').children[0].children[1].children.find(el=>el.tagName==='button').onclick();
 x.$('reply-text').value='Unsaved exact response';x.run('renderEditor()');
 let prompts=0;x.context.confirm=()=>{prompts++;return false;};
 await x.$('copy-open-reply').onclick();
 assert.equal(prompts,0);assert.deepEqual(io.copied,['Unsaved exact response']);assert.deepEqual(io.visits,[x.listing.canonical_url]);
 assert.equal(x.$('reply-text').value,'Unsaved exact response');assert.equal(x.pending.length,0);
});
