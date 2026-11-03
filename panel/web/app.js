// New client for the cloud API; no local session token or desktop process.
'use strict';
const $=id=>document.getElementById(id);
const names={fl:'FL.ru',freelance:'Freelance.ru',telegram:'Telegram',kwork:'Kwork',freelancer:'Freelancer.com',vmasshtabe:'В Масштабе'};
// Defensive projection for cached/older API payloads; never alter saved records.
// Exact reviewed public links only; never navigate to arbitrary API-provided URLs.
const catalogEvidenceLinks=Object.freeze({pro_pto:'https://pro-pto.ru/projects','3dtoday':'https://3dtoday.ru/board'});
const excludedSources=new Set(['freelancer','kwork','freelancehunt']);
const labels={draft:'Черновик',approved:'Одобрен',queued:'В очереди',sending:'Отправка начата',sent:'Отправлено',manual_sent:'Отправлено вручную',uncertain:'Нужна проверка'};
const errors={delivery_guard:'Есть запись наблюдения отправки. Защита от повторной отправки сохраняется даже после исправления учёта.',invalid_manual_delivery:'Проверьте наблюдение, дату UTC и ссылку на переписку В Масштабе.',invalid_confirmation:'Проверьте аккаунты, цену, валюту, срок и расход отклика.',confirmation_mismatch:'Текст или получатель изменились. Проверьте сохранённую версию.',delivery_confirmation_required:'Для отправки нужно отдельное разрешение на этот текст и получателя.',stale_revision:'Сохранённая версия изменилась. Ваш текст оставлен в редакторе; скопируйте его перед загрузкой новой версии.',listing_unavailable:'Заказ закрыт или недоступен.',approval_required:'Сначала одобрите текущую версию.',review_locked:'Этот отклик заблокирован для правок.',sign_in_required:'Войдите в ChatGPT, чтобы открыть личную панель.',owner_required:'Эта панель доступна только владельцу.',site_not_configured:'Облачная панель ещё настраивается.',storage_unavailable:'Хранилище временно недоступно. Правки остаются в окне.'};
let state=null,selected=null,review=null,busy=false,loading=false,view='all',conflict=false,editorSession=0,preparing=false,copying=false;
const key=x=>x.source_id+':'+x.external_id;
const dirty=()=>Boolean(review&&$('reply-text').value!==review.text);
function node(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;}
function when(value){if(!value)return 'ещё не было';return new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'}).format(new Date(value))+' МСК';}
function budget(x){if(x.budget_min==null&&x.budget_max==null)return 'Бюджет неизвестен';return (x.budget_min!=null?'от '+x.budget_min:'')+(x.budget_max!=null?' до '+x.budget_max:'')+' '+(x.currency??'');}
function notice(text,error=false){for(const id of ['notice','review-message']){$(id).hidden=!text;$(id).textContent=text;$(id).classList.toggle('error',error);}}
async function call(path,data){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,operation_id:crypto.randomUUID()})});const body=await response.json();if(!response.ok)throw new Error(errors[body.error]??body.error??'Ошибка сохранения');return body;}
function repostNotice(item){
 const check=state.candidate_check;
 const matches=(check?.pairs??[]).flatMap(pair=>pair.listings.some(x=>key(x)===key(item))?pair.listings.filter(x=>key(x)!==key(item)&&!excludedSources.has(x.source_id)):[]);
 if(!matches.length)return null;
 const box=node('div',undefined,'repost-warning');
 box.append(node('strong','Возможный репост — не подтверждённый дубль.'));
 box.append(node('p','Совпадает полный текст. Записи сохранены отдельно; проверьте источники.'));
 for(const match of matches){
  const link=node('a',match.source_id+' / '+match.external_id);
  try{const url=new URL(match.canonical_url);if(url.protocol!=='https:'||url.username||url.password)continue;link.href=url.href;}catch{continue;}
  link.target='_blank';link.rel='noopener noreferrer';box.append(link,node('br'));
 }
 return box;
}
function renderList(){
 if(!state)return;
 const query=$('search').value.toLocaleLowerCase(),source=$('source-filter').value,kind=$('kind-filter').value;
 const rows=state.listings.filter(x=>{const r=state.reviews.find(r=>key(r)===key(x));return (source==='all'||source===x.source_id||source==='telegram:'+x.external_id.split('/')[0])&&(kind==='all'||kind===x.listing_kind)&&(!$('with-budget').checked||x.budget_min!=null||x.budget_max!=null)&&(!query||(x.title+' '+(x.description??'')).toLocaleLowerCase().includes(query))&&(view==='all'||view==='draft'&&['draft','approved'].includes(r?.state)||view==='queue'&&['queued','sending','uncertain'].includes(r?.state)||view==='sent'&&['sent','manual_sent'].includes(r?.state));});
 $('shown-count').textContent='Показано: '+rows.length;
 $('listings').replaceChildren(...rows.map(x=>{const article=node('article',undefined,'listing'+(selected&&key(selected)===key(x)?' is-selected':'')),copy=node('div',undefined,'listing-copy'),title=node('h2',x.title,'listing-title');article.dataset.listingKey=key(x);copy.append(node('span',names[x.source_id]??x.source_id,'source-label'),title,node('p',x.description||'Описание не передано','listing-description'));const warning=repostNotice(x);if(warning)copy.append(warning);const side=node('div',undefined,'listing-side');side.append(node('strong',budget(x)),node('span',x.bids_count==null?'Число откликов неизвестно':x.bids_count+' откл.'));const r=state.reviews.find(r=>key(r)===key(x));if(r)side.append(node('span',labels[r.state]));if(x.availability==='closed')side.append(node('span','Закрыт'));const button=node('button','Ответить','listing-action');button.type='button';button.onclick=()=>openEditor(x);side.append(button);article.append(copy,side);return article;}));
 if(!rows.length)$('listings').append(node('div',state.listings.length?'Нет записей по выбранным фильтрам':'Реальные заказы ещё не импортированы. Dot добавит проверенные наблюдения в эту облачную базу.','empty'));
 if(state.candidate_check)$('listings').append(node('p',state.candidate_check.status==='unavailable'?'Проверка возможных репостов временно недоступна.':'Проверка репостов ограничена 500 последними наблюдениями и 100 парами: совпадения могут быть пропущены.','repost-coverage'));
 $('listings').setAttribute('aria-busy','false');
 for(const [id,states] of [['draft-count',['draft','approved']],['queue-count',['queued','sending','uncertain']],['sent-count',['sent','manual_sent']]])$(id).textContent=state.reviews.filter(r=>states.includes(r.state)).length;
}
// Defense in depth for cached payloads: source, order identity and exact path
// must match. No query/fragment (including response text) is ever transmitted.
function safeOrderUrl(item){
 const hosts={fl:['www.fl.ru','fl.ru'],freelance:['freelance.ru','www.freelance.ru'],vmasshtabe:['vmasshtabe.ru'],telegram:['t.me'],weblancer:['www.weblancer.net','weblancer.net'],'3ddd':['3ddd.ru'],dwg:['dwg.ru'],enginer:['enginer.ru']};
 try{
  const raw=item.canonical_url;
  if(typeof raw!=='string'||raw.length>2048||/[\x00-\x20\\%]/.test(raw)||raw.split('/').some(x=>x==='.'||x==='..'))return null;
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash||!Object.hasOwn(hosts,item.source_id)||!hosts[item.source_id].includes(u.hostname))return null;
  const path=u.pathname.replace(/\/$/,''),patterns={fl:/^\/projects\/([1-9][0-9]*)\/[a-zA-Z0-9_-]+\.html$/,freelance:/^\/task\/view\/([1-9][0-9]*)$/,vmasshtabe:/^\/task\/([a-z0-9][a-z0-9-]{0,127})$/,telegram:/^\/(?:s\/)?([a-zA-Z][a-zA-Z0-9_]{3,63}\/[1-9][0-9]*)$/,weblancer:/^\/freelance\/[a-z0-9-]+-[0-9]+\/[a-z0-9-]+-([1-9][0-9]*)$/,'3ddd':/^\/work\/task_show\/([1-9][0-9]*)$/,dwg:/^\/board\/([1-9][0-9]*)$/,enginer:/^\/request\/([a-z0-9][a-z0-9-]{0,127})$/};
  const match=path.match(patterns[item.source_id])||(item.source_id==='freelance'&&path.match(/^\/projects\/[a-zA-Z0-9_-]+-([1-9][0-9]*)\.html$/));
  if(!match||(item.source_id==='telegram'?match[1].toLowerCase():match[1])!==item.external_id)return null;
  return u.href;
 }catch{return null;}
}
function renderEditor(){
 if(!selected)return;
 const available=selected.listing_kind==='order'&&selected.availability!=='closed';
 $('details-source').textContent=names[selected.source_id]??selected.source_id;$('details-title').textContent=selected.title;
 $('details-description').textContent=selected.description||'Описание не передано';$('details-date').textContent='Проверено: '+when(selected.last_seen);
 $('details-metrics').replaceChildren(node('strong',budget(selected)),node('span',selected.availability==='closed'?'Закрыт':selected.availability==='open'?'Открыт':'Статус неизвестен'));
 const url=safeOrderUrl(selected);$('original-link').hidden=!url;$('original-link').href=url??'';
 const editable=review&&['draft','approved'].includes(review.state);
 $('reply-area').hidden=!review;$('reply-unavailable').hidden=available;
 $('reply-unavailable').textContent=selected.availability==='closed'?'Заказ уже закрыт. Описание и сохранённый отклик доступны, отправка отключена.':'Отклики доступны для заказов. Это объявление можно посмотреть на площадке.';
 document.querySelector('.editor-footer').hidden=!review;
 $('reply-text').disabled=!review;$('reply-text').readOnly=!editable||busy||conflict;
 $('review-state').textContent=labels[review?.state]??'';$('char-count').textContent=$('reply-text').value.length+' / 8000';
 $('save-state').textContent=busy?'Сохраняем…':conflict?'Конфликт версий':dirty()?'Есть несохранённые правки':'Сохранено';
 $('copy-reply').disabled=copying||!review||!$('reply-text').value.trim();
 $('copy-open-reply').disabled=copying||!review||!$('reply-text').value.trim()||!url;
 $('copy-open-reply').textContent=copying?'Копируем…':'Скопировать и открыть заказ';
 $('save-reply').hidden=!editable;$('save-reply').disabled=busy||conflict||!dirty()||!$('reply-text').value.trim();
 $('approve-reply').hidden=!editable||review?.state==='approved'&&!dirty();$('approve-reply').disabled=busy||conflict||!available||!$('reply-text').value.trim();
 $('queue-reply').hidden=review?.state!=='approved'||dirty();$('queue-reply').disabled=busy||conflict||!available;
 $('cancel-reply').hidden=!['approved','queued'].includes(review?.state);$('cancel-reply').disabled=busy||conflict;
 $('reload-reply').hidden=!conflict;$('reload-reply').disabled=busy;
 $('delivery-confirmation').hidden=!review||!['approved','queued'].includes(review.state)||!['fl','freelance'].includes(review.source_id);
 $('confirm-delivery').disabled=busy||conflict||!available||dirty();
 $('manual-delivery-record').hidden=!review?.manual_delivery;
 $('manual-delivery-record').textContent=review?.manual_delivery?'Отправлено вручную · наблюдение '+when(review.manual_delivery.observed_at)+' · '+review.manual_delivery.observation+' · '+review.manual_delivery.delivery_url+' · Прочтение заказчиком не подтверждено.':'';
 $('delivery-note').textContent='Отправитель отключён: эта версия не отправляет сообщения. '+(review?.delivery_confirmation?'Отдельное разрешение сохранено для точного текста, аккаунта и получателя.':'Одобрение текста и очередь сами по себе не являются разрешением отправки.');
}
async function copyReply(){
 if(copying||!review||!$('reply-text').value.trim())return;
 const session=editorSession,text=$('reply-text').value;
 copying=true;renderEditor();
 try{
  await navigator.clipboard.writeText(text);
  if(session===editorSession)notice('Скопирован текст на момент нажатия. Вставьте его на площадке и отправьте самостоятельно.');
 }catch{
  if(session===editorSession)notice('Не удалось скопировать автоматически. Выделите текст отклика и скопируйте его вручную.',true);
 }finally{copying=false;renderEditor();}
}
async function copyAndOpenReply(){
 const url=selected&&safeOrderUrl(selected);
 if(copying||!review||!$('reply-text').value.trim()||!url)return;
 const session=editorSession,text=$('reply-text').value;
 copying=true;renderEditor();
 let tab=null;
 const closeTab=()=>{try{if(tab&&!tab.closed)tab.close();}catch{}};
 try{
  // Start clipboard while the editor still has focus; reserve the tab within
  // the same user gesture, before awaiting permission. Never send draft text.
  const copied=navigator.clipboard.writeText(text);
  try{
   tab=window.open('about:blank','_blank');
   if(tab){tab.opener=null;const meta=tab.document.createElement('meta');meta.name='referrer';meta.content='no-referrer';tab.document.head.append(meta);}
  }catch{closeTab();tab=null;}
  await copied;
  if(session!==editorSession){closeTab();return;}
  let opened=false;
  try{if(tab&&!tab.closed){tab.location.replace(url);opened=true;}}catch{closeTab();}
  notice(opened?'Скопирован текст на момент нажатия. Заказ открывается в новой вкладке. Вставьте текст на площадке и отправьте самостоятельно.':'Скопирован текст на момент нажатия, но новую вкладку не удалось открыть. Нажмите «Открыть на площадке», вставьте текст и отправьте самостоятельно.',!opened);
 }catch{
  closeTab();
  if(session===editorSession)notice('Не удалось скопировать автоматически. Текст остался в редакторе: выделите и скопируйте его вручную, затем нажмите «Открыть на площадке».',true);
 }finally{copying=false;renderEditor();}
}
function accept(row){review=row;conflict=false;$('reply-text').value=row.text;if(state)state.reviews=state.reviews.filter(x=>key(x)!==key(row)).concat(row);}
async function openEditor(item){
 if(busy||dirty()&&!confirm('Несохранённые правки будут потеряны. Открыть другой заказ?'))return;
 const session=++editorSession;notice('');for(const id of ['sender-account','recipient-account','delivery-price','delivery-currency','delivery-deadline'])$(id).value='';$('delivery-credit').value='0';selected=item;review=state.reviews.find(x=>key(x)===key(item))??null;conflict=false;$('reply-text').value=review?.text??'';renderEditor();renderList();if(!$('editor-panel').open)$('editor-panel').showModal();document.body.classList.add('dialog-open');document.querySelector('.editor-scroll').scrollTop=0;$('details-title').focus({preventScroll:true});
 if(!review&&item.listing_kind==='order'&&item.availability!=='closed'){
  busy=true;preparing=true;renderEditor();try{const row=await call('/api/review/prepare',{source_id:item.source_id,external_id:item.external_id});if(session===editorSession)accept(row);}catch(e){if(session===editorSession)notice(e.message,true);}finally{if(session===editorSession){busy=false;preparing=false;}}
 }
 if(session===editorSession){renderEditor();renderList();}
}
async function act(action){
 if(!review||busy||conflict)return;const session=editorSession;busy=true;renderEditor();
 try{
  const identity={source_id:review.source_id,external_id:review.external_id};
  if(action==='save'||action==='approve'&&dirty()){const row=await call('/api/review/save',{...identity,revision:review.revision,text:$('reply-text').value});if(session!==editorSession)return;accept(row);}
  if(action!=='save'){const row=await call('/api/review/'+action,{...identity,revision:review.revision});if(session!==editorSession)return;accept(row);}
  notice('Сохранено в облачной базе.');
 }catch(e){if(session===editorSession){notice(e.message,true);conflict=true;}}finally{if(session===editorSession){busy=false;renderEditor();renderList();}}
}
async function confirmDeliveryFromUi(){
 if(!review||busy||conflict||dirty()||!['approved','queued'].includes(review.state))return;
 const session=editorSession;
 const val=id=>$(id).value.trim();
 const details={source_id:review.source_id,external_id:review.external_id,canonical_url:review.canonical_url,text:review.text,revision:review.revision,sender_account:val('sender-account'),recipient_account:val('recipient-account'),price:val('delivery-price')?Number(val('delivery-price')):null,currency:val('delivery-currency')?val('delivery-currency').toUpperCase():null,deadline:val('delivery-deadline')||null,credit_cost:Number(val('delivery-credit'))};
 if(!details.sender_account||!details.recipient_account){notice('Укажите точные аккаунты отправителя и заказчика.',true);return;}
 const message=`Разрешить одну отправку именно этого отклика?\n\nВаш аккаунт: ${details.sender_account}\nЗаказчик: ${details.recipient_account}\nПроект: ${details.canonical_url}\nЦена: ${details.price??'не требуется'} ${details.currency??''}\nСрок: ${details.deadline??'не требуется'}\nРасход имеющихся откликов: ${details.credit_cost}\n\n${details.text}\n\nОтправитель пока отключён. Покупки и подписки не разрешаются. Для отправки нужны отдельное подключение и проверка сессии.`;
 if(!confirm(message))return;
 busy=true;renderEditor();
 try{const row=await call('/api/review/confirm_delivery',{source_id:review.source_id,external_id:review.external_id,revision:review.revision,details});if(session!==editorSession)return;accept(row);notice('Разрешение сохранено. Сообщение не отправлено.');}
 catch(e){if(session===editorSession)notice(e.message,true);}
 finally{if(session===editorSession){busy=false;renderEditor();renderList();}}
}
async function refresh(){
 if(loading||busy)return;loading=true;
 try{
  const response=await fetch('/api/state',{cache:'no-store'}),payload=await response.json();if(!response.ok)throw new Error(errors[payload.error]??payload.error);
  const listings=payload.listings.filter(x=>!excludedSources.has(x.source_id));
  const next={...payload,listings,reviews:payload.reviews.filter(x=>!excludedSources.has(x.source_id)),sources:payload.sources.filter(x=>!excludedSources.has(x.source_id??x.id)),summary:{...payload.summary,total:listings.length,orders:listings.filter(x=>x.listing_kind==='order').length}};
  for(const s of next.sources)if(!s.channel)names[s.id]=s.name;
  state=next;$('connection').textContent='Личная облачная панель';$('order-total').textContent=next.summary.orders;$('updated-at').textContent='Карточки сохранены в облаке • '+next.summary.total+' записей';
  const chosen=$('source-filter').value;$('source-filter').replaceChildren(new Option('Все источники','all'),...next.sources.map(s=>new Option(s.name,s.id)));$('source-filter').value=chosen==='all'||next.sources.some(s=>s.id===chosen)?chosen:'all';
  const labels={success:'Найдены результаты',empty:'Подходящих заказов не найдено',blocked:'Доступ заблокирован',auth_required:'Нужен вход',error:'Ошибка проверки',skipped:'Пропущено'};
  const scopes={root:'Главная страница — не вся площадка',section:'Раздел или лента — не вся площадка',single_item:'Единичная карточка — не скан площадки',legacy_unknown:'Область старой проверки неизвестна'};
  const reasons={checked:'проверено',no_matches:'нет совпадений',access_denied:'доступ запрещён',login_required:'требуется авторизация',captcha:'CAPTCHA',robots_disallowed:'запрет robots',terms_restricted:'ограничение правил',timeout:'таймаут',unavailable:'недоступен',parse_failed:'ошибка разбора',not_attempted:'не проверялся',unsupported:'не поддерживается'};
  $('sources').replaceChildren(...next.sources.map(s=>{
   const row=node('div',undefined,'source-row'),c=s.last_check;
   const check=c?((c.status==='blocked'&&c.reason==='terms_restricted'?'Проверка ограничена условиями':labels[c.status])+' · '+(scopes[c.scope]??scopes.legacy_unknown)+' · '+(c.source_url??'URL не указан')+' · '+when(c.checked_at)+' · цикл '+c.run_id+' · '+(reasons[c.reason]??c.reason)+' · просмотрено '+c.observed_count+', сохранено '+c.saved_count+' (сообщено dot)'):(s.code==='agent_observed'?'Есть сохранённые карточки · '+when(s.last_observed_at)+' · журнала проверок нет':'Журнала проверок нет');
   const policy=s.state==='candidate'?'Кандидат · импорт недоступен':s.automation==='prohibited'?'Автоматизация запрещена':'Ручной импорт · автоматизация не проверена';
   const sourceId=s.source_id??s.id;
   const restriction=sourceId==='3dtoday'?{text:'Только ручной просмотр; автоматический сбор запрещён без специального разрешения',url:'https://3dtoday.ru/conditions'}:sourceId==='profi'?{text:'Парсинг ограничен правилами',url:'https://profi.ru/documents/terms-of-use/'}:sourceId==='telegram'||s.id.startsWith('telegram:')?{text:'Сбор данных для AI ограничен условиями; автоматический сбор отключён в задании',url:'https://telegram.org/tos/content-licensing'}:null;
   const detail=node('span',check+' · '+(restriction?restriction.text+(s.state==='candidate'?' · Кандидат · импорт недоступен':''):policy)+(s.evidence_note?' · '+s.evidence_note:''));
   if(restriction){const link=node('a','Правила источника');link.href=restriction.url;link.target='_blank';link.rel='noopener noreferrer';detail.append(document.createTextNode(' · '),link);}
   if(Object.hasOwn(catalogEvidenceLinks,s.id)&&s.evidence_url===catalogEvidenceLinks[s.id]){const link=node('a','Открыть источник');link.href=catalogEvidenceLinks[s.id];link.target='_blank';link.rel='noopener noreferrer';detail.append(document.createTextNode(' · '),link);}
   row.append(node('span',s.name),detail);return row;
  }));
  const coverage=next.scan?.coverage;
  $('scan-coverage').textContent=coverage?'Цикл '+coverage.run_id+': записано '+coverage.recorded+' из '+coverage.expected+' источников; нет отчёта: '+coverage.missing+'; проверено с результатом или пусто: '+coverage.completed+'. Заблокировано: '+coverage.status_counts.blocked+', нужен вход: '+coverage.status_counts.auth_required+', ошибок: '+coverage.status_counts.error+', пропущено: '+coverage.status_counts.skipped+'. Успешных проверок главной/раздела: '+(coverage.completed_source_checks??'неизвестно')+'. Области всех отчётов — единичных карточек: '+(coverage.scope_counts?.single_item??'неизвестно')+'; область неизвестна: '+(coverage.scope_counts?.legacy_unknown??'неизвестно')+'. Это отчёт dot, не гарантия работы источников.':'Циклы проверок ещё не записаны. Сохранённые карточки не подтверждают проверку всех источников.';
  $('monitor-status').textContent='Регулярное расписание пока не подключено.';$('agent-status').textContent='Dot может добавлять карточки через защищённый импорт. Отправка откликов отключена.';
  $('scan-button').disabled=false;
  if(selected){selected=next.listings.find(x=>key(x)===key(selected))??selected;const incoming=next.reviews.find(x=>key(x)===key(selected));if(incoming&&JSON.stringify(incoming)!==JSON.stringify(review)){if(dirty())conflict=true;else accept(incoming);}}
  renderList();renderEditor();
 }catch(e){$('connection').textContent='Нет связи';notice(e.message||'Не удалось загрузить базу. Ваш текст остаётся в редакторе.',true);}finally{loading=false;}
}
for(const id of ['search','source-filter','kind-filter','with-budget'])$(id).addEventListener(id==='search'?'input':'change',renderList);
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{view=button.dataset.view;for(const b of document.querySelectorAll('[data-view]')){b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));}renderList();};
for(const action of ['save','approve','queue','cancel'])$(action+'-reply').onclick=()=>act(action);
$('reply-text').oninput=renderEditor;
$('confirm-delivery').onclick=confirmDeliveryFromUi;
$('reload-reply').onclick=()=>{if(dirty()&&!confirm('Заменить текст сохранённой версией? Сначала скопируйте нужные правки.'))return;const row=state.reviews.find(x=>key(x)===key(selected));if(row)accept(row);renderEditor();};
function closeEditor(){
 const warning=busy&&!preparing?'Действие ещё выполняется. Закрыть окно? Уже отправленный запрос продолжит выполняться.':dirty()?'Несохранённые правки будут потеряны. Закрыть отклик?':'';
 if(warning&&!confirm(warning))return;
 const previousKey=selected&&key(selected);++editorSession;preparing=false;busy=false;selected=null;review=null;conflict=false;
 $('editor-panel').close();document.body.classList.remove('dialog-open');renderList();
 const listing=[...document.querySelectorAll('.listing')].find(row=>row.dataset.listingKey===previousKey);
 (listing?.querySelector('.listing-action')||$('search')).focus({preventScroll:true});
}
$('copy-reply').onclick=copyReply;
$('copy-open-reply').onclick=copyAndOpenReply;
$('close-details').onclick=closeEditor;
$('editor-panel').addEventListener('cancel',event=>{event.preventDefault();closeEditor();});
let backdropPointer=false;
function outsideEditor(event){const box=$('editor-panel').getBoundingClientRect();return event.target===$('editor-panel')&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom);}
$('editor-panel').addEventListener('pointerdown',event=>{backdropPointer=outsideEditor(event);});
$('editor-panel').addEventListener('click',event=>{if(backdropPointer&&outsideEditor(event))closeEditor();backdropPointer=false;});
$('settings-button').onclick=()=>{$('settings').hidden=!$('settings').hidden;$('settings-button').setAttribute('aria-expanded',String(!$('settings').hidden));};
$('rail-settings').onclick=()=>$('settings-button').click();$('rail-orders').onclick=()=>document.querySelector('[data-view="all"]').click();$('rail-queue').onclick=()=>document.querySelector('[data-view="queue"]').click();
$('scan-button').onclick=refresh;
window.addEventListener('beforeunload',event=>{if(dirty()){event.preventDefault();event.returnValue='';}});
refresh();setInterval(refresh,15000);
