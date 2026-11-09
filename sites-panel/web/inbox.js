// Independent panel. Renders text only; never loads mail URLs or marks Gmail read.
(()=>{
 'use strict';
 const $=id=>document.getElementById(id),messages=new Map(),viewed=new Set(),cards=new Map(),pendingViewed=new Set();
 let loading=false,nextCursor=null,loadedOlder=false,paginationRestarted=false;
 const key=m=>JSON.stringify([m.mailbox,m.message_id]);
 function node(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
 function syncConversation(m,holder){
  const raw=m.conversation_url;
  const url=typeof raw==='string'&&raw.length<=128&&!/[\r\n]/.test(raw)&&/^https:\/\/vmasshtabe\.ru\/account\/view-task\?id=[1-9][0-9]{0,19}&response_id=[1-9][0-9]{0,19}$/.test(raw)?raw:null;
  if(holder.linkUrl===url)return;holder.linkUrl=url;holder.replaceChildren();
  if(url){const link=node('a','Открыть переписку на площадке');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';holder.append(link);}
 }
 function syncViewed(m,button){const seen=Boolean(m.panel_viewed_at)||viewed.has(key(m));button.disabled=seen||pendingViewed.has(key(m));button.textContent=seen?'Просмотрено в панели':'Отметить просмотренным в панели';}
 function card(m){
  const cached=cards.get(key(m));if(cached){syncViewed(m,cached.button);syncConversation(m,cached.conversation);return cached.box;}
  const box=node('article'),heading=node('h3',m.subject||'(без темы)'),details=node('details'),summary=node('summary','Показать текст уведомления');
  box.className='mail-notification';box.append(heading,node('p',m.sender),node('p','Получено: '+m.received_at),node('p','Сохранено в панели: '+(m.recorded_at||'неизвестно')));
  if(m.link_status==='exact_url')box.append(node('p',m.source_id+' · заказ '+m.external_id));
  const body=node('pre',m.plain_text);body.className='mail-plain-text';details.append(summary,body);box.append(details);
  const conversation=node('p');syncConversation(m,conversation);box.append(node('p','Это email-уведомление, не полная синхронизация переписки. Если самого ответа здесь нет, откройте переписку на площадке.'),conversation);
  const button=node('button');button.type='button';syncViewed(m,button);
  button.onclick=async()=>{
   if(button.disabled||pendingViewed.has(key(m)))return;pendingViewed.add(key(m));syncViewed(m,button);
   try{const r=await fetch('/api/inbox/viewed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mailbox:m.mailbox,message_id:m.message_id})});if(!r.ok)throw Error();viewed.add(key(m));button.textContent='Просмотрено в панели';render();}
   catch{$('inbox-status').textContent='Не удалось сохранить отметку. Можно повторить; статус в Gmail не меняется.';}
   finally{pendingViewed.delete(key(m));syncViewed(messages.get(key(m))??m,button);}
  };
  box.append(button);cards.set(key(m),{box,button,conversation});return box;
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
  if(!all.length)$('inbox-status').textContent='Сохранённых писем пока нет. Проверьте сообщения на площадке.';
 }
 async function load(older=false){
  if(loading||older&&!nextCursor)return;loading=true;$('inbox-more').disabled=true;
  try{
   const url='/api/inbox'+(older?'?'+new URLSearchParams({cursor:nextCursor}):'');
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
   $('inbox-status').textContent=paginationRestarted?'Появились новые уведомления. Загрузка более ранних начата от новой границы: нажимайте «Загрузить более ранние», чтобы не пропустить промежуток. Уже открытые письма сохранены.':'Сохранённые письма. Новые ответы на площадке могут ещё не отображаться.';render();
  }catch{$('inbox-status').textContent='Не удалось обновить входящие. Ранее загруженные уведомления оставлены на экране.';}
  finally{loading=false;$('inbox-more').disabled=false;}
 }
 const panel=$('inbox-panel'),openButton=$('inbox-open');
 panel.ontoggle=()=>openButton.setAttribute('aria-expanded',String(panel.open));
 openButton.onclick=()=>{$('sent-panel').hidden=true;panel.hidden=false;$('orders-panel').hidden=true;$('order-total').hidden=true;$('updated-at').hidden=true;$('scan-button').hidden=true;$('section-title').textContent='Входящие';panel.open=true;openButton.setAttribute('aria-expanded','true');panel.scrollIntoView({block:'start'});panel.focus({preventScroll:true});load();};
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
 $('inbox-refresh').onclick=()=>load();$('inbox-more').onclick=()=>load(true);
 load();setInterval(()=>{if(!document.hidden)load();},15000);
})();
