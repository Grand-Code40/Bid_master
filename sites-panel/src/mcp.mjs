import {deliveryAct,deliveryLog} from './delivery.mjs';
import {recordMail,listMail,linkMailConversation} from './inbox.mjs';
import {scanSources,scanStatuses,scanReasons,recordScan,scanCoverage} from './scans.mjs';
import {ReviewStore} from './store.mjs';
import {ingestObservations} from './ingest.mjs';
import {publicReview} from './review.mjs';
// Sites gateway supplies authenticated identity. This endpoint must never be
// exposed through a direct/unprotected Worker hostname. No client role or owner
// argument is accepted, and no writer secret is read or returned here.
import {importSourceIds,readableSourceIds,maxExternalIdLength} from './sources.mjs';
const sourceIds=readableSourceIds;
const string={type:'string'},nullableString={type:['string','null']};
const observationProperties={source_id:{type:'string',enum:importSourceIds},external_id:{type:'string',minLength:1,maxLength:maxExternalIdLength},canonical_url:string,title:string,observed_at:string,description:nullableString,detail_complete:{type:'boolean'},listing_kind:{enum:['order','vacancy','unknown']},availability:{enum:['open','closed','unknown']},budget_min:{type:['string','number','null']},budget_max:{type:['string','number','null']},currency:nullableString,budget_unit:nullableString,bids_count:{type:['integer','null'],minimum:0},published_at:nullableString,raw_date:nullableString};
for(const key of ['cad_categories','requested_formats','explicit_constraints'])observationProperties[key]={type:'array',items:string,maxItems:100};
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const identityProperties={source_id:{type:'string',enum:sourceIds},external_id:{type:'string',minLength:1,maxLength:maxExternalIdLength}};
const scanProperties={run_id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'},source_id:{type:'string',enum:scanSources.map(s=>s.id)},checked_at:{type:'string',format:'date-time',maxLength:24},status:{type:'string',enum:scanStatuses},scope:{type:'string',enum:['root','section','single_item']},source_url:{type:'string',enum:[...new Set(scanSources.flatMap(s=>s.scan_urls))],maxLength:2048},observed_count:{type:'integer',minimum:0,maximum:1000000},saved_count:{type:'integer',minimum:0,maximum:1000000},reason:{type:'string',enum:scanReasons}};
const manualDeliveryProperties={text:{type:'string',minLength:1,maxLength:8000},observation:{type:'string',minLength:1,maxLength:2000},observed_at:{type:'string',format:'date-time',maxLength:24},delivery_url:{type:'string',maxLength:128}};
const tools=[
 {name:'bid_read_mail',description:'Read existing owner-scoped saved email notifications, newest first, at most 100 per page. Pass next_cursor unchanged as cursor for the next page. These are caller-observed notifications, not verified customer replies. Does not read Gmail, import messages, mark anything viewed, send, or start monitoring.',inputSchema:schema({cursor:{type:['string','null'],maxLength:1024}}),annotations:{readOnlyHint:true}},

 {name:'bid_ingest',description:'Import actually observed CAD listings into the owner’s private database. Does not approve or send replies. Manual observations only; no scraping or automated collection permission. Vmasshtabe must be a single observation per call; bulk copying is prohibited. This per-call guard is not a rate limit and does not authorize repeated automated imports. Unknown values must remain unknown; never import examples as real listings.',inputSchema:schema({observations:{type:'array',minItems:1,maxItems:200,items:schema(observationProperties,['source_id','external_id','canonical_url','title','observed_at'])}},['observations'])},
 {name:'bid_draft',description:'Prepare or edit an owner-scoped draft. Edits require current revision and invalidate approval. Cannot approve, queue, claim or send. Use a unique operation_id and reuse it only for an identical retry.',inputSchema:schema({...identityProperties,operation_id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'},revision:{type:'integer',minimum:1},text:{type:'string',minLength:1,maxLength:8000}},['source_id','external_id','operation_id'])},
 {name:'bid_record_manual_delivery',description:'Record an actually observed manual reply as an immutable historical fact for the authenticated owner, never send a message. Requires exact current saved revision/text, observation evidence, UTC ISO timestamp including milliseconds, and the exact Vmasshtabe conversation URL with only positive numeric id and response_id. Use only verified own-response/conversation evidence, never infer delivery from copying text or a draft. This locks further edits and sending. Does not assert customer read status. No credentials or secrets in evidence. Reuse operation_id only for an identical retry.',inputSchema:schema({...identityProperties,source_id:{type:'string',enum:['vmasshtabe']},operation_id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'},revision:{type:'integer',minimum:1},details:schema(manualDeliveryProperties,Object.keys(manualDeliveryProperties))},['source_id','external_id','operation_id','revision','details'])},
 {name:'bid_readback',description:'Read owner-scoped saved listings and public draft states. Supply both source_id and external_id for exact readback; otherwise returns at most 50 recent listings. Never returns claim tokens or credentials.',inputSchema:schema(identityProperties)},
 {name:'bid_record_scan',description:'Record one actually attempted source check, or an explicit skipped check. Caller-reported diagnostics only, no network request or parser. Exact source/channel ID and allowed public URL required; checked_at must be UTC ISO milliseconds, not future. Reuse run_id+source_id only for identical retries. Required scope must match the exact target URL: root, section, single_item. observed_count counts actually viewed items, not matching items. empty means no matches and requires saved_count=0; skipped requires both counts=0. Partial failed checks may retain actual counts; saved_count <= observed_count. single_item allows at most one observed item and is not a platform scan. Never include secrets. Does not import listings, approve or send.',inputSchema:schema(scanProperties,Object.keys(scanProperties))},
 {name:'bid_scan_coverage',description:'Read owner-scoped check coverage for an exact run_id, including missing, empty, blocked, auth_required, error and skipped. completed counts success+empty checks; completed_source_checks excludes single_item and legacy_unknown. No scope proves a complete platform scan. Returns allowed source IDs and public scan URLs. Does not collect, approve or send.',inputSchema:schema({run_id:scanProperties.run_id},['run_id']),annotations:{readOnlyHint:true}}
];
tools.push({name:'bid_record_mail',description:'Record ONE actually read relevant Gmail notification, only with user authorization for this mailbox and private Site. Caller-observed email, not a verified customer reply. Never bulk-import unrelated mail, credentials, HTML or attachments. IDs are Gmail hexadecimal IDs, dates UTC ISO milliseconds. Keep only relevant plain text (max 12000 characters). reference must be null for ambiguous links, or an exact canonical order URL observed as a whitespace-separated token in subject/plain_text with its source and ID. Authentication codes, secrets, auth/reset links, URL query strings/fragments and encoded paths are rejected server-side. Multiple distinct URLs force an unlinked notification. This does not read Gmail, change Gmail read state, answer, send, or start monitoring. Reuse mailbox+message_id for unchanged message content. A later observed_at returns duplicate and preserves the first observation timestamp; changed message content conflicts.',inputSchema:schema({mailbox:{type:'string',maxLength:254},message_id:{type:'string',pattern:'^[a-fA-F0-9]{1,64}$'},thread_id:{type:'string',pattern:'^[a-fA-F0-9]{1,64}$'},received_at:{type:'string',format:'date-time'},observed_at:{type:'string',format:'date-time'},sender:{type:'string',maxLength:500},subject:{type:'string',maxLength:500},plain_text:{type:'string',minLength:1,maxLength:12000},reference:{anyOf:[{type:'null'},schema({...identityProperties,canonical_url:{type:'string',maxLength:2048}},['source_id','external_id','canonical_url'])]}},['mailbox','message_id','thread_id','received_at','observed_at','sender','subject','plain_text','reference'])});
tools.push({name:'bid_link_mail_conversation',description:'Attach ONE exact conversation URL actually observed in the original Gmail notification to that existing saved notification. Only Vmasshtabe HTTPS account/view-task with positive numeric id and response_id is accepted. Requires user authorization for this mailbox and private panel. Never invent a URL or infer its relation to an order. Write-once, identical retries are safe. Preserves original mail content and view state. Does not fetch the page, read a conversation, draft, send, approve, or change Gmail. This is a navigation link for the user, not evidence of message content or delivery.',inputSchema:schema({mailbox:{type:'string',maxLength:254},message_id:{type:'string',pattern:'^[a-fA-F0-9]{1,64}$'},conversation_url:{type:'string',maxLength:128},observed_at:{type:'string',format:'date-time'}},['mailbox','message_id','conversation_url','observed_at'])});
const deliveryIdentity={source_id:{type:'string',enum:['vmasshtabe']},external_id:identityProperties.external_id};
const deliveryVersion={type:'integer',minimum:0},deliveryOperation={type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'};
const observedDetails={...manualDeliveryProperties,canonical_url:{type:'string',maxLength:2048}};
tools.push(
 {name:'bid_observe_delivery',description:'Save an owner-attested observation of an already sent Vmasshtabe response in a separate CORRECTABLE accounting log. Requires actually observed exact text, evidence, UTC milliseconds, canonical order URL and strict conversation URL. Does not send or prove customer receipt/read. version=0 for first record; replacing an erroneous record requires its current version and fresh actual evidence. Can mark mistaken accounting with bid_mark_delivery_error; all original evidence remains permanently in audit, with no deletion capability. Automated-send guard remains even after correction; no capability to release it. Already claimed/in-flight work is not recalled. Never use draft/copying as delivery evidence. No credentials. Reuse operation_id only for an identical retry.',inputSchema:schema({...deliveryIdentity,operation_id:deliveryOperation,version:deliveryVersion,details:schema(observedDetails,Object.keys(observedDetails))},['source_id','external_id','operation_id','version','details'])},
 {name:'bid_mark_delivery_error',description:'Mark an owner delivery ACCOUNTING record erroneous, with mandatory reason and current CAS version. Permanently keeps original evidence and complete audit, with no deletion capability. Does NOT recall, cancel or undo any actual message and does NOT clear automated-send guard. No send or approval rights. Reuse operation_id only for identical retry.',inputSchema:schema({...deliveryIdentity,operation_id:deliveryOperation,version:deliveryVersion,reason:{type:'string',minLength:1,maxLength:2000}},['source_id','external_id','operation_id','version','reason'])},
 {name:'bid_delivery_log',description:'Read the owner correctable delivery accounting record and complete audit for one exact order. Observations are owner-attested, not independently verified receipts. Erroneous accounting still retains automated-send guard. No secrets or claim tokens returned.',inputSchema:schema(deliveryIdentity,['source_id','external_id']),annotations:{readOnlyHint:true}}
);
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const reject=(message,status=400)=>{const error=new Error(message);error.status=status;throw error;};
function strictObject(value,allowed,required=[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))reject('invalid_arguments');
}
function listingIdentity(args){if(!sourceIds.includes(args.source_id)||typeof args.external_id!=='string'||!args.external_id||args.external_id.length>maxExternalIdLength)reject('invalid_arguments');}
async function parse(request){
 if(!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')??''))reject('json_required',415);
 const limit=4*1024*1024;
 if(Number(request.headers.get('Content-Length'))>limit)reject('request_too_large',413);
 if(!request.body)reject('invalid_request');
 const reader=request.body.getReader(),parts=[];let length=0;
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();reject('request_too_large',413);}parts.push(value);}
 const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{reject('invalid_request');}
}
async function call(name,args,env){
 const owner=env.OWNER_USER_ID,store=new ReviewStore(env.DB),now=new Date().toISOString();
 if(name==='bid_read_mail'){strictObject(args,['cursor']);return listMail(env.DB,owner,args.cursor??null);}
 if(name==='bid_delivery_log')return deliveryLog(env.DB,owner,args);
 if(name==='bid_observe_delivery'||name==='bid_mark_delivery_error')return deliveryAct(env.DB,owner,args,name==='bid_observe_delivery'?'observe':'mark_error',{role:'owner',now});
 if(name==='bid_link_mail_conversation')return linkMailConversation(env.DB,owner,args,now);
 if(name==='bid_record_mail')return recordMail(env.DB,owner,args,now);
 if(name==='bid_record_scan')return recordScan(env.DB,owner,args,now);
 if(name==='bid_scan_coverage')return scanCoverage(env.DB,owner,args);
 if(name==='bid_ingest'){
  strictObject(args,['observations'],['observations']);return ingestObservations(env.DB,owner,args.observations,now);
 }
 if(name==='bid_draft'){
  strictObject(args,['source_id','external_id','operation_id','revision','text'],['source_id','external_id','operation_id']);listingIdentity(args);
  if(typeof args.operation_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(args.operation_id))reject('invalid_arguments');
  if(!Object.hasOwn(args,'text')){if(Object.hasOwn(args,'revision'))reject('invalid_arguments');return store.prepare(owner,args.source_id,args.external_id,now,args.operation_id);}
  if(!Number.isSafeInteger(args.revision)||args.revision<1)reject('invalid_arguments');
  return store.act(owner,args.source_id,args.external_id,{action:'save',text:args.text,revision:args.revision,operation_id:args.operation_id},{role:'agent',now});
 }
 if(name==='bid_record_manual_delivery'){
  strictObject(args,['source_id','external_id','operation_id','revision','details'],['source_id','external_id','operation_id','revision','details']);listingIdentity(args);
  if(args.source_id!=='vmasshtabe'||!Number.isSafeInteger(args.revision)||args.revision<1)reject('invalid_arguments');
  strictObject(args.details,Object.keys(manualDeliveryProperties),Object.keys(manualDeliveryProperties));
  // handleMcp verified the trusted gateway identity equals the configured owner.
  // This single historical-record capability grants no approval/queue/send access.
  return store.act(owner,args.source_id,args.external_id,{action:'record_manual_delivery',revision:args.revision,operation_id:args.operation_id,details:args.details},{role:'owner',now});
 }
 if(name==='bid_readback'){
  strictObject(args,['source_id','external_id']);
  if(Object.keys(args).length){listingIdentity(args);const [item,row]=await Promise.all([store.listing(owner,args.source_id,args.external_id),store.get(owner,args.source_id,args.external_id)]);return {listings:item?[item]:[],reviews:row?[publicReview(row.data)]:[]};}
  const state=await store.snapshot(owner),listings=state.listings.slice(0,50),keys=new Set(listings.map(x=>x.source_id+':'+x.external_id));
  return {listings,reviews:state.reviews.filter(x=>keys.has(x.source_id+':'+x.external_id)),limit:50,has_more:state.listings.length>50};
 }
 reject('unknown_tool');
}
export async function handleMcp(request,env){
 let id=null;
 try{
  if(!env.DB||!env.OWNER_USER_ID)reject('site_not_configured',503);
  const identity=request.headers.get('oai-authenticated-user-id');if(!identity)reject('sign_in_required',401);
  if(identity!==env.OWNER_USER_ID)reject('owner_required',403);
  if(request.method!=='POST')reject('method_not_allowed',405);
  const origin=request.headers.get('Origin');if(origin&&origin!==new URL(request.url).origin)reject('invalid_origin',403);
  const envelope=await parse(request);
  strictObject(envelope,['jsonrpc','id','method','params'],['jsonrpc','id','method']);
  if(envelope.jsonrpc!=='2.0'||!['string','number'].includes(typeof envelope.id)||typeof envelope.method!=='string')reject('invalid_request');
  id=envelope.id;
  if(envelope.method==='server/discover')return json({jsonrpc:'2.0',id,result:{supportedVersions:['2026-07-28'],capabilities:{tools:{}}}});
  if(envelope.method==='tools/list')return json({jsonrpc:'2.0',id,result:{tools}});
  if(envelope.method!=='tools/call')return json({jsonrpc:'2.0',id,error:{code:-32601,message:'method_not_found'}},400);
  try{
   // MCP transport metadata is not a business argument or an authorization source.
   strictObject(envelope.params,['name','arguments','_meta'],['name']);
   if(Object.hasOwn(envelope.params,'_meta')){const meta=envelope.params._meta;if(!meta||typeof meta!=='object'||Array.isArray(meta))reject('invalid_arguments');}
   if(typeof envelope.params.name!=='string')reject('invalid_arguments');
   const result=await call(envelope.params.name,envelope.params.arguments??{},env);
   return json({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}});
  }catch(error){
   const safe=['invalid_delivery_record','delivery_record_not_found','delivery_record_exists','delivery_guard','mail_auth_content','mail_secret_content','mail_unsafe_link','invalid_mail','mail_not_found','mail_conflict','invalid_scan','scan_conflict','invalid_arguments','unknown_tool','invalid_observation','invalid_text','stale_revision','review_locked','listing_unavailable','review_not_found','operation_conflict','ingest_conflict','invalid_operation','invalid_manual_delivery','confirmation_mismatch'];
   const message=safe.includes(error.message)?error.message:'operation_failed';
   return json({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:JSON.stringify({error:message})}]}});
  }
 }catch(error){return json({jsonrpc:'2.0',id,error:{code:-32600,message:error.status?error.message:'invalid_request'}},error.status??400);}
}
