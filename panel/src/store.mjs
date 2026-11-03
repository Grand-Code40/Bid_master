import {legacySourceIds} from './sources.mjs';
import {transition,publicReview} from './review.mjs';
import {confirmDelivery,claimDelivery} from './sender.mjs';
const fail=code=>{throw new Error(code);};
const eligible=item=>item?.listing_kind==='order' && item.availability!=='closed' && typeof item.canonical_url==='string';
async function hash(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');}
export class ReviewStore {
 constructor(db){this.db=db;}
 async listing(owner,source,id){const row=await this.db.prepare('SELECT data FROM listings WHERE owner_id=? AND source_id=? AND external_id=?').bind(owner,source,id).first();return row?JSON.parse(row.data):null;}
 async get(owner,source,id){const row=await this.db.prepare('SELECT * FROM reviews WHERE owner_id=? AND source_id=? AND external_id=?').bind(owner,source,id).first();return row?{...row,data:JSON.parse(row.data)}:null;}
 async prepare(owner,source,id,now,operation){
  const old=await this.get(owner,source,id);if(old)return publicReview(old.data);
  const item=await this.listing(owner,source,id);if(!eligible(item))fail('listing_unavailable');
  const row={source_id:source,external_id:id,canonical_url:item.canonical_url,title:item.title,text:`Здравствуйте! Заинтересовал проект «${String(item.title).slice(0,240)}».\n\nПришлите, пожалуйста, исходные материалы, требования к результату и желаемый срок. После просмотра смогу подтвердить возможность выполнения, стоимость и срок.`,revision:1,approved_revision:null,state:'draft',claim_token:null,claimed_at:null,evidence:null,delivery_url:null,created_at:now,updated_at:now};
  await this.db.prepare('INSERT INTO reviews (owner_id,source_id,external_id,data,last_operation) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING').bind(owner,source,id,JSON.stringify(row),operation).run();
  return publicReview((await this.get(owner,source,id)).data);
 }
 async act(owner,source,id,command,ctx){
  if(['confirm_delivery','record_manual_delivery'].includes(command.action)&&ctx?.role!=='owner')fail('owner_required');
  if(['claim','result'].includes(command.action)&&ctx?.role!=='sender')fail('sender_required');
  if(command.action==='claim'&&ctx.enabled!==true)fail('sender_disabled');
  const operation=command.operation_id;
  if(typeof operation!=='string'|| !/^[A-Za-z0-9_-]{1,128}$/.test(operation))fail('invalid_operation');
  const requestHash=await hash([source,id,command.action,command.revision??null,command.text??null,command.outcome??null,command.evidence??null,command.delivery_url??null,command.claim_token??null,...(['confirm_delivery','record_manual_delivery'].includes(command.action)?[command.details??null]:[])]);
  const replay=async()=>{
   const previous=await this.db.prepare('SELECT * FROM review_events WHERE owner_id=? AND operation_id=?').bind(owner,operation).first();
   if(!previous)return null;
   if(previous.request_hash!==requestHash)fail('operation_conflict');
   if(command.action==='claim'){const current=await this.get(owner,source,id);if(current?.last_operation===operation)return current.data;fail('claim_already_resolved');}
   return JSON.parse(previous.data);
  };
  const previous=await replay();if(previous)return previous;
  try {
  const old=await this.get(owner,source,id);if(!old)fail('review_not_found');
  if(old.data.state==='manual_sent'||old.data.manual_delivery)fail('review_locked');
  if(['approve','queue','confirm_delivery','claim'].includes(command.action)&&!eligible(await this.listing(owner,source,id)))fail('listing_unavailable');
  if(command.action==='confirm_delivery'&&command.revision!==old.data.revision)fail('stale_revision');
  const needsGuard=['queue','confirm_delivery','claim'].includes(command.action);
  if(needsGuard&&await this.db.prepare('SELECT 1 FROM delivery_records WHERE owner_id=? AND source_id=? AND external_id=?').bind(owner,source,id).first())fail('delivery_guard');
  const next=command.action==='confirm_delivery'?confirmDelivery(old.data,command.details,ctx):command.action==='claim'?claimDelivery(old.data,ctx):transition(old.data,command,command.action==='result'?{...ctx,role:'agent'}:ctx);
  const needsEligible=['approve','queue','confirm_delivery','claim'].includes(command.action);
  const statements=[
   this.db.prepare("UPDATE reviews SET data=?,storage_version=storage_version+1,last_operation=? WHERE owner_id=? AND source_id=? AND external_id=? AND storage_version=? AND (?=0 OR NOT EXISTS (SELECT 1 FROM delivery_records d WHERE d.owner_id=reviews.owner_id AND d.source_id=reviews.source_id AND d.external_id=reviews.external_id)) AND (?=0 OR EXISTS (SELECT 1 FROM listings l WHERE l.owner_id=reviews.owner_id AND l.source_id=reviews.source_id AND l.external_id=reviews.external_id AND json_extract(l.data,'$.listing_kind')='order' AND json_extract(l.data,'$.availability')!='closed')) AND NOT EXISTS (SELECT 1 FROM review_events e WHERE e.owner_id=reviews.owner_id AND e.operation_id=?)").bind(JSON.stringify(next),operation,owner,source,id,old.storage_version,needsGuard?1:0,needsEligible?1:0,operation),
   this.db.prepare('INSERT INTO review_events (owner_id,operation_id,source_id,external_id,action,at,data,request_hash) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM reviews WHERE owner_id=? AND source_id=? AND external_id=? AND last_operation=? AND storage_version=?) AND NOT EXISTS (SELECT 1 FROM review_events WHERE owner_id=? AND operation_id=?)').bind(owner,operation,source,id,command.action,ctx.now,JSON.stringify(publicReview(next)),requestHash,owner,source,id,operation,old.storage_version+1,owner,operation)
  ];
  const result=await this.db.batch(statements);
  if(result[0].meta.changes!==1)fail('stale_revision');
  return command.action==='claim'?next:publicReview(next);
  }catch(error){
   // An identical request may have committed after the first replay lookup.
   // Recover its durable result; never promote a changed request to a retry.
   const committed=await replay();if(committed)return committed;
   throw error;
  }
 }
 async claimNext(owner,source,operation,ctx){
  if(ctx?.role!=='sender')fail('sender_required');
  if(ctx.enabled!==true)fail('sender_disabled');
  if(typeof operation!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(operation))fail('invalid_operation');
  const previous=await this.db.prepare('SELECT * FROM review_events WHERE owner_id=? AND operation_id=?').bind(owner,operation).first();
  if(previous){
   if(previous.action!=='claim'||source!=null&&previous.source_id!==source)fail('operation_conflict');
   return this.act(owner,previous.source_id,previous.external_id,{action:'claim',operation_id:operation},ctx);
  }
  const rows=(await this.db.prepare("SELECT r.source_id,r.external_id FROM reviews r JOIN listings l USING(owner_id,source_id,external_id) WHERE r.owner_id=? AND (? IS NULL OR r.source_id=?) AND NOT EXISTS (SELECT 1 FROM delivery_records d WHERE d.owner_id=r.owner_id AND d.source_id=r.source_id AND d.external_id=r.external_id) AND json_extract(r.data,'$.state')='queued' AND json_extract(r.data,'$.delivery_confirmation.version')=1 AND json_extract(l.data,'$.listing_kind')='order' AND json_extract(l.data,'$.availability')!='closed' ORDER BY json_extract(r.data,'$.created_at'),r.source_id,r.external_id LIMIT 1").bind(owner,source,source).all()).results;
  if(!rows.length)return null;
  try{return await this.act(owner,rows[0].source_id,rows[0].external_id,{action:'claim',operation_id:operation},ctx);}catch(e){if(['delivery_guard','stale_revision','review_locked','listing_unavailable'].includes(e.message))return null;throw e;}
 }
 async active(owner){return (await this.db.prepare("SELECT data FROM reviews WHERE owner_id=? AND json_extract(data,'$.state') IN ('sending','uncertain')").bind(owner).all()).results.map(row=>JSON.parse(row.data));}
 // Active feed excludes archived sources in SQL before either bounded result set.
 // Historical snapshot/readback below deliberately retains its original semantics.
 async activeSnapshot(owner){
  const excluded=legacySourceIds.map(()=>'?').join(',');
  const listings=(await this.db.prepare(`SELECT data,first_seen,last_seen FROM listings WHERE owner_id=? AND source_id NOT IN (${excluded}) ORDER BY last_seen DESC LIMIT 1000`).bind(owner,...legacySourceIds).all()).results.map(row=>({...JSON.parse(row.data),first_seen:row.first_seen,last_seen:row.last_seen}));
  const reviews=(await this.db.prepare(`SELECT data FROM reviews WHERE owner_id=? AND source_id NOT IN (${excluded}) LIMIT 1000`).bind(owner,...legacySourceIds).all()).results.map(row=>publicReview(JSON.parse(row.data)));
  return {listings,reviews};
 }
 async snapshot(owner){
  const listings=(await this.db.prepare('SELECT data,first_seen,last_seen FROM listings WHERE owner_id=? ORDER BY last_seen DESC LIMIT 1000').bind(owner).all()).results.map(row=>({...JSON.parse(row.data),first_seen:row.first_seen,last_seen:row.last_seen}));
  const reviews=(await this.db.prepare('SELECT data FROM reviews WHERE owner_id=? LIMIT 1000').bind(owner).all()).results.map(row=>publicReview(JSON.parse(row.data)));
  return {listings,reviews};
 }
}
