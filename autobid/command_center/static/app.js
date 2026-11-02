"use strict";
const $ = selector => document.querySelector(selector);
const key = item => item.source_id + ":" + item.external_id;
const nf = new Intl.NumberFormat("ru-RU");
const dt = new Intl.DateTimeFormat("ru-RU", {day:"numeric", month:"short", hour:"2-digit", minute:"2-digit", timeZone:"Europe/Moscow"});
const names = {fl:"FL.ru", freelance:"Freelance.ru", telegram:"Telegram", kwork:"Kwork", freelancer:"Freelancer.com"};
const labels = {draft:"Черновик", approved:"Одобрен", queued:"В очереди", sending:"Отправка начата", sent:"Отправлено", uncertain:"Нужна проверка"};
const messages = {
  stale_revision:"Текст уже изменён в другой вкладке или агентом. Ваши правки остаются в окне. Скопируйте их перед загрузкой сохранённого текста.",
  review_locked:"Отклик уже передан на отправку. Обновите сохранённое состояние.",
  approval_required:"Сначала одобрите текущую версию текста.",
  listing_unavailable:"Заказ закрыт или недоступен для отклика. Проверьте его на площадке.",
  source_busy:"Источник занят другим обходом. Повторите проверку позже.",
  scan_failed:"Обход не завершён. Сохранённые заказы доступны; попробуйте ещё раз.",
  interrupted:"Обход остановлен. Уже найденные заказы сохранены.",
  source_unavailable:"Площадка не предоставила данные. Состояние источника видно в настройках."
};
let state=null, online=false, stopped=false, loading=false, epoch=0, view="all";
let selectedKey=null, editorReview=null, editorBusy=false, remoteChanged=false;
let editorSession=0, preparing=false;
let monitorSaving=false, monitorError="", listSignature="", sourceSignature="";
let editorMessage="", editorError=false;
function el(tag, cls, text) {
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(text!==undefined)node.textContent=text;
  return node;
}
function icon(name) {
  const paths={
    close:"M6 6l12 12M6 18 18 6",
    edit:"M13 5l6 6M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16l-1 4Z",
    arrow:"M6 18 18 6M6 6h12v12",
    search:"M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    globe:"M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c4 4 4 14 0 18-4-4-4-14 0-18",
    refresh:"M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"
  };
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("fill","none");svg.setAttribute("aria-hidden","true");svg.classList.add("icon");
  const path=document.createElementNS(svg.namespaceURI,"path");
  path.setAttribute("d",paths[name]||paths.arrow);path.setAttribute("stroke","currentColor");path.setAttribute("stroke-width","1.65");path.setAttribute("stroke-linecap","round");path.setAttribute("stroke-linejoin","round");
  svg.append(path);return svg;
}
function stamp(value) {
  if(!value)return "ещё не было";
  const date=new Date(value);
  return Number.isNaN(date.getTime()) ? "дата неизвестна" : dt.format(date)+" МСК";
}
function hasBudget(item) { return item.budget_min!=null || item.budget_max!=null; }
function budget(item) {
  const a=item.budget_min, b=item.budget_max;
  if(a==null&&b==null)return "Бюджет не указан";
  const number=a!=null&&b!=null ? (Number(a)===Number(b)?nf.format(a):nf.format(a)+"–"+nf.format(b)) : a!=null?"от "+nf.format(a):"до "+nf.format(b);
  return number+" "+(item.currency==="RUB"?"₽":item.currency||"(валюта не указана)");
}
function bids(item) { return item.bids_count==null?"Число откликов неизвестно":nf.format(item.bids_count)+" откл."; }
function reviewFor(item) { return state?.reviews.find(row=>key(row)===key(item)); }
function selectedItem() { return state?.listings.find(item=>key(item)===selectedKey); }
function dirty() { return editorReview && $("#reply-text").value!==editorReview.text; }
function link(value) {
  try {
    const url=new URL(value);
    const hosts=["www.fl.ru","fl.ru","freelance.ru","www.freelance.ru","t.me","kwork.ru","www.freelancer.com","freelancer.com"];
    return url.protocol==="https:"&&hosts.includes(url.hostname)&&!url.username&&!url.password&&(!url.port||url.port==="443")?url.href:null;
  } catch { return null; }
}
function notice(text, error=false) {
  $("#notice").hidden=!text; $("#notice").textContent=text; $("#notice").classList.toggle("error",error);
}
function setMessage(text="", error=false) { editorMessage=text; editorError=error; renderEditor(); }
async function mutate(path, body={}) {
  if(!state||stopped||!online)throw new Error("Нет связи с центром. Дождитесь подключения.");
  epoch++;
  try {
    const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-CAIgraph-Token":state.token},body:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok)throw new Error(messages[data.error]||"Не удалось выполнить действие. Проверьте соединение и повторите.");
    return data;
  } finally { epoch++; }
}
function acceptReview(row) {
  state.reviews=state.reviews.filter(item=>key(item)!==key(row)).concat(row);
  editorReview=row; remoteChanged=false; $("#reply-text").value=row.text;
}
function renderListings() {
  if(!state)return;
  const query=$("#search").value.trim().toLocaleLowerCase("ru-RU");
  const source=$("#source-filter").value, kind=$("#kind-filter").value, priced=$("#with-budget").checked;
  const signature=JSON.stringify([state.listings,state.reviews,query,source,kind,priced,view,selectedKey]);
  if(signature===listSignature)return;
  listSignature=signature;
  const items=state.listings.filter(item=>{
    const row=reviewFor(item);
    const inView=view==="all"||(view==="draft"&&row&&["draft","approved"].includes(row.state))||
      (view==="queue"&&row&&["queued","sending","uncertain"].includes(row.state))||(view==="sent"&&row?.state==="sent");
    return inView&&(source==="all"||item.source_id===source)&&(kind==="all"||item.listing_kind===kind)&&
      (!priced||hasBudget(item))&&(!query||[item.title,item.description,...(item.requested_formats||[])].join(" ").toLocaleLowerCase("ru-RU").includes(query));
  }).sort((a,b)=>(b.first_seen||"").localeCompare(a.first_seen||"")||b.external_id.localeCompare(a.external_id,undefined,{numeric:true}));
  $("#shown-count").textContent="Показано: "+items.length;
  const fragment=document.createDocumentFragment();
  if(!items.length) {
    const empty=el("div","empty");
    empty.append(el("strong","",state.listings.length?"Здесь пока нет заказов":"Заказы ещё не собраны"),
      el("p","",state.listings.length?"Измените фильтры или подготовьте отклик в разделе «Все заказы».":"Нажмите «Проверить сейчас», чтобы прочитать объявления FL.ru."));
    fragment.append(empty);
  }
  for(const item of items) {
    const row=el("article","listing"+(selectedKey===key(item)?" is-selected":""));
    row.dataset.listingKey=key(item);
    const top=el("div","listing-top");
    const sourceName=el("span","source-label",names[item.source_id]||item.source_id);
    sourceName.prepend(icon("globe"));
    top.append(sourceName,
      el("time","",item.raw_date|| (item.published_at?stamp(item.published_at):"Дата не указана")));
    const title=el("button","listing-title",item.title||"Без названия");
    title.type="button"; title.addEventListener("click",()=>openItem(item));
    const bottom=el("div","listing-side");
    bottom.append(el("span","listing-budget"+(hasBudget(item)?"":" unknown"),budget(item)),el("span","listing-bids",bids(item)));
    const review=reviewFor(item);
    if(review)bottom.append(el("span","listing-state state-"+review.state,labels[review.state]));
    if(item.availability==="closed")bottom.append(el("span","muted","Закрыт"));
    const action=el("button","listing-action","Ответить");
    action.prepend(icon("edit"));
    action.type="button"; action.addEventListener("click",()=>openItem(item));
    bottom.append(action);
    const copy=el("div","listing-copy");
    copy.append(top,title,el("p","listing-description",item.description||"Описание доступно на площадке."));
    const formats=el("div","format-list");
    for(const format of (item.requested_formats||[]).slice(0,4))formats.append(el("span","format-tag",format));
    if(formats.childElementCount)copy.append(formats);
    row.append(copy,bottom);
    fragment.append(row);
  }
  $("#listings").replaceChildren(fragment);
  $("#listings").setAttribute("aria-busy","false");
}
async function openItem(item) {
  if(editorBusy)return;
  if(selectedKey===key(item)&&editorReview) {
    $("#details-title").focus({preventScroll:true});
    return;
  }
  if(selectedKey!==key(item)&&dirty()&&!window.confirm("Несохранённые правки будут потеряны. Открыть другой заказ?"))return;
  const session=++editorSession;
  selectedKey=key(item); editorReview=reviewFor(item)||null; remoteChanged=false; editorMessage=""; editorError=false;
  $("#reply-text").value=editorReview?.text||"";
  renderDetails(item); renderListings(); renderEditor();
  if(!$("#editor-panel").open)$("#editor-panel").showModal();
  document.body.classList.add("dialog-open");
  $("#editor-panel .editor-scroll").scrollTop=0;
  $("#details-title").focus({preventScroll:true});
  if(!editorReview&&item.listing_kind==="order"&&item.availability!=="closed"&&link(item.canonical_url)) {
    editorBusy=true;preparing=true;renderEditor();
    try {
      const row=await mutate("/api/review/prepare",{source_id:item.source_id,external_id:item.external_id});
      if(session===editorSession)acceptReview(row);
    } catch(error) {
      if(session===editorSession) { editorMessage=error.message;editorError=true; }
    } finally {
      if(session===editorSession) { editorBusy=false;preparing=false;renderEditor();renderListings(); }
    }
  }
}
function renderDetails(item) {
  $("#details-source").textContent=(names[item.source_id]||item.source_id)+(item.listing_kind==="vacancy"?" · Вакансия":" · Заказ");
  $("#details-title").textContent=item.title||"Без названия";
  $("#details-metrics").replaceChildren(el("strong","",budget(item)),el("span","",bids(item)),el("span","",({open:"Открыт",closed:"Закрыт"})[item.availability]||"Статус неизвестен"));
  const url=link(item.canonical_url);
  $("#original-link").hidden=!url;
  if(url)$("#original-link").href=url; else $("#original-link").removeAttribute("href");
  $("#description-kind").textContent=item.detail_complete?"Описание заказа":"Описание из ленты";
  $("#details-description").textContent=item.description||"Полное описание доступно на площадке.";
  $("#details-date").textContent="Последняя проверка: "+stamp(item.last_seen);
}
function renderEditor() {
  if(!selectedKey)return;
  const item=selectedItem();
  const available=item?.listing_kind==="order"&&item.availability!=="closed"&&link(item.canonical_url);
  $("#reply-area").hidden=!available&&!editorReview;
  $("#reply-unavailable").hidden=Boolean(available);
  $("#reply-unavailable").textContent=item?.availability==="closed"?
    "Заказ уже закрыт. Описание и сохранённый отклик доступны, отправка отключена.":
    "Отклики доступны для заказов. Это объявление можно посмотреть на площадке.";
  const row=editorReview, editable=row&&["draft","approved"].includes(row.state);
  $("#editor-panel .editor-footer").hidden=!row;
  const canAct=Boolean(row&&online&&!stopped&&!editorBusy&&!remoteChanged);
  const changed=dirty();
  $("#reply-text").disabled=!row;
  $("#reply-text").readOnly=!editable||editorBusy||remoteChanged;
  $("#review-state").textContent=row?labels[row.state]:"";
  $("#char-count").textContent=$("#reply-text").value.length+" / 8000";
  $("#save-state").textContent=editorBusy?"Сохраняем…":remoteChanged?"Есть новая сохранённая версия":changed?"Есть несохранённые правки":row?"Сохранено":"Подготовка текста…";
  $("#save-reply").hidden=!editable||(row.state==="approved"&&!changed);
  $("#save-reply").disabled=!canAct||!changed||!$("#reply-text").value.trim();
  $("#approve-reply").hidden=!row||!editable||(row.state==="approved"&&!changed);
  $("#approve-reply").disabled=!canAct||!available||!$("#reply-text").value.trim();
  $("#queue-reply").hidden=!row||row.state!=="approved"||Boolean(changed);
  $("#queue-reply").disabled=!canAct||!available;
  $("#cancel-reply").hidden=!row||!["queued","approved"].includes(row.state);
  $("#cancel-reply").disabled=!canAct;
  $("#cancel-reply").textContent=row?.state==="approved"?"Отменить одобрение":"Снять с отправки";
  $("#reload-reply").hidden=!remoteChanged;
  $("#reload-reply").disabled=editorBusy||!online;
  $("#review-message").hidden=!(editorMessage||remoteChanged);
  $("#review-message").textContent=remoteChanged?messages.stale_revision:editorMessage;
  $("#review-message").classList.toggle("error",remoteChanged||editorError);
  const notes={
    draft:"Это начальный черновик по данным заказа. Цену и срок можно добавить в текст.",
    approved:"Текст одобрен. «Откликнуться» передаст его в очередь для dot.",
    queued:"Отклик в очереди. Подключённый dot заберёт его при следующем запуске. До этого очередь можно отменить.",
    sending:"Агент забрал отклик. Повторная отправка заблокирована до проверки результата.",
    uncertain:"Результат отправки неизвестен. Агент должен проверить переписку на площадке; автоматического повтора не будет.",
    sent:"Агент подтвердил отправку на площадке."
  };
  $("#delivery-note").textContent=(row?notes[row.state]:"")+(row?.evidence?" "+row.evidence:"");
}
async function act(action) {
  if(editorBusy||!editorReview||remoteChanged)return;
  const session=editorSession;
  editorBusy=true; editorMessage=""; editorError=false;renderEditor();
  const identity={source_id:editorReview.source_id,external_id:editorReview.external_id};
  try {
    if(action==="save"||action==="approve"&&dirty()) {
      const row=await mutate("/api/review/save",{...identity,revision:editorReview.revision,text:$("#reply-text").value});
      if(session!==editorSession)return;
      acceptReview(row);
    }
    if(action!=="save") {
      const row=await mutate("/api/review/"+action,{...identity,revision:editorReview.revision});
      if(session!==editorSession)return;
      acceptReview(row);
    }
    if(action==="queue")editorMessage="Отклик поставлен в очередь. Отправка будет подтверждена отдельно.";
  } catch(error) {
    if(session===editorSession) { editorMessage=error.message;editorError=true; }
  } finally {
    if(session===editorSession) { editorBusy=false;renderEditor();renderListings(); }
    await refresh();
  }
}
function renderSources() {
  const signature=JSON.stringify(state.sources);
  if(signature===sourceSignature)return;
  sourceSignature=signature;
  const states={public:"Чтение доступно",authenticated:"Вход проверен",login_required:"Требуется вход",human_required:"Нужна проверка",restricted:"Доступ ограничен",error:"Ошибка чтения",unverified:"Не проверен"};
  $("#sources").replaceChildren(...state.sources.map(source=>{
    const row=el("div","source-row");
    const status=source.code==="agent_observed"?"Импортированы записи агента":source.implemented?(states[source.state]||"Не проверен"):"Через dot · ещё не подключён";
    row.append(el("span","",source.name),el("span","source-state",status));
    return row;
  }));
  const chosen=$("#source-filter").value;
  $("#source-filter").replaceChildren(new Option("Все источники","all"),...state.sources.map(source=>new Option(source.name,source.id)));
  $("#source-filter").value=chosen;
}
function render() {
  $("#connection").textContent="Центр работает";$("#connection").classList.remove("offline");
  $("#scan-button").disabled=state.scan.running||stopped;
  $("#scan-button").replaceChildren(icon("refresh"),document.createTextNode(state.scan.running?"Проверяем FL.ru…":"Проверить сейчас"));
  $("#order-total").textContent=state.summary.orders;
  $("#stop-button").disabled=stopped;
  const success=state.sources.find(item=>item.id==="fl")?.last_success;
  $("#updated-at").textContent="Последний обход FL.ru: "+stamp(success);
  if(state.scan.running)notice("Читаем объявления FL.ru. Сохранённые заказы доступны.");
  else if(state.scan.error)notice(messages[state.scan.error]||"Не удалось обновить заказы.",true);
  else if(state.scan.result)notice("Обход завершён. Новых: "+state.scan.result.new+", обновлено: "+state.scan.result.updated+".");
  else notice("");
  if(!monitorSaving) {
    $("#monitor-enabled").checked=state.monitor.enabled;$("#monitor-enabled").disabled=false;
    $("#interval").value=String(state.monitor.interval_minutes);$("#interval").disabled=false;
  }
  $("#monitor-status").textContent=monitorError||(state.monitor.enabled?"Следующая проверка: "+stamp(state.monitor.next_run_at):"Автообновление выключено");
  $("#monitor-status").classList.toggle("error",Boolean(monitorError));
  $("#agent-status").textContent=state.agent.last_seen?"Последнее обращение к очереди: "+stamp(state.agent.last_seen)+". Это время обращения, а не проверка постоянного соединения.":"dot ещё не обращался к очереди. Облачный агент не подключён.";
  $("#draft-count").textContent=state.reviews.filter(row=>["draft","approved"].includes(row.state)).length;
  $("#queue-count").textContent=state.reviews.filter(row=>["queued","sending","uncertain"].includes(row.state)).length;
  $("#sent-count").textContent=state.reviews.filter(row=>row.state==="sent").length;
  renderSources();renderListings();
  if(selectedKey) {
    const item=selectedItem();
    if(item)renderDetails(item);
    const incoming=state.reviews.find(row=>key(row)===selectedKey);
    if(incoming&&!editorBusy&&JSON.stringify(incoming)!==JSON.stringify(editorReview)) {
      if(dirty())remoteChanged=true;
      else acceptReview(incoming);
    }
    renderEditor();
  }
}
async function refresh() {
  if(stopped||loading)return;
  loading=true;const requestEpoch=epoch;
  try {
    const response=await fetch("/api/state",{cache:"no-store"});
    if(!response.ok)throw new Error();
    const next=await response.json();
    if(stopped||requestEpoch!==epoch)return;
    state=next;online=true;render();
  } catch {
    if(stopped)return;
    online=false;$("#connection").textContent="Нет соединения";$("#connection").classList.add("offline");
    for(const selector of ["#scan-button","#monitor-enabled","#interval","#stop-button"])$(selector).disabled=true;
    notice("Связь с центром потеряна. Запустите его ярлыком CAIgraph; несохранённый текст остаётся в окне.",true);
    renderEditor();
  } finally { loading=false; }
}
$("#settings-button").addEventListener("click",()=>{
  const hidden=!$("#settings").hidden;$("#settings").hidden=hidden;$("#settings-button").setAttribute("aria-expanded",String(!hidden));
});
for(const selector of ["#search","#source-filter","#kind-filter","#with-budget"])$(selector).addEventListener(selector==="#search"?"input":"change",renderListings);
for(const button of document.querySelectorAll("[data-view]"))button.addEventListener("click",()=>{
  view=button.dataset.view;
  $("#rail-orders").classList.toggle("active",view!=="queue");
  $("#rail-queue").classList.toggle("active",view==="queue");
  for(const item of document.querySelectorAll("[data-view]")) {item.classList.toggle("selected",item===button);item.setAttribute("aria-pressed",String(item===button));}
  renderListings();
});
$("#reply-text").addEventListener("input",()=>{editorMessage="";renderEditor();});
for(const action of ["save","approve","queue","cancel"])$("#"+action+"-reply").addEventListener("click",()=>act(action));
$("#reload-reply").addEventListener("click",()=>{
  const row=state.reviews.find(item=>key(item)===selectedKey);
  if(row)acceptReview(row);
  setMessage();
});
function closeEditor() {
  const warning=editorBusy&&!preparing?
    "Действие ещё выполняется. Закрыть окно? Уже отправленный запрос продолжит выполняться.":
    dirty()?"Несохранённые правки будут потеряны. Закрыть отклик?":"";
  if(warning&&!window.confirm(warning))return;
  const previousKey=selectedKey;
  ++editorSession;preparing=false;editorBusy=false;selectedKey=null;editorReview=null;remoteChanged=false;
  $("#editor-panel").close();document.body.classList.remove("dialog-open");renderListings();
  const listing=[...document.querySelectorAll(".listing")].find(row=>row.dataset.listingKey===previousKey);
  (listing?.querySelector(".listing-action")||$("#search")).focus({preventScroll:true});
}
$("#close-details").addEventListener("click",closeEditor);
$("#editor-panel").addEventListener("cancel",event=>{event.preventDefault();closeEditor();});
let backdropPointer=false;
function outsideEditor(event) {
  const box=$("#editor-panel").getBoundingClientRect();
  return event.target===$("#editor-panel")&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom);
}
$("#editor-panel").addEventListener("pointerdown",event=>{backdropPointer=outsideEditor(event);});
$("#editor-panel").addEventListener("click",event=>{
  if(backdropPointer&&outsideEditor(event))closeEditor();
  backdropPointer=false;
});
window.addEventListener("beforeunload",event=>{if(dirty()){event.preventDefault();event.returnValue="";}});
$("#scan-button").addEventListener("click",async()=>{
  $("#scan-button").disabled=true;
  try {await mutate("/api/scan");await refresh();}
  catch(error){notice(error.message,true);$("#scan-button").disabled=!online||stopped;}
});
async function saveMonitor() {
  monitorError="";monitorSaving=true;$("#monitor-enabled").disabled=true;$("#interval").disabled=true;
  try {await mutate("/api/monitor",{enabled:$("#monitor-enabled").checked,interval_minutes:Number($("#interval").value)});}
  catch(error){monitorError=error.message;}
  finally {monitorSaving=false;await refresh();}
}
$("#monitor-enabled").addEventListener("change",saveMonitor);
$("#interval").addEventListener("change",saveMonitor);
$("#stop-button").addEventListener("click",async()=>{
  if(dirty()&&!window.confirm("В окне есть несохранённый текст. Выключить центр?"))return;
  try {
    await mutate("/api/stop");stopped=true;online=false;$("#connection").textContent="Центр выключен";$("#connection").classList.add("offline");
    for(const selector of ["#scan-button","#stop-button","#monitor-enabled","#interval"])$(selector).disabled=true;
    notice("Центр выключен. Данные сохранены. Для запуска откройте ярлык CAIgraph.");renderEditor();
  } catch(error){notice(error.message,true);}
});
$("#rail-orders").addEventListener("click",()=>document.querySelector('[data-view="all"]').click());
$("#rail-queue").addEventListener("click",()=>document.querySelector('[data-view="queue"]').click());
$("#rail-settings").addEventListener("click",()=>$("#settings-button").click());
$("#close-details").prepend(icon("close"));
$("#original-link").append(icon("arrow"));
$(".search").prepend(icon("search"));
refresh();
setInterval(refresh,2500);
