// Independent panel. Renders text only; never loads mail URLs or marks Gmail read.
(()=>{
 'use strict';
 const $=id=>document.getElementById(id),messages=new Map(),viewed=new Set(),cards=new Map(),pendingViewed=new Set();
 let loading=false,nextCursor=null,loadedOlder=false,paginationRestarted=false;
 const key=m=>m.message_key||JSON.stringify(['mail',m.mailbox,m.message_id]);
 function node(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
 function syncViewed(m,button){const seen=Boolean(m.panel_viewed_at)||viewed.has(key(m));button.disabled=seen||pendingViewed.has(key(m));button.textContent=seen?'Просмотрено в панели':'Отметить просмотренным в панели';}
 function provenance(m){return m.provenance==='provider_verified'?'Получено через Gmail API; это не полная переписка площадки.':'Записано по наблюдению агента; прямое чтение провайдера не подтверждено.';}
 function delay(m){return Number.isFinite(m.receipt_to_storage_ms)&&m.receipt_to_storage_ms>=0?'Получение письма → сохранение в панели: '+Math.round(m.receipt_to_storage_ms/1000)+' с. Это не задержка ответа площадки.':'Задержка получения не измерена.';}
 function card(m){
  const cached=cards.get(key(m));if(cached){syncViewed(m,cached.button);cached.provenance.textContent=provenance(m);cached.delay.textContent=delay(m);return cached.box;}
  const box=node('article'),heading=node('h3',m.subject||'(без темы)'),details=node('details'),summary=node('summary','Показать текст уведомления');
  const provenanceLabel=node('p',provenance(m)),delayLabel=node('p',delay(m));
  box.className='mail-notification';box.append(heading,node('p',m.kind==='platform_message'?'Сообщение площадки · наблюдение агента':'Email-уведомление'),provenanceLabel,delayLabel,node('p',m.sender+' · '+(m.mailbox||((m.source_id??'')+' · '+(m.account_id??'')))),node('p','Получено: '+m.received_at),node('p','Сохранено в панели: '+(m.recorded_at||'неизвестно')));
  box.append(node('p',m.link_status==='exact_url'?'Связь по точному URL: '+m.source_id+' / '+m.external_id:'Связь с заказом не подтверждена'));
  const body=node('pre',m.plain_text);body.className='mail-plain-text';details.append(summary,body);box.append(details);
  const button=node('button');button.type='button';syncViewed(m,button);
  button.onclick=async()=>{
   if(button.disabled||pendingViewed.has(key(m)))return;pendingViewed.add(key(m));syncViewed(m,button);
   try{const r=await fetch('/api/inbox/message-viewed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message_key:key(m)})});if(!r.ok)throw Error();viewed.add(key(m));button.textContent='Просмотрено в панели';render();}
   catch{$('inbox-status').textContent='Не удалось сохранить отметку. Можно повторить; статус в Gmail не меняется.';}
   finally{pendingViewed.delete(key(m));syncViewed(messages.get(key(m))??m,button);}
  };
  box.append(button);cards.set(key(m),{box,button,provenance:provenanceLabel,delay:delayLabel});return box;
 }
 // Keep existing DOM nodes (including details.open, text selection and scroll).
 function place(id,rows){const container=$(id),nodes=rows.map(card),current=[...container.children];if(current.length!==nodes.length||nodes.some((n,i)=>n!==current[i]))container.replaceChildren(...nodes);}
 function render(){
  const all=[...messages.values()].sort((a,b)=>b.received_at.localeCompare(a.received_at));
  const linked=all.filter(m=>m.link_status==='exact_url'),unlinked=all.filter(m=>m.link_status!=='exact_url');
  place('inbox-linked',linked);place('inbox-unlinked',unlinked);
  $('inbox-count').textContent=String(all.length);
  $('inbox-unviewed').textContent=all.filter(m=>!m.panel_viewed_at&&!viewed.has(key(m))).length+' непросмотрено среди загруженных';
  $('inbox-more').hidden=!nextCursor;$('inbox-more').disabled=loading;
  if(!all.length)$('inbox-status').textContent='Сохранённых входящих пока нет. Это не означает, что новых писем или сообщений на площадках нет.';
 }
 async function load(older=false){
  if(loading||older&&!nextCursor)return;loading=true;$('inbox-more').disabled=true;
  try{
   const url='/api/inbox/unified'+(older?'?'+new URLSearchParams({cursor:nextCursor}):'');
   const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error();const payload=await r.json();
   const hasNew=payload.messages.some(m=>!messages.has(key(m))),hadMessages=messages.size>0;
   for(const m of payload.messages){const previous=messages.get(key(m));messages.set(key(m),{...m,panel_viewed_at:m.panel_viewed_at||previous?.panel_viewed_at||null});}
   if(older){loadedOlder=true;nextCursor=payload.next_cursor;}
   else if(!loadedOlder||hasNew){
    // The head may have advanced by more than one page. Never keep a cursor
    // below an unseen gap: restart traversal at the new first-page boundary.
    if(hasNew&&hadMessages&&payload.next_cursor)paginationRestarted=true;
    loadedOlder=false;nextCursor=payload.next_cursor;
   }
   if(!nextCursor)paginationRestarted=false;
   $('inbox-status').textContent=paginationRestarted?'Появились новые уведомления. Загрузка более ранних начата от новой границы: нажимайте «Загрузить более ранние», чтобы не пропустить промежуток. Уже открытые письма сохранены.':'Показаны сохранённые уведомления и наблюдённые сообщения площадок. Полнота переписки не подтверждена. Сортировка по времени события: после импорта старые сообщения могут быть ниже, загрузите более ранние.';render();
  }catch{$('inbox-status').textContent='Не удалось обновить входящие. Ранее загруженные уведомления оставлены на экране.';}
  finally{loading=false;$('inbox-more').disabled=false;}
 }
 const panel=$('inbox-panel'),openButton=$('inbox-open');
 panel.ontoggle=()=>openButton.setAttribute('aria-expanded',String(panel.open));
 openButton.onclick=()=>{panel.open=true;openButton.setAttribute('aria-expanded','true');panel.scrollIntoView({block:'start'});panel.focus({preventScroll:true});load();};
 document.addEventListener('bid-inbox-changed',()=>load());
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
 $('inbox-refresh').onclick=()=>load();$('inbox-more').onclick=()=>load(true);
 load();setInterval(()=>{if(!document.hidden)load();},15000);
})();
