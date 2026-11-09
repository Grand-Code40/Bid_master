import {validatedCanonicalUrl} from './urls.mjs';
import {candidateWarnings} from './candidates.mjs';
const invalid=()=>{throw new Error('invalid_observation');};
const fields=['source_id','external_id','canonical_url','title','observed_at','description','detail_complete','listing_kind','cad_categories','budget_min','budget_max','currency','budget_unit','bids_count','published_at','raw_date','availability','requested_formats','explicit_constraints'];
function timestamp(value){if(typeof value!=='string'|| !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))invalid();return new Date(value).toISOString();}
export function canonicalUrl(source,id,value){return validatedCanonicalUrl(source,id,value);}
export function validateObservations(input,now){
 const maxTime=Date.parse(timestamp(now));
 if(!Array.isArray(input)||input.length<1||input.length>200)invalid();
 if(input.length!==1&&input.some(x=>x?.source_id==='vmasshtabe'))invalid();
 return input.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!fields.includes(key)))invalid();
  const row={...raw};row.observed_at=timestamp(row.observed_at);if(Date.parse(row.observed_at)>maxTime)invalid();
  row.canonical_url=canonicalUrl(row.source_id,row.external_id,row.canonical_url);
  if(typeof row.title!=='string'||!row.title.trim()||row.title.length>1000)invalid();
  for(const [key,value] of Object.entries(row)){
   if(typeof value==='string'&&(value.includes('\0')||value.length>50000))invalid();
   if(['description','currency','budget_unit','raw_date'].includes(key)&&value!==null&&typeof value!=='string')invalid();
   if(['budget_min','budget_max'].includes(key)&&value!==null){if(!['string','number'].includes(typeof value)||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value))||!Number.isFinite(Number(value)))invalid();row[key]=String(value);}
   if(key==='bids_count'&&value!==null&&(!Number.isSafeInteger(value)||value<0))invalid();
   if(key==='detail_complete'&&typeof value!=='boolean')invalid();
   if(key==='listing_kind'&&!['order','vacancy','unknown'].includes(value))invalid();
   if(key==='availability'&&!['open','closed','unknown'].includes(value))invalid();
   if(['cad_categories','requested_formats','explicit_constraints'].includes(key)&&(!Array.isArray(value)||value.length>100||value.some(x=>typeof x!=='string'||x.length>2000||x.includes('\0'))))invalid();
   if(key==='published_at'&&value!==null)row[key]=timestamp(value);
  }
  return row;
 });
}
export async function ingestObservations(db,owner,input,now){
 const observations=validateObservations(input,now);let written=0;
 for(const observation of observations){
  const {observed_at:stamp,...incoming}=observation;
  let committed=false;
  for(let attempt=0;attempt<4&&!committed;attempt++){
   const old=await db.prepare('SELECT * FROM listings WHERE owner_id=? AND source_id=? AND external_id=?').bind(owner,incoming.source_id,incoming.external_id).first();
   const data=old?JSON.parse(old.data):{description:'',detail_complete:false,listing_kind:'unknown',availability:'unknown',budget_min:null,budget_max:null,bids_count:null,requested_formats:[],cad_categories:[],explicit_constraints:[]};
   const times=old?JSON.parse(old.field_times):{};
   const preserve=data.detail_complete&&!incoming.detail_complete;
   for(const [field,value] of Object.entries(incoming)){
    if(preserve&&['description','detail_complete','requested_formats','explicit_constraints','cad_categories','raw_date'].includes(field))continue;
    if(!times[field]||stamp>=times[field]){data[field]=value;times[field]=stamp;}
   }
   const first=old&&old.first_seen<stamp?old.first_seen:stamp,last=old&&old.last_seen>stamp?old.last_seen:stamp;
   const result=old?await db.prepare('UPDATE listings SET data=?,field_times=?,first_seen=?,last_seen=?,storage_version=storage_version+1 WHERE owner_id=? AND source_id=? AND external_id=? AND storage_version=?').bind(JSON.stringify(data),JSON.stringify(times),first,last,owner,incoming.source_id,incoming.external_id,old.storage_version).run():await db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,1) ON CONFLICT DO NOTHING').bind(owner,incoming.source_id,incoming.external_id,JSON.stringify(data),JSON.stringify(times),first,last).run();
   committed=result.meta.changes===1;
  }
  if(!committed)throw new Error('ingest_conflict');written++;
 }
 return {written,candidate_check:await candidateWarnings(db,owner,observations)};
}
