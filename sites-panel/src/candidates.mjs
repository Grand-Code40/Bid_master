import {validatedCanonicalUrl} from './urls.mjs';
import {legacySourceIds} from './sources.mjs';
// Best-effort advisory only. Never writes, merges or changes review eligibility.
const identity=x=>JSON.stringify([x.source_id,x.external_id]);
const provenance=row=>({source_id:row.source_id,external_id:row.external_id,canonical_url:row.canonical_url,first_seen:row.first_seen,last_seen:row.last_seen});
export async function candidateWarnings(db,owner,focus=null){
 const coverage={version:1,limit:500,pair_limit:100,may_miss_matches:true};
 try{
  const excluded=legacySourceIds.map(()=>'?').join(',');
  const rows=(await db.prepare(`SELECT source_id,external_id,data,first_seen,last_seen FROM listings WHERE owner_id=? AND source_id NOT IN (${excluded}) ORDER BY last_seen DESC,source_id,external_id LIMIT 501`).bind(owner,...legacySourceIds).all()).results;
  const groups=new Map(),pairs=[];let truncated=rows.length>500;
  const wanted=focus?new Set(focus.map(identity)):null;
  for(const row of rows.slice(0,500)){
   const data=JSON.parse(row.data);
   if(data.detail_complete!==true||typeof data.description!=='string')continue;
   const text=data.description.normalize('NFC').replace(/\s+/gu,' ').trim();
   if([...text].length<200)continue;
   let url;try{url=validatedCanonicalUrl(row.source_id,row.external_id,data.canonical_url);}catch{continue;}
   const entry=provenance({...row,canonical_url:url});
   const group=groups.get(text)??[];group.push(entry);groups.set(text,group);
  }
  for(const group of groups.values()){
   group.sort((a,b)=>identity(a).localeCompare(identity(b)));
   for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++){
    if(wanted&&!wanted.has(identity(group[i]))&&!wanted.has(identity(group[j])))continue;
    if(pairs.length===100){truncated=true;continue;}
    pairs.push({kind:'possible_repost',reason:'exact_normalized_complete_description',listings:[group[i],group[j]]});
   }
  }
  return {...coverage,status:'checked',examined:Math.min(rows.length,500),truncated,pairs};
 }catch{return {...coverage,status:'unavailable',truncated:false,pairs:[]};}
}
