// Read-only history, never prepares, approves, edits or sends an order.
(()=>{
 const $=id=>document.getElementById(id);let cursor=null,busy=false;
 const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
 async function load(older=false){
  if(busy)return;busy=true;$('sent-more').disabled=true;$('sent-refresh').disabled=true;
  try{const r=await fetch('/api/sent'+(older?'?'+new URLSearchParams({cursor}):''),{cache:'no-store'});if(!r.ok)throw Error();const data=await r.json();
   const cards=data.items.map(item=>{const card=node('article','');card.className='mail-notification';card.append(node('h3',item.title),node('p',publicationDate(item)),node('p',item.source_id+' · '+(item.provenance==='owner_observation'?'Записано владельцем':'Результат отправителя')),node('p',item.recorded_at));const details=node('details','');details.append(node('summary','Текст отклика'));const text=node('pre',item.text);text.className='mail-plain-text';details.append(text,node('p',item.observation));card.append(details);return card;});
   if(!older)$('sent-items').replaceChildren();$('sent-items').append(...cards);cursor=data.next_cursor;$('sent-more').hidden=!cursor;$('sent-status').textContent=$('sent-items').children.length?'По площадкам. Показано: '+$('sent-items').children.length:'Сохранённых отправок пока нет. Черновики здесь не показываются.';
  }catch{$('sent-status').textContent='Не удалось загрузить отправленные. Попробуйте обновить.';}finally{busy=false;$('sent-more').disabled=false;$('sent-refresh').disabled=false;}
 }
 function open(){ $('sent-panel').hidden=false;$('inbox-panel').hidden=true;$('orders-panel').hidden=true;$('section-title').textContent='Отправленные';for(const id of ['order-total','updated-at','scan-button'])$(id).hidden=true;load(); }
 $('sent-open').onclick=open;document.querySelector('[data-view="sent"]').onclick=open;$('sent-refresh').onclick=()=>load();$('sent-more').onclick=()=>load(true);
})();
