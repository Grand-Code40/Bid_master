import {senderStatus,preflightDelivery,sendDelivery,recoverDelivery} from './dispatch.mjs';
import {inboxChannels,syncMail} from './mail-sync.mjs';
import {recordPlatformMessage,listUnifiedInbox,markMessageViewed} from './messages.mjs';
import {deliveryAct,deliveryLog} from './delivery.mjs';
import {listMail,markMailViewed} from './inbox.mjs';
import {candidateWarnings} from './candidates.mjs';
import {latestScans,scanCoverage} from './scans.mjs';
import {ReviewStore} from './store.mjs';
import {ingestObservations} from './ingest.mjs';
import {publicSources} from './sources.mjs';
const response=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
const reject=(code,status)=>{const e=new Error(code);e.status=status;throw e;};
async function secureEqual(a,b){
 if(typeof a!=='string'||typeof b!=='string')return false;
 const digest=async text=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
 const [x,y]=await Promise.all([digest(a),digest(b)]);let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]^y[i];return diff===0;
}
async function body(request,limit){
 if(!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')??''))reject('json_required',415);
 if(Number(request.headers.get('Content-Length'))>limit)reject('request_too_large',413);
 if(!request.body)reject('invalid_request',400);
 const reader=request.body.getReader();let size=0;const parts=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();reject('request_too_large',413);}parts.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{reject('invalid_request',400);}
}
export async function handleApi(request,env){
 try{
  const url=new URL(request.url),path=url.pathname,agent=path.startsWith('/api/agent/');
  // Read-only bootstrap; no first-visitor ownership assignment, writes or secrets.
  if(path==='/api/identity'){
   if(request.method!=='GET')reject('method_not_allowed',405);
   const identity=request.headers.get('oai-authenticated-user-id');
   if(!identity)reject('sign_in_required',401);
   return response({user_id:identity,owner_configured:Boolean(env.OWNER_USER_ID)});
  }
  if(!env.DB||!env.OWNER_USER_ID)reject('site_not_configured',503);
  // This header is trusted ONLY behind the Sites gateway; do not expose this
  // Worker directly on an unprotected workers.dev hostname or local proxy.
  if(agent){
   if(typeof env.WRITER_TOKEN!=='string'||env.WRITER_TOKEN.length<32)reject('writer_not_configured',503);
   if(!await secureEqual(request.headers.get('X-Bid-Writer-Token'),env.WRITER_TOKEN))reject('unauthorized',401);
  }else{
   const identity=request.headers.get('oai-authenticated-user-id');if(!identity)reject('sign_in_required',401);
   if(identity!==env.OWNER_USER_ID)reject('owner_required',403);
  }
  const store=new ReviewStore(env.DB),owner=env.OWNER_USER_ID,now=new Date().toISOString(),trustedClock=()=>new Date().toISOString();
  if(request.method==='GET'&&path==='/api/sender/status')return response(senderStatus(env));
  if(request.method==='GET'&&path==='/api/inbox/channels'){if(url.search)reject('invalid_request',400);return response(await inboxChannels(env.DB,owner,env,now));}
  if(request.method==='GET'&&path==='/api/inbox/unified'){if([...url.searchParams.keys()].some(k=>k!=='cursor')||url.searchParams.getAll('cursor').length>1)reject('invalid_request',400);return response(await listUnifiedInbox(env.DB,owner,url.searchParams.get('cursor')));}
  if(request.method==='GET'&&path==='/api/delivery-log'){if([...url.searchParams.keys()].length!==2||url.searchParams.getAll('source_id').length!==1||url.searchParams.getAll('external_id').length!==1)reject('invalid_delivery_record',400);return response(await deliveryLog(env.DB,owner,Object.fromEntries(url.searchParams)));}
  if(request.method==='GET'&&path==='/api/inbox'){if([...url.searchParams.keys()].some(k=>k!=='cursor')||url.searchParams.getAll('cursor').length>1)reject('invalid_mail',400);return response(await listMail(env.DB,owner,url.searchParams.get('cursor')));}
  if(request.method==='GET'&&path==='/api/state'){
   const state=await store.activeSnapshot(owner),orders=state.listings.filter(x=>x.listing_kind==='order');
   const checks=await latestScans(env.DB,owner),sources=publicSources(state.listings,checks);
   const latest=checks.slice().sort((a,b)=>a.checked_at.localeCompare(b.checked_at)||a.run_id.localeCompare(b.run_id)).at(-1);
   const coverage=latest?await scanCoverage(env.DB,owner,{run_id:latest.run_id}):null;
   return response({...state,candidate_check:await candidateWarnings(env.DB,owner),sender:senderStatus(env),sources,scan:{running:false,error:null,result:null,coverage},monitor:{enabled:false,interval_minutes:30,next_run_at:null,supported:false},agent:{last_seen:null},summary:{total:state.listings.length,orders:orders.length,vacancies:state.listings.filter(x=>x.listing_kind==='vacancy').length,priced_orders:orders.filter(x=>x.budget_min!=null||x.budget_max!=null).length}});
  }
  if(request.method==='GET'&&path==='/api/scan-coverage'){if([...url.searchParams.keys()].some(k=>k!=='run_id')||url.searchParams.getAll('run_id').length!==1)reject('invalid_scan',400);return response(await scanCoverage(env.DB,owner,{run_id:url.searchParams.get('run_id')}));}
  if(request.method!=='POST')reject('not_found',404);
  if(!agent&&request.headers.get('Origin')!==url.origin)reject('invalid_origin',403);
  const data=await body(request,path==='/api/agent/ingest'?4*1024*1024:40000);
  if(path==='/api/review/preflight')return response(await preflightDelivery(env.DB,owner,data,env,trustedClock));
  if(path==='/api/review/send')return response(await sendDelivery(env.DB,owner,data,env,trustedClock));
  if(path==='/api/review/recover')return response(await recoverDelivery(env.DB,owner,data,env,trustedClock));
  if(path==='/api/inbox/platform-message')return response(await recordPlatformMessage(env.DB,owner,data,now));
  if(path==='/api/inbox/message-viewed')return response(await markMessageViewed(env.DB,owner,data,now));
  if(path==='/api/inbox/sync'){
   if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==1||typeof data.channel!=='string')reject('invalid_request',400);
   if(data.channel==='weblancer')reject('source_paused',409);if(data.channel!=='gmail')reject('source_unsupported',409);
   return response(await syncMail(env.DB,owner,env,trustedClock));
  }
  if(path==='/api/delivery-log/observe'||path==='/api/delivery-log/mark-error')return response(await deliveryAct(env.DB,owner,data,path.endsWith('/observe')?'observe':'mark_error',{role:'owner',now}));
  if(path==='/api/inbox/viewed')return response(await markMailViewed(env.DB,owner,data,now));
  if(path==='/api/agent/ingest')return response(await ingestObservations(env.DB,owner,data,now));
  // Writer scope is intentionally not a sender scope. No claim/result/active
  // endpoint is exposed until an authorized sender integration is requested.
  if(['/api/scan','/api/monitor','/api/stop'].includes(path))reject('schedule_not_available',501);
  const match=path.match(/^\/api\/review\/(prepare|save|approve|queue|cancel|confirm_delivery|record_manual_delivery)$/);
  const agentDraft=path==='/api/agent/draft';
  if(!match&&!agentDraft)reject('not_found',404);
  if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.source_id!=='string'||typeof data.external_id!=='string'||typeof data.operation_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(data.operation_id))reject('invalid_request',400);
  const action=agentDraft?(Object.hasOwn(data,'text')?'save':'prepare'):match[1];
  if(['confirm_delivery','record_manual_delivery'].includes(action)&&Object.keys(data).some(k=>!['source_id','external_id','operation_id','revision','details'].includes(k)))reject('invalid_request',400);
  if(action==='prepare')return response(await store.prepare(owner,data.source_id,data.external_id,now,data.operation_id));
  return response(await store.act(owner,data.source_id,data.external_id,{action,revision:data.revision,text:data.text,details:data.details,operation_id:data.operation_id},{role:agent?'agent':'owner',now}));
 }catch(error){
  const conflicts=['sender_disabled','sender_not_configured','source_paused','source_unsupported','source_not_supported','preflight_mismatch','preflight_required','preflight_expired','preflight_used','transport_changed','transport_unavailable','message_conflict','delivery_guard','delivery_record_exists','stale_revision','review_locked','approval_required','listing_unavailable','operation_conflict','ingest_conflict','confirmation_mismatch','delivery_confirmation_required'];
  const invalid=['invalid_dispatch','invalid_sync_time','invalid_message','invalid_message_cursor','invalid_delivery_record','mail_auth_content','mail_secret_content','mail_unsafe_link','invalid_mail','invalid_scan','invalid_request','invalid_operation','invalid_observation','invalid_text','invalid_confirmation','invalid_manual_delivery'];
  const status=error.status??(conflicts.includes(error.message)?409:invalid.includes(error.message)?400:['attempt_not_found','message_not_found','message_listing_not_found','delivery_record_not_found','mail_not_found','review_not_found'].includes(error.message)?404:503);
  return response({error:status===503&&!error.status?'storage_unavailable':error.message,...(error.attempt_started===false?{attempt_started:false}:{})},status);
 }
}
