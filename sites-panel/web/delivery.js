// Separate accounting UI: never copies a draft as observed evidence or sends it.
(()=>{
 'use strict';
 const $=id=>document.getElementById(id);
 const fields=['delivery-text','delivery-observation','delivery-observed-at','delivery-url','delivery-reason'];
 let listings=[],record=null,busy=false,loaded=false,pending=null,generation=0;
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const selected=()=>listings.find(x=>x.external_id===$('delivery-order').value);
 function sync(){
  $('delivery-order').disabled=busy||Boolean(pending);$('delivery-refresh').disabled=busy||Boolean(pending);
  for(const id of fields)$(id).disabled=busy||Boolean(pending)||!loaded;
  $('delivery-observe').disabled=busy||!loaded||Boolean(pending&&pending.action!=='observe')||(!pending&&record?.status==='observed');
  $('delivery-error').disabled=busy||!loaded||Boolean(pending&&pending.action!=='mark-error')||(!pending&&!record);
  $('delivery-observe').textContent=pending?.action==='observe'?'Повторить тот же запрос':'Записать наблюдение';
  $('delivery-error').textContent=pending?.action==='mark-error'?'Повторить ту же отметку':'Пометить учётную запись ошибочной';
 }
 function render(payload){
  record=payload.record;
  $('delivery-status').textContent=record?(record.status==='erroneous'?'Учётная запись помечена ошибочной.':'Сохранено наблюдение владельца.')+' Эта отметка не отменяет и не подтверждает фактическую отправку. Защита от новых автоматических отправок сохраняется; уже начатая отправка не прерывается. Это не подтверждение прочтения.':'Наблюдений в новом журнале нет. Это не доказательство отсутствия отправки. Старые записи сохранены в карточках.';
  $('delivery-history').replaceChildren(...payload.events.map(event=>{
   const box=node('article'),d=event.data;box.className='mail-notification';
   box.append(node('h3','Версия '+d.version+' · '+(event.action==='observe'?'Наблюдение':'Ошибка учёта')),node('p','Записано: '+event.at));
   box.append(node('p','Заказ: '+d.details.canonical_url),node('p','Источник наблюдения: '+d.details.delivery_url),node('p','Наблюдалось: '+d.details.observed_at),node('p',d.details.observation));
   const exact=node('pre',d.details.text);exact.className='mail-plain-text';box.append(exact);
   if(d.reason)box.append(node('p','Причина: '+d.reason));return box;
  }));
 }
 async function load(){
  const item=selected();if(!item||pending)return;const current=++generation;busy=true;loaded=false;sync();
  try{const r=await fetch('/api/delivery-log?'+new URLSearchParams({source_id:item.source_id,external_id:item.external_id}),{cache:'no-store'});if(!r.ok)throw Error();const payload=await r.json();if(current!==generation)return;render(payload);loaded=true;}
  catch{if(current===generation)$('delivery-status').textContent='Не удалось прочитать журнал. Запись отключена до успешного обновления.';}
  finally{if(current===generation){busy=false;sync();}}
 }
 async function save(action){
  if(busy||!loaded||!selected()||pending&&pending.action!==action)return;
  if(!pending){
   if(action==='observe'&&record?.status==='observed'||action==='mark-error'&&!record)return;
   const item=selected(),args={source_id:item.source_id,external_id:item.external_id,version:record?.version??0,operation_id:crypto.randomUUID()};
   if(action==='observe')args.details={text:$('delivery-text').value,observation:$('delivery-observation').value,observed_at:$('delivery-observed-at').value,canonical_url:item.canonical_url,delivery_url:$('delivery-url').value};
   else args.reason=$('delivery-reason').value;
   const question=action==='observe'?'Записать именно наблюдённый отправленный текст? Ошибку учёта можно отметить отдельно. Исходный текст и вся история сохранятся в аудите без возможности удаления. Повторная автоматическая отправка останется заблокированной даже после исправления; снять защиту здесь нельзя. Эта отметка не отменяет и не подтверждает фактическую отправку.\n\n'+args.details.text+'\n\nИсточник: '+args.details.delivery_url:'Пометить только учётную запись ошибочной? Эта отметка не отменяет и не подтверждает фактическую отправку. Исходный текст и вся история сохранятся в аудите без возможности удаления. Защита от повторной автоматической отправки сохраняется; снять её здесь нельзя.\n\nПричина: '+args.reason;
   if(!confirm(question))return;pending={action,body:JSON.stringify(args)};
  }
  busy=true;sync();
  try{
   const r=await fetch('/api/delivery-log/'+pending.action,{method:'POST',headers:{'Content-Type':'application/json'},body:pending.body});
   if(!r.ok){if([400,401,403,404,409,413,415].includes(r.status)){pending=null;loaded=false;$('delivery-status').textContent='Запрос отклонён. Поля сохранены; обновите журнал перед новой попыткой.';return;}throw Error();}
   record=await r.json();pending=null;
   // Refresh full audit after success; inputs remain intact for copying.
   await load();
  }catch{$('delivery-status').textContent='Результат записи неизвестен. Поля сохранены. Повторите тот же запрос: ключ операции не изменится.';}
  finally{busy=false;sync();}
 }
 $('delivery-order').onchange=()=>{if(busy||pending)return;record=null;$('delivery-history').replaceChildren();for(const id of fields)$(id).value='';load();};
 $('delivery-refresh').onclick=()=>load();$('delivery-observe').onclick=()=>save('observe');$('delivery-error').onclick=()=>save('mark-error');
 async function init(){busy=true;sync();try{const r=await fetch('/api/state',{cache:'no-store'});if(!r.ok)throw Error();const data=await r.json();listings=(data.delivery_listings??data.listings).filter(x=>x.source_id==='vmasshtabe');const empty=node('option','Выберите заказ');empty.value='';$('delivery-order').replaceChildren(empty,...listings.map(x=>{const option=node('option',x.title+' · '+x.external_id);option.value=x.external_id;return option;}));$('delivery-status').textContent='Выберите заказ В Масштабе. Список включает закрытые заказы и ограничен последними 1000 карточками В Масштабе. Для отсутствующего заказа доступен точный MCP readback.';}catch{$('delivery-status').textContent='Не удалось загрузить список заказов. Обновите страницу.';}finally{busy=false;sync();}}
 init();
})();
