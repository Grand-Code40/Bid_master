// Status refresh reads saved diagnostics only. Upstream reads require owner click.
(()=>{
 'use strict';
 const $=id=>document.getElementById(id),node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const names={gmail:'Gmail',fl:'FL.ru',freelance:'Freelance.ru',vmasshtabe:'В Масштабе',weblancer:'Weblancer'};
 const labels={not_configured:'Не подключён',configuration_required:'Нужно настроить почту и ограниченный фильтр',not_checked:'Настроен, ещё не проверен',ready:'API доступен для заданного фильтра',partial:'API доступен, обход ещё не завершён',busy:'Проверка выполняется',syncing:'Проверка выполняется',resync_required:'Нужен новый ограниченный обход',configuration_error:'Провайдер отклонил настройку фильтра',error:'Ошибка проверки',caller_observed_only:'Прямое чтение не подключено; доступны записанные наблюдения',paused:'На паузе — получение отключено'};
 const errors={unauthorized:'Нужна повторная авторизация',forbidden:'Недостаточно прав',rate_limited:'Ограничение частоты запросов',timeout:'Истекло время проверки',account_mismatch:'Подключён другой почтовый аккаунт',resync_required:'Курсор устарел; следующая ручная проверка начнёт ограниченный обход заново',configuration_error:'Проверьте настройку фильтра',provider_unavailable:'Провайдер недоступен',invalid_provider_response:'Не удалось проверить ответ провайдера',mail_conflict:'Наблюдение письма расходится с ранее сохранённым',storage_error:'Не удалось сохранить результат'};
 let channels=[],reading=false,syncing=false;
 const stamp=at=>at?new Date(at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК':'не было';
 function cooldown(g){const until=Date.parse(g?.last_attempt)+Number(g?.retry_after_seconds)*1000;return g?.error_code==='rate_limited'&&Number.isFinite(until)&&Date.now()<until;}
 function allowed(){const g=channels.find(c=>c.channel==='gmail');return g&&!['not_configured','configuration_required','paused'].includes(g.status)&&!cooldown(g);}
 function render(){
  $('inbox-channels').replaceChildren(...channels.map(c=>{
   const box=node('article');box.className='inbox-channel';box.append(node('h3',names[c.channel]??c.channel),node('p',labels[c.status]??'Состояние неизвестно'));
   if(c.channel==='gmail'){
    box.append(node('p','Режим: ручное получение. Последняя попытка: '+stamp(c.last_attempt)+'. Полный обход заданного фильтра: '+stamp(c.last_success)+'.'));
    if(c.error_code)box.append(node('p',errors[c.error_code]??'Не удалось проверить канал'));
    if(c.retry_after_seconds!=null)box.append(node('p','Повторная проверка разрешена не раньше чем через '+c.retry_after_seconds+' с после указанной попытки.'));
    box.append(node('p',(c.has_more?'Есть ещё страницы; нажмите получение повторно. ':'')+'Сохранено за проверку: '+(c.imported??0)+'. Пропущено (безопасность, формат или конфликт): '+(c.skipped??0)+'. Охват: только ограниченные email-уведомления, не все чаты площадок.'));
    const skipLabels={mail_conflict:'Конфликт с сохранённым отрывком',mail_auth_content:'Письмо авторизации',mail_secret_content:'Распознаны учётные сведения',mail_unsafe_link:'Небезопасная ссылка',malformed_mime:'Неподдержанный формат',no_plain_text:'Нет доступного простого текста',invalid_mail:'Неподдержанная запись'};
    const omissions=Object.entries(c.skip_reasons??{}).filter(([,count])=>Number.isSafeInteger(count)&&count>0).map(([reason,count])=>(skipLabels[reason]??'Неподдержанная запись')+': '+count);
    if(omissions.length)box.append(node('p','Причины пропуска: '+omissions.join('; ')));
    const age=Date.now()-Date.parse(c.last_success);box.append(node('p',Number.isFinite(age)&&age>=0?'С завершения полного обхода: '+Math.floor(age/60000)+' мин.':'Свежесть полного обхода пока неизвестна.'));
   }
   return box;
  }));
  $('inbox-sync-gmail').disabled=reading||syncing||!allowed();
 }
 async function load(){
  if(reading)return;reading=true;render();
  try{const r=await fetch('/api/inbox/channels',{cache:'no-store'});if(!r.ok)throw Error();const data=await r.json();if(!Array.isArray(data.channels))throw Error();channels=data.channels;}
  catch{$('inbox-sync-status').textContent='Не удалось обновить состояния каналов. Ранее показанные сведения сохранены.';}
  finally{reading=false;render();}
 }
 $('inbox-sync-gmail').onclick=async()=>{
  if(syncing||reading||!allowed())return;syncing=true;render();$('inbox-sync-status').textContent='Получаем ограниченную страницу писем Gmail…';
  try{
   const r=await fetch('/api/inbox/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:'gmail'})});if(!r.ok)throw Error();const result=await r.json();
   if(result.channel!=='gmail')throw Error();channels=channels.map(c=>c.channel==='gmail'?result:c);
   $('inbox-sync-status').textContent=result.status==='ready'?'Проверка заданного фильтра завершена. Это не подтверждает полноту переписки площадок.':result.status==='partial'?'Получена одна страница. Для продолжения нажмите получение ещё раз.':'Состояние проверки: '+(errors[result.error_code]??labels[result.status]??'не подтверждено');
   if(typeof Event==='function')document.dispatchEvent(new Event('bid-inbox-changed'));
  }catch{$('inbox-sync-status').textContent='Не удалось получить письма. Сохранённые входящие остаются в панели.';}
  finally{syncing=false;render();}
 };
 load();setInterval(()=>{if(!document.hidden)load();},15000);
})();
