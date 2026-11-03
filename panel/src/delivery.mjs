// Correctable owner observations, never a sender or a delivery/read receipt.
// Every observation leaves a send guard. Error annotations do not remove it.
import {manualDeliveryUrl} from './review.mjs';
const fail=(code='invalid_delivery_record')=>{throw new Error(code);};
function object(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();}
function text(v,max){if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v))fail();return v;}
function identity(args){if(args.source_id!=='vmasshtabe'||typeof args.external_id!=='string'||!/^[a-z0-9][a-z0-9-]{0,127}$/.test(args.external_id))fail();}
async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),v=>v.toString(16).padStart(2,'0')).join('');}
export async function deliveryLog(db,owner,args){
 object(args,['source_id','external_id']);identity(args);
 // One SQL statement gives head and audit the same database snapshot.
 const rows=(await db.prepare('SELECT r.data AS record_data,e.operation_id,e.action,e.at,e.data AS event_data FROM delivery_records r LEFT JOIN delivery_events e ON e.owner_id=r.owner_id AND e.source_id=r.source_id AND e.external_id=r.external_id WHERE r.owner_id=? AND r.source_id=? AND r.external_id=? ORDER BY e.version').bind(owner,args.source_id,args.external_id).all()).results;
 return {record:rows.length?JSON.parse(rows[0].record_data):null,events:rows.filter(e=>e.operation_id!==null).map(e=>({operation_id:e.operation_id,action:e.action,at:e.at,data:JSON.parse(e.event_data)}))};
}
export async function deliveryAct(db,owner,args,action,ctx){
 if(ctx?.role!=='owner')fail('owner_required');
 if(!['observe','mark_error'].includes(action))fail();
 object(args,['source_id','external_id','version','operation_id',action==='observe'?'details':'reason']);identity(args);
 if(!Number.isSafeInteger(args.version)||args.version<0||args.version>=Number.MAX_SAFE_INTEGER||typeof args.operation_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(args.operation_id))fail();
 if(typeof ctx.now!=='string'||!Number.isFinite(Date.parse(ctx.now)))fail();
 let details;
 if(action==='observe'){
  object(args.details,['text','observation','observed_at','canonical_url','delivery_url']);const d=args.details;
  text(d.text,8000);text(d.observation,2000);
  if(typeof d.observed_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(d.observed_at)||!Number.isFinite(Date.parse(d.observed_at))||new Date(d.observed_at).toISOString()!==d.observed_at||Date.parse(d.observed_at)>Date.parse(ctx.now))fail();
  if(d.canonical_url!=='https://vmasshtabe.ru/task/'+args.external_id)fail();
  try{manualDeliveryUrl(d.delivery_url);}catch{fail();}
  // Canonical field order makes retry hashing independent of JSON key order.
  details={text:d.text,observation:d.observation,observed_at:d.observed_at,canonical_url:d.canonical_url,delivery_url:d.delivery_url};
 }else text(args.reason,2000);
 const requestHash=await digest([action,args.source_id,args.external_id,args.version,details??args.reason]);
 const previous=await db.prepare('SELECT request_hash,data FROM delivery_events WHERE owner_id=? AND operation_id=?').bind(owner,args.operation_id).first();
 if(previous){if(previous.request_hash!==requestHash)fail('operation_conflict');return JSON.parse(previous.data);}
 const listing=await db.prepare('SELECT data FROM listings WHERE owner_id=? AND source_id=? AND external_id=?').bind(owner,args.source_id,args.external_id).first();
 if(!listing)fail('listing_unavailable');
 if(action==='observe'&&JSON.parse(listing.data).canonical_url!==details.canonical_url)fail();
 const old=await db.prepare('SELECT version,data FROM delivery_records WHERE owner_id=? AND source_id=? AND external_id=?').bind(owner,args.source_id,args.external_id).first();
 if((old?.version??0)!==args.version)fail('stale_revision');
 const current=old?JSON.parse(old.data):null;
 if(action==='mark_error'&&!current)fail('delivery_record_not_found');
 if(action==='observe'&&current?.status==='observed')fail('delivery_record_exists');
 const next={source_id:args.source_id,external_id:args.external_id,version:args.version+1,status:action==='observe'?'observed':'erroneous',details:details??current.details,reason:action==='mark_error'?args.reason:null,auto_send_blocked:true,recorded_at:action==='observe'?ctx.now:current.recorded_at,updated_at:ctx.now};
 const data=JSON.stringify(next),keys=[owner,args.source_id,args.external_id];
 const write=old?db.prepare('UPDATE delivery_records SET version=?,data=?,last_operation=? WHERE owner_id=? AND source_id=? AND external_id=? AND version=? AND NOT EXISTS (SELECT 1 FROM delivery_events WHERE owner_id=? AND operation_id=?)').bind(next.version,data,args.operation_id,...keys,args.version,owner,args.operation_id):db.prepare('INSERT INTO delivery_records (owner_id,source_id,external_id,version,data,last_operation) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM delivery_events WHERE owner_id=? AND operation_id=?) ON CONFLICT DO NOTHING').bind(...keys,1,data,args.operation_id,owner,args.operation_id);
 const event=db.prepare('INSERT INTO delivery_events (owner_id,operation_id,source_id,external_id,version,action,at,data,request_hash) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM delivery_records WHERE owner_id=? AND source_id=? AND external_id=? AND version=? AND last_operation=?) AND NOT EXISTS (SELECT 1 FROM delivery_events WHERE owner_id=? AND operation_id=?)').bind(owner,args.operation_id,args.source_id,args.external_id,next.version,action,ctx.now,data,requestHash,...keys,next.version,args.operation_id,owner,args.operation_id);
 const result=await db.batch([write,event]);
 if(result[0].meta.changes!==1){const replay=await db.prepare('SELECT request_hash,data FROM delivery_events WHERE owner_id=? AND operation_id=?').bind(owner,args.operation_id).first();if(replay){if(replay.request_hash!==requestHash)fail('operation_conflict');return JSON.parse(replay.data);}fail('stale_revision');}
 return next;
}
