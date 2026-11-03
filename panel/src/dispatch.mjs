// Owner-driven orchestration. The service binding is trusted server config, not
// a browser proxy. submit is invoked once; HTTP retries only read durable state.
import {ReviewStore} from './store.mjs';
import {confirmDelivery,claimDelivery} from './sender.mjs';
import {transition,publicReview} from './review.mjs';
import {validatedCanonicalUrl} from './urls.mjs';
const fail=code=>{throw new Error(code);};
const fields=['source_id','external_id','canonical_url','text','revision','sender_account','recipient_account','price','currency','deadline','credit_cost'];
const operation=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const id=()=>crypto.randomUUID().replaceAll('-','');
const object=(value,required,optional=[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))fail('invalid_dispatch');};
const clock=now=>{if(typeof now!=='string'||!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now)fail('invalid_dispatch');};
const source=value=>{if(value==='weblancer')fail('source_paused');if(!['fl','freelance'].includes(value))fail('source_not_supported');};
function identity(args){source(args.source_id);if(typeof args.external_id!=='string'||!/^[1-9][0-9]{0,19}$/.test(args.external_id)||!Number.isSafeInteger(args.revision)||args.revision<1)fail('invalid_dispatch');}
async function hash(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),x=>x.toString(16).padStart(2,'0')).join('');}
const exact=(a,b)=>a&&fields.every(k=>a[k]===b[k])&&Object.keys(a).length===fields.length;
const fresh=(at,now,max=60000)=>typeof at==='string'&&Number.isFinite(Date.parse(at))&&Date.parse(now)>=Date.parse(at)&&Date.parse(now)-Date.parse(at)<=max;
function remoteOrigin(env){
 try{
  const u=new URL(env.SENDER_SERVICE_URL);
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash||u.pathname!=='/'||!u.hostname.includes('.')||u.hostname.includes(':')||/^[0-9.]+$/.test(u.hostname)||/(?:^|\.)(?:localhost|local|internal)$/.test(u.hostname))return null;
  if(typeof env.SENDER_SERVICE_TOKEN!=='string'||env.SENDER_SERVICE_TOKEN.length<32||env.SENDER_SERVICE_TOKEN.length>8192||/[\r\n]/.test(env.SENDER_SERVICE_TOKEN))return null;
  return u.origin;
 }catch{return null;}
}
const transportConfiguration=env=>JSON.stringify(typeof env.SENDER_SERVICE?.fetch==='function'?['binding',env.SENDER_TRANSPORT_ID,env.SENDER_BINDING_REVISION??'1']:['https',env.SENDER_TRANSPORT_ID,remoteOrigin(env)]);
export function senderStatus(env){
 const enabled=env.SENDER_ENABLED==='true',binding=typeof env.SENDER_SERVICE?.fetch==='function';
 const configured=(binding||Boolean(remoteOrigin(env)))&&typeof env.SENDER_TRANSPORT_ID==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(env.SENDER_TRANSPORT_ID);
 return {enabled,configured,connected:false,status:!enabled?'disabled':configured?'configured_unverified':'not_configured',mode:binding?'service_binding':'https_executor',supported_sources:['fl','freelance'],verification:'executor_readback',background_dispatch:false};
}
function transport(env){
 const status=senderStatus(env);if(!status.enabled)fail('sender_disabled');if(!status.configured)fail('sender_not_configured');
 if(typeof env.SENDER_SERVICE?.fetch==='function')return env.SENDER_SERVICE;
 const origin=remoteOrigin(env);
 return {fetch:request=>globalThis.fetch(new Request(origin+new URL(request.url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.SENDER_SERVICE_TOKEN},body:request.body,duplex:'half',redirect:'error',signal:request.signal}))};
}
async function service(env,path,payload){
 const binding=transport(env),controller=new AbortController();let timer;
 try{
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('transport_unavailable'));},15000);});
  const response=await Promise.race([Promise.resolve().then(()=>binding.fetch(new Request('https://sender.internal'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal}))),timeout]);
  if(!response?.ok||!/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type')??''))fail('transport_unavailable');
  const reader=response.body?.getReader();if(!reader)fail('transport_unavailable');const chunks=[];let length=0;
  while(true){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;length+=part.value.byteLength;if(length>40000){await reader.cancel();fail('transport_unavailable');}chunks.push(part.value);}
  const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }catch{fail('transport_unavailable');}finally{clearTimeout(timer);}
}
async function guardedReview(db,owner,args){
 const store=new ReviewStore(db),old=await store.get(owner,args.source_id,args.external_id);if(!old)fail('review_not_found');
 if(old.data.revision!==args.revision)fail('stale_revision');
 if(!['approved','queued'].includes(old.data.state)||old.data.manual_delivery)fail('review_locked');
 if(old.data.approved_revision!==old.data.revision)fail('approval_required');
 const item=await store.listing(owner,args.source_id,args.external_id);
 if(!item||item.listing_kind!=='order'||item.availability==='closed'||item.canonical_url!==old.data.canonical_url)fail('listing_unavailable');
 if(validatedCanonicalUrl(args.source_id,args.external_id,item.canonical_url)!==item.canonical_url)fail('listing_unavailable');
 if(await db.prepare('SELECT 1 FROM delivery_records WHERE owner_id=? AND source_id=? AND external_id=?').bind(owner,args.source_id,args.external_id).first())fail('delivery_guard');
 return old;
}
export async function preflightDelivery(db,owner,args,env,now){
 const readNow=typeof now==='function'?now:()=>now;now=readNow();
 object(args,['source_id','external_id','revision']);identity(args);clock(now);transport(env);
 const old=await guardedReview(db,owner,args),d=old.data.delivery_confirmation;if(!d)fail('delivery_confirmation_required');
 const details=Object.fromEntries(fields.map(k=>[k,d[k]]));confirmDelivery(old.data,details,{role:'owner',now});
 const proof=await service(env,'/inspect',{version:1,snapshot:details});
 now=readNow();clock(now);
 object(proof,['version','transport_id','details','authenticated','availability','already_sent','form_supported','idempotency_supported','verified_at']);
 if(proof.version!==1||proof.transport_id!==env.SENDER_TRANSPORT_ID||!exact(proof.details,details)||proof.authenticated!==true||proof.availability!=='open'||proof.already_sent!==false||proof.form_supported!==true||proof.idempotency_supported!==true||!fresh(proof.verified_at,now))fail('preflight_mismatch');
 const preflight_id=id(),expires_at=new Date(Date.parse(now)+120000).toISOString();
 const confirmation_digest=await hash([preflight_id,details,proof.transport_id,proof.verified_at,expires_at,transportConfiguration(env)]);
 const data={preflight_id,details,transport_id:proof.transport_id,transport_configuration:transportConfiguration(env),verified_at:proof.verified_at,expires_at,confirmation_digest};
 await db.prepare('INSERT INTO delivery_preflights VALUES (?,?,?,?,?,?,?,?,NULL,?)').bind(owner,preflight_id,args.source_id,args.external_id,args.revision,old.storage_version,JSON.stringify(data),expires_at,now).run();
 const {transport_configuration,...visible}=data;return visible;
}
async function attempt(db,owner,operation_id){const row=await db.prepare('SELECT * FROM delivery_attempts WHERE owner_id=? AND operation_id=?').bind(owner,operation_id).first();return row?{...row,data:JSON.parse(row.data)}:null;}
function publicAttempt(row){const d=row.data;return {operation_id:row.operation_id,source_id:row.source_id,external_id:row.external_id,revision:row.revision,status:d.status,started_at:d.started_at,updated_at:d.updated_at,verification:d.verification??null,response_id:d.response_id??null,evidence:d.evidence??null};}
async function output(db,owner,row){const review=await new ReviewStore(db).get(owner,row.source_id,row.external_id);return {review:review?publicReview(review.data):null,attempt:publicAttempt(row)};}
async function finish(db,owner,claimed,env,now){
 const readNow=typeof now==='function'?now:()=>now;now=readNow();clock(now);
 let current=await attempt(db,owner,claimed.operation_id);if(['sent','not_sent'].includes(current.data.status))return output(db,owner,current);
 if(current.data.transport_id!==env.SENDER_TRANSPORT_ID||current.data.transport_configuration!==transportConfiguration(env))fail('transport_changed');
 let outcome='uncertain',evidence='Результат не подтверждён. Повторная отправка заблокирована.',delivery_url=null,response_id=null;
 try{
  const receipt=await service(env,'/readback',{version:1,operation_id:current.operation_id,claim_token:current.data.claim_token,transport_id:current.data.transport_id,snapshot:current.data.snapshot});
  now=readNow();clock(now);
  if(receipt?.version===1&&receipt.transport_id===current.data.transport_id&&exact(receipt.details,current.data.snapshot)&&fresh(receipt.observed_at,now)){
   if(receipt.status==='published'&&typeof receipt.response_id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(receipt.response_id)&&typeof receipt.delivery_url==='string'){
    // Let the existing same-host delivery URL validator enforce safe evidence URLs.
    const review=(await new ReviewStore(db).get(owner,current.source_id,current.external_id)).data;
    delivery_url=transition(review,{action:'result',outcome:'sent',claim_token:current.data.claim_token,evidence:'Matching own response read back.',delivery_url:receipt.delivery_url},{role:'agent',now}).delivery_url;
    outcome='sent';response_id=receipt.response_id;evidence='Точный отклик '+response_id+' опубликован; проверен доверенным исполнителем по исходящим. Прочтение заказчиком не подтверждено.';
   }else if(receipt.status==='not_submitted'&&receipt.proof==='durable_executor_ledger'&&receipt.action_started===false&&receipt.terminal===true){outcome='not_sent';evidence='Устойчивый журнал доверенного исполнителя подтверждает: внешнее действие не начиналось.';}
  }
 }catch{ /* Transport/receipt failures never imply permission to retry. */ }
 current=await attempt(db,owner,claimed.operation_id);if(['sent','not_sent'].includes(current.data.status))return output(db,owner,current);
 const old=await new ReviewStore(db).get(owner,current.source_id,current.external_id);
 if(!old||!['sending','uncertain'].includes(old.data.state)||old.data.claim_token!==current.data.claim_token)fail('review_locked');
 const next=transition(old.data,{action:'result',outcome,claim_token:current.data.claim_token,evidence,delivery_url},{role:'agent',now});
 const resultOperation='dispatch_result_'+id(),data={...current.data,status:outcome,updated_at:now,evidence,response_id,verification:outcome==='sent'?'executor_readback':outcome==='not_sent'?'executor_ledger':null};
 await db.batch([
  db.prepare('UPDATE reviews SET data=?,storage_version=storage_version+1,last_operation=? WHERE owner_id=? AND source_id=? AND external_id=? AND storage_version=?').bind(JSON.stringify(next),resultOperation,owner,current.source_id,current.external_id,old.storage_version),
  db.prepare('UPDATE delivery_attempts SET data=? WHERE owner_id=? AND operation_id=? AND EXISTS (SELECT 1 FROM reviews WHERE owner_id=? AND source_id=? AND external_id=? AND last_operation=?)').bind(JSON.stringify(data),owner,current.operation_id,owner,current.source_id,current.external_id,resultOperation),
  db.prepare('INSERT INTO review_events SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM reviews WHERE owner_id=? AND source_id=? AND external_id=? AND last_operation=?)').bind(owner,resultOperation,current.source_id,current.external_id,'dispatch_'+outcome,now,JSON.stringify(publicReview(next)),await hash([current.operation_id,outcome,response_id]),owner,current.source_id,current.external_id,resultOperation)
 ]);
 return output(db,owner,await attempt(db,owner,current.operation_id));
}
export async function sendDelivery(db,owner,args,env,now){
 const readNow=typeof now==='function'?now:()=>now;now=readNow();
 object(args,['source_id','external_id','revision','operation_id','preflight_id','confirmation_digest']);identity(args);clock(now);
 if(!operation(args.operation_id)||!operation(args.preflight_id)||typeof args.confirmation_digest!=='string')fail('invalid_dispatch');
 const requestHash=await hash([args.source_id,args.external_id,args.revision,args.preflight_id,args.confirmation_digest]);
 const existing=await attempt(db,owner,args.operation_id);
 if(existing){if(existing.request_hash!==requestHash)fail('operation_conflict');return output(db,owner,existing);}
 let acquired=false;
 try {
 transport(env);
 if(await db.prepare('SELECT 1 FROM review_events WHERE owner_id=? AND operation_id=?').bind(owner,args.operation_id).first())fail('operation_conflict');
 const old=await guardedReview(db,owner,args);
 const saved=await db.prepare('SELECT * FROM delivery_preflights WHERE owner_id=? AND id=?').bind(owner,args.preflight_id).first();
 if(!saved||saved.source_id!==args.source_id||saved.external_id!==args.external_id||saved.revision!==args.revision)fail('preflight_required');
 const p=JSON.parse(saved.data);
 if(saved.used_by)fail('preflight_used');if(saved.expires_at<=now)fail('preflight_expired');
 if(saved.storage_version!==old.storage_version)fail('stale_revision');
 if(p.confirmation_digest!==args.confirmation_digest||p.transport_id!==env.SENDER_TRANSPORT_ID||p.transport_configuration!==transportConfiguration(env))fail('confirmation_mismatch');
 const claim_token=id();
 const next=claimDelivery({...old.data,state:'queued'},{role:'sender',enabled:true,now,newClaimToken:claim_token,session:{source_id:args.source_id,sender_account:p.details.sender_account,authenticated:true,verified_at:p.verified_at},preflight:{...p.details,verified_at:p.verified_at,availability:'open',already_sent:false,form_supported:true}});
 next.delivery_attempt_id=args.operation_id;
 const data={status:'sending',started_at:now,updated_at:now,snapshot:p.details,transport_id:p.transport_id,transport_configuration:p.transport_configuration,claim_token};
 const result=await db.batch([
  db.prepare("INSERT INTO delivery_attempts SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM reviews r JOIN listings l USING(owner_id,source_id,external_id) WHERE r.owner_id=? AND r.source_id=? AND r.external_id=? AND r.storage_version=? AND json_extract(r.data,'$.state') IN ('approved','queued') AND json_extract(r.data,'$.approved_revision')=? AND json_extract(l.data,'$.listing_kind')='order' AND json_extract(l.data,'$.availability')!='closed' AND json_extract(l.data,'$.canonical_url')=?) AND EXISTS (SELECT 1 FROM delivery_preflights WHERE owner_id=? AND id=? AND used_by IS NULL AND expires_at>?) AND NOT EXISTS (SELECT 1 FROM delivery_records WHERE owner_id=? AND source_id=? AND external_id=?) AND NOT EXISTS (SELECT 1 FROM review_events WHERE owner_id=? AND operation_id=?) ON CONFLICT DO NOTHING").bind(owner,args.operation_id,args.source_id,args.external_id,args.revision,args.preflight_id,requestHash,JSON.stringify(data),owner,args.source_id,args.external_id,old.storage_version,args.revision,old.data.canonical_url,owner,args.preflight_id,now,owner,args.source_id,args.external_id,owner,args.operation_id),
  db.prepare("UPDATE reviews SET data=?,storage_version=storage_version+1,last_operation=? WHERE owner_id=? AND source_id=? AND external_id=? AND storage_version=? AND EXISTS (SELECT 1 FROM delivery_attempts WHERE owner_id=? AND operation_id=? AND json_extract(data,'$.claim_token')=?)").bind(JSON.stringify(next),args.operation_id,owner,args.source_id,args.external_id,old.storage_version,owner,args.operation_id,claim_token),
  db.prepare('UPDATE delivery_preflights SET used_by=? WHERE owner_id=? AND id=? AND EXISTS (SELECT 1 FROM reviews WHERE owner_id=? AND source_id=? AND external_id=? AND last_operation=? AND storage_version=?)').bind(args.operation_id,owner,args.preflight_id,owner,args.source_id,args.external_id,args.operation_id,old.storage_version+1),
  db.prepare('INSERT INTO review_events SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM reviews WHERE owner_id=? AND source_id=? AND external_id=? AND last_operation=? AND storage_version=?) AND NOT EXISTS (SELECT 1 FROM review_events WHERE owner_id=? AND operation_id=?)').bind(owner,args.operation_id,args.source_id,args.external_id,'dispatch_claim',now,JSON.stringify(publicReview(next)),requestHash,owner,args.source_id,args.external_id,args.operation_id,old.storage_version+1,owner,args.operation_id)
 ]);
 acquired=result[0].meta.changes===1;
 const claimed=await attempt(db,owner,args.operation_id);
 if(result[0].meta.changes!==1){if(claimed){if(claimed.request_hash!==requestHash)fail('operation_conflict');return output(db,owner,claimed);}fail('stale_revision');}
 if(result[1].meta.changes!==1)fail('review_locked');
 try{await service(env,'/submit',{version:1,operation_id:args.operation_id,claim_token,preflight_id:args.preflight_id,transport_id:p.transport_id,snapshot:p.details});}catch{ /* Reconcile; never submit again. */ }
 return await finish(db,owner,claimed,env,readNow);
 }catch(error){
  if(!acquired){const committed=await attempt(db,owner,args.operation_id);if(committed){if(committed.request_hash!==requestHash)fail('operation_conflict');return output(db,owner,committed);}error.attempt_started=false;}
  throw error;
 }
}
export async function recoverDelivery(db,owner,args,env,now){
 const readNow=typeof now==='function'?now:()=>now;now=readNow();
 object(args,['operation_id']);clock(now);if(!operation(args.operation_id))fail('invalid_dispatch');
 const saved=await attempt(db,owner,args.operation_id);if(!saved)fail('attempt_not_found');
 if(['sent','not_sent'].includes(saved.data.status))return output(db,owner,saved);
 source(saved.source_id);transport(env);return finish(db,owner,saved,env,readNow);
}
