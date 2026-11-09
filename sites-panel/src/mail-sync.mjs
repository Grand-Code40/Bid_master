import {recordMail,safeMailText} from './inbox.mjs';
import {validatedCanonicalUrl} from './urls.mjs';
const fail=code=>{throw new Error(code);};
const coverage='partial_notifications_only';
const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validId=value=>typeof value==='string'&&/^[a-fA-F0-9]{1,64}$/.test(value);
function configuration(env){
 const mailbox=env.GMAIL_MAILBOX,query=env.GMAIL_NOTIFICATION_QUERY;
 const token=typeof env.GMAIL_ACCESS_TOKEN==='string'&&env.GMAIL_ACCESS_TOKEN.length>0&&env.GMAIL_ACCESS_TOKEN.length<8192&&!/[\r\n]/.test(env.GMAIL_ACCESS_TOKEN);
 const refresh=['GMAIL_CLIENT_ID','GMAIL_CLIENT_SECRET','GMAIL_REFRESH_TOKEN'].every(k=>typeof env[k]==='string'&&env[k].length>0&&env[k].length<8192&&!/[\r\n]/.test(env[k]));
 if(!mailbox&&!query&&!token&&!refresh)return {error:'not_configured'};
 // Conjunction-only syntax makes the relative receipt bound apply to every result.
 const bounded=typeof query==='string'&&query.length<=500&&!/[\x00-\x1f{}()"'\\|&]/.test(query)&&!/(?:^|\s)OR(?:\s|$)/i.test(query)&&/(?:^|\s)newer_than:([1-9]|[1-8][0-9]|90)d(?=\s|$)/.test(query)&&/(?:^|\s)(?:from|subject|label):\S+/.test(query);
 if(!validEmail(mailbox)||!bounded||(!token&&!refresh))return {error:'configuration_required'};
 return {mailbox:mailbox.toLowerCase(),query,token:token?env.GMAIL_ACCESS_TOKEN:null,refresh};
}
async function fingerprint(config,env){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([config.mailbox,config.query,env.GMAIL_CLIENT_ID??null])));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');}
const readState=(db,owner)=>db.prepare('SELECT * FROM inbox_sync_state WHERE owner_id=? AND channel=?').bind(owner,'gmail').first();
function publicState(row,override=null){return {channel:'gmail',status:override??row?.status??'not_checked',mode:'manual_sync',coverage,initial_catchup_complete:Boolean(row?.initial_complete),has_more:Boolean(row?.page_cursor),last_attempt:row?.last_attempt??null,last_success:row?.last_success??null,error_code:row?.error_code??null,retry_after_seconds:row?.retry_after_seconds??null,imported:row?.imported??0,skipped:row?.skipped??0,skip_reasons:row?JSON.parse(row.skip_reasons):{},latency_measurement:'email_receipt_to_panel_storage_only'};}
export async function inboxChannels(db,owner,env,now){
 const config=configuration(env),row=await readState(db,owner);let gmail;
 if(config.error)gmail=publicState(null,config.error);
 else if(row&&row.config_fingerprint!==await fingerprint(config,env))gmail=publicState(null,'resync_required');
 else gmail=publicState(row,row?.lease_id&&row.lease_until>now?'busy':null);
 return {channels:[gmail,...['fl','freelance','vmasshtabe'].map(channel=>({channel,status:'caller_observed_only',mode:'manual_observation',coverage:'caller_observed_only'})),{channel:'weblancer',status:'paused',mode:'disabled',coverage:'not_polled'}]};
}
const publicErrors=new Set(['unauthorized','forbidden','rate_limited','resync_required','configuration_error','provider_unavailable','timeout','account_mismatch','invalid_provider_response','mail_conflict','storage_error']);
function errorCode(error){if(error?.name==='AbortError'||error?.name==='TimeoutError')return 'timeout';return publicErrors.has(error?.message)?error.message:'provider_unavailable';}
// A generic 400 never proves a bad cursor. Interpret only explicit token errors,
// privately and with the same response bounds; raw details never reach state.
async function responseJson(response,maxBytes,hasSavedCursor=false){
 if(!response.ok){
  let code=response.status===401?'unauthorized':response.status===403?'forbidden':response.status===429?'rate_limited':response.status===400?'configuration_error':'provider_unavailable';
  if(response.status===400&&hasSavedCursor){
   try{const details=(await boundedJson(response,32000))?.error;const message=details?.message;
    if((typeof message==='string'&&message.length<=500&&/^invalid page[ _]?token[.!]?$/i.test(message.trim()))||details?.errors?.some(x=>x?.reason==='invalidPageToken'||x?.reason==='pageTokenExpired'))code='resync_required';
   }catch{}
  }
  const retry=response.status===429?response.headers.get('retry-after'):null;const error=new Error(code);if(retry&&/^\d{1,5}$/.test(retry)&&Number(retry)<=86400)error.retryAfter=Number(retry);try{await response.body?.cancel();}catch{}throw error;
 }
 return boundedJson(response,maxBytes);
}
async function boundedJson(response,maxBytes){
 const length=Number(response.headers.get('content-length'));if(length>maxBytes){try{await response.body?.cancel();}catch{}fail('invalid_provider_response');}
 let count=0,chunks=[];if(!response.body)fail('invalid_provider_response');const reader=response.body.getReader();try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>maxBytes){await reader.cancel();fail('invalid_provider_response');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('invalid_provider_response');}
}
function plainMail(provider,mailbox,now){
 if(!validId(provider?.id)||!validId(provider?.threadId)||typeof provider.internalDate!=='string'||!/^\d{1,16}$/.test(provider.internalDate))fail('malformed_mime');
 const date=Number(provider.internalDate);if(!Number.isSafeInteger(date)||date<0||date>Date.parse(now))fail('malformed_mime');
 const payload=provider.payload;if(!payload||!Array.isArray(payload.headers)||payload.headers.length>100)fail('malformed_mime');
 function header(name){const values=payload.headers.filter(h=>typeof h?.name==='string'&&h.name.toLowerCase()===name);if(values.length>1)fail('malformed_mime');const value=values[0]?.value??'';if(typeof value!=='string'||value.length>2000||/=\?/.test(value))fail('malformed_mime');return value;}
 let nodes=0,totalBytes=0;const parts=[];
 function visit(part,depth){
  if(++nodes>40||depth>8||!part||typeof part!=='object')fail('malformed_mime');
  if(part.filename||part.body?.attachmentId)return;
  const type=part.mimeType?.toLowerCase();if(type==='text/plain'){
   const charset=part.headers?.find(h=>h?.name?.toLowerCase()==='content-type')?.value?.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1];if(charset&&!/^(utf-8|us-ascii)$/i.test(charset))fail('malformed_mime');
   const body=part.body;if(!body||!Number.isInteger(body.size)||body.size<0||body.size>48000||typeof body.data!=='string'||body.data.length>64000||!/^[A-Za-z0-9_-]*={0,2}$/.test(body.data)||body.data.length%4===1)fail('malformed_mime');
   let binary,text;try{binary=atob(body.data.replace(/-/g,'+').replace(/_/g,'/'));const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));totalBytes+=bytes.length;if(totalBytes>48000)fail('malformed_mime');text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('malformed_mime');}
   if(binary.length!==body.size)fail('malformed_mime');parts.push(text);
  }else if(type?.startsWith('multipart/')){if(!Array.isArray(part.parts)||part.parts.length>40)fail('malformed_mime');for(const child of part.parts)visit(child,depth+1);}
 }
 visit(payload,0);if(!parts.length)fail('no_plain_text');const plain_text=parts.join('\n');if(!plain_text.trim()||plain_text.length>12000||/<\/?[A-Za-z!][^>]*>/.test(plain_text))fail('malformed_mime');
 const sender=header('from'),subject=header('subject');safeMailText(sender+'\n'+subject+'\n'+plain_text);
 let reference=null;const urls=plain_text.match(/https?:\/\/[^\s<>"']+/gu)??[];
 if(new Set(urls).size===1){const url=urls[0];let source,id;let parsed;try{parsed=new URL(url);}catch{}const path=parsed?.pathname??'';
  if(parsed?.hostname==='www.fl.ru'){source='fl';id=path.match(/^\/projects\/(\d+)\//)?.[1];}
  if(parsed?.hostname==='freelance.ru'){source='freelance';id=(path.match(/^\/task\/view\/(\d+)$/)||path.match(/-(\d+)\.html$/))?.[1];}
  if(parsed?.hostname==='vmasshtabe.ru'){source='vmasshtabe';id=path.match(/^\/task\/([^/]+)$/)?.[1];}
  try{if(source&&id&&validatedCanonicalUrl(source,id,url)===url)reference={source_id:source,external_id:id,canonical_url:url};}catch{}
 }
 return {mailbox,message_id:provider.id.toLowerCase(),thread_id:provider.threadId.toLowerCase(),received_at:new Date(date).toISOString(),observed_at:now,sender,subject,plain_text,reference};
}
export async function syncMail(db,owner,env,now,options={}){
 const readNow=options.clock??(typeof now==='function'?now:()=>now);
 const started=readNow();now=started;const config=configuration(env);if(config.error)return publicState(null,config.error);
 if(typeof now!=='string'||!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now)fail('invalid_sync_time');
 const fp=await fingerprint(config,env),lease=crypto.randomUUID(),until=new Date(Date.parse(now)+120000).toISOString();
 await db.prepare('INSERT INTO inbox_sync_state(owner_id,channel,config_fingerprint,mailbox,status) VALUES (?,?,?,?,?) ON CONFLICT(owner_id,channel) DO NOTHING').bind(owner,'gmail',fp,config.mailbox,'not_checked').run();
 const acquired=await db.prepare("UPDATE inbox_sync_state SET page_cursor=CASE WHEN config_fingerprint=? THEN page_cursor ELSE NULL END,initial_complete=CASE WHEN config_fingerprint=? THEN initial_complete ELSE 0 END,last_success=CASE WHEN config_fingerprint=? THEN last_success ELSE NULL END,config_fingerprint=?,mailbox=?,lease_id=?,lease_until=?,status='syncing',last_attempt=?,error_code=NULL,retry_after_seconds=NULL,imported=0,skipped=0,skip_reasons='{}' WHERE owner_id=? AND channel='gmail' AND (lease_id IS NULL OR lease_until<=?) AND (error_code IS NULL OR error_code!='rate_limited' OR lease_until IS NULL OR lease_until<=?)").bind(fp,fp,fp,fp,config.mailbox,lease,until,now,owner,now,now).run();
 if(acquired.meta.changes!==1){const saved=await readState(db,owner);return publicState(saved,saved?.error_code==='rate_limited'&&!saved.lease_id&&saved.lease_until>now?null:'busy');}
 const state=await readState(db,owner);let imported=0,skipped=0;const reasons={};
 const controller=new AbortController();let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DOMException('timeout','TimeoutError'));},20000);});
 const fetcher=options.fetch??globalThis.fetch;
 const request=async(url,init={},maxBytes=200000,hasSavedCursor=false)=>Promise.race([(async()=>responseJson(await fetcher(url,{...init,redirect:'error',signal:controller.signal}),maxBytes,hasSavedCursor))(),deadline]);
 try{
  let token=config.token;if(!token){const body=new URLSearchParams({grant_type:'refresh_token',client_id:env.GMAIL_CLIENT_ID,client_secret:env.GMAIL_CLIENT_SECRET,refresh_token:env.GMAIL_REFRESH_TOKEN});const result=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString()},32000);if(typeof result?.access_token!=='string'||!result.access_token||result.access_token.length>8192||/[\r\n]/.test(result.access_token))fail('invalid_provider_response');token=result.access_token;}
  const get=(path,max,hasSavedCursor=false)=>request('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{method:'GET',headers:{Authorization:'Bearer '+token}},max,hasSavedCursor);
  const profile=await get('profile',32000);if(!validEmail(profile?.emailAddress))fail('invalid_provider_response');if(profile.emailAddress.toLowerCase()!==config.mailbox)fail('account_mismatch');
  const query=new URLSearchParams({q:config.query,maxResults:'10',includeSpamTrash:'false'});if(state.page_cursor)query.set('pageToken',state.page_cursor);
  const page=await get('messages?'+query.toString(),32000,Boolean(state.page_cursor));
  if(!page||typeof page!=='object'||(page.messages!==undefined&&!Array.isArray(page.messages))||(page.messages?.length??0)>10||(page.nextPageToken!==undefined&&(typeof page.nextPageToken!=='string'||!page.nextPageToken||page.nextPageToken.length>2048||/[\x00-\x1f]/.test(page.nextPageToken))))fail('invalid_provider_response');
  for(const item of page.messages??[]){if(!validId(item?.id))fail('invalid_provider_response');}
  for(const item of page.messages??[]){
   const provider=await get('messages/'+item.id+'?format=full',200000);now=readNow();if(typeof now!=='string'||!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now||now<started)fail('invalid_provider_response');if(provider?.id!==item.id)fail('invalid_provider_response');let mail;
   try{mail=plainMail(provider,config.mailbox,now);}catch(error){const allowed=new Set(['malformed_mime','no_plain_text','mail_auth_content','mail_secret_content','mail_unsafe_link']);if(!allowed.has(error.message))throw error;skipped++;reasons[error.message]=(reasons[error.message]??0)+1;continue;}
   let recorded;try{recorded=await recordMail(db,owner,mail,now);}catch(error){if(['mail_conflict','invalid_mail','mail_auth_content','mail_secret_content','mail_unsafe_link'].includes(error.message)){skipped++;reasons[error.message]=(reasons[error.message]??0)+1;continue;}fail('storage_error');}
   if(!recorded.duplicate)imported++;
   const latency=!recorded.duplicate&&state.initial_complete&&state.last_success&&mail.received_at>=state.last_success?Date.parse(now)-Date.parse(mail.received_at):null;
   try{await db.prepare('INSERT INTO mail_provider_provenance(owner_id,mailbox,message_id,verified_at,receipt_to_storage_ms) VALUES (?,?,?,?,?) ON CONFLICT(owner_id,mailbox,message_id) DO NOTHING').bind(owner,mail.mailbox,mail.message_id,now,latency).run();}catch{fail('storage_error');}
  }
  now=readNow();if(typeof now!=='string'||!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now||now<started)fail('invalid_provider_response');
  const next=page.nextPageToken??null;
  await db.prepare("UPDATE inbox_sync_state SET page_cursor=?,initial_complete=?,status=?,last_success=CASE WHEN ? IS NULL THEN ? ELSE last_success END,error_code=NULL,retry_after_seconds=NULL,imported=?,skipped=?,skip_reasons=?,lease_id=NULL,lease_until=NULL WHERE owner_id=? AND channel='gmail' AND lease_id=?").bind(next,state.initial_complete||!next?1:0,next?'partial':'ready',next,now,imported,skipped,JSON.stringify(reasons),owner,lease).run();
 }catch(error){
  const code=errorCode(error),completed=readNow();
  // With no active lease, lease_until holds a persisted provider cooldown only.
  const cooldown=code==='rate_limited'&&Number.isInteger(error.retryAfter)?new Date(Math.max(Date.parse(started),Date.parse(completed)||0)+error.retryAfter*1000).toISOString():null;
  const status=code==='resync_required'?'resync_required':code==='configuration_error'?'configuration_required':'error';
  await db.prepare("UPDATE inbox_sync_state SET status=?,error_code=?,retry_after_seconds=?,imported=?,skipped=?,skip_reasons=?,page_cursor=CASE WHEN ?='resync_required' THEN NULL ELSE page_cursor END,initial_complete=CASE WHEN ?='resync_required' THEN 0 ELSE initial_complete END,lease_id=NULL,lease_until=? WHERE owner_id=? AND channel='gmail' AND lease_id=?").bind(status,code,error.retryAfter??null,imported,skipped,JSON.stringify(reasons),code,code,cooldown,owner,lease).run();
 }
 finally{clearTimeout(timer);controller.abort();}
 return publicState(await readState(db,owner));
}
