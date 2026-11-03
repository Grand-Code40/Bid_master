import {sourceRegistry,telegramChannels} from './sources.mjs';
// A journal of caller-reported checks, not a scraper or verification of access.
// Exact catalog IDs only: the Telegram aggregate is deliberately excluded.
// Exact reviewed targets only; query strings are allowed only as literal entries.
const platformTargets={
 pro_pto:[['https://pro-pto.ru/projects','section']],
 fl:[['https://www.fl.ru/projects/category/inzhiniring/autocad/','section'],['https://www.fl.ru/projects/category/inzhiniring/','section'],['https://www.fl.ru/rss/?category=20','section'],['https://www.fl.ru/rss/all.xml','section']],
 freelance:[['https://freelance.ru/task','section']],
 weblancer:[['https://www.weblancer.net/freelance/','section'],['https://www.weblancer.net/freelance/chertezhi-i-skhemi-78/','section']],
 '3ddd':[['https://3ddd.ru/work','section'],['https://3ddd.ru/work/tasks','section']],
 dwg:[['https://dwg.ru/board/','section'],['https://dwg.ru/rss/rssforumt33.xml','section'],['https://dwg.ru/rss/rssforum33.xml','section']],
 enginer:[['https://enginer.ru/','root']],profi:[['https://profi.ru/','root']],
 youdo:[['https://youdo.com/tasks-all-opened-all','section']],
 vmasshtabe:[['https://vmasshtabe.ru/task/synthetic-scan-target','single_item']]
};
export const scanSources=Object.freeze([...sourceRegistry,...telegramChannels].filter(s=>s.counts_as_source).map(s=>{
 const aliases=s.channel?[s.channel,...(s.channel==='help_kirill_autocad'?['help_kirill_autoCAD']:s.channel==='free_design1'?['free_Design1']:[])]:[];
 const targets=Object.freeze((s.channel?aliases.map(c=>['https://t.me/s/'+c,'section']):platformTargets[s.id]).map(([url,scope])=>Object.freeze({url,scope})));
 return Object.freeze({id:s.id,name:s.name,scan_urls:Object.freeze(targets.map(t=>t.url)),scan_targets:targets});
}));
export const scanStatuses=Object.freeze(['success','empty','blocked','auth_required','error','skipped']);
// Deliberately no arbitrary logs, HTML, cookies, exception messages or free text.
export const scanReasons=Object.freeze(['checked','no_matches','access_denied','login_required','captcha','robots_disallowed','terms_restricted','timeout','unavailable','parse_failed','not_attempted','unsupported']);
const statusReasons=Object.freeze({success:['checked'],empty:['no_matches'],blocked:['access_denied','captcha','robots_disallowed','terms_restricted'],auth_required:['login_required'],error:['timeout','unavailable','parse_failed'],skipped:['not_attempted','unsupported','robots_disallowed','terms_restricted']});
const fields=['run_id','source_id','checked_at','status','source_url','scope','observed_count','saved_count','reason'];
const fail=(message='invalid_scan')=>{throw new Error(message);};
const validRun=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
function validate(input,now){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(input,k)))fail();
 const source=scanSources.find(s=>s.id===input.source_id);
 if(!validRun(input.run_id)||!source||!scanStatuses.includes(input.status)||!scanReasons.includes(input.reason))fail();
 if(!statusReasons[input.status].includes(input.reason))fail();
 if(typeof input.source_url!=='string'||input.source_url.length>2048||!source.scan_targets.some(t=>t.url===input.source_url&&t.scope===input.scope))fail();
 if(typeof input.checked_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.checked_at)||!Number.isFinite(Date.parse(input.checked_at))||new Date(input.checked_at).toISOString()!==input.checked_at||Date.parse(input.checked_at)>Date.parse(now))fail();
 for(const key of ['observed_count','saved_count'])if(!Number.isSafeInteger(input[key])||input[key]<0||input[key]>1000000)fail();
 if(input.scope==='single_item'&&input.observed_count>1)fail();
 if(input.saved_count>input.observed_count||(input.status==='skipped'&&(input.observed_count!==0||input.saved_count!==0))||(input.status==='empty'&&input.saved_count!==0)||(input.status==='success'&&input.observed_count===0))fail();
 return Object.fromEntries(fields.map(k=>[k,input[k]]));
}
export async function recordScan(db,owner,input,now){
 const scan=validate(input,now),data=JSON.stringify(scan);
 const result=await db.prepare('INSERT INTO scan_runs (owner_id,run_id,source_id,checked_at,recorded_at,data) VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id,run_id,source_id) DO NOTHING').bind(owner,scan.run_id,scan.source_id,scan.checked_at,now,data).run();
 const row=await db.prepare('SELECT data,recorded_at FROM scan_runs WHERE owner_id=? AND run_id=? AND source_id=?').bind(owner,scan.run_id,scan.source_id).first();
 if(!row||row.data!==data)fail('scan_conflict');
 return {scan:{...scan,recorded_at:row.recorded_at},duplicate:result.meta.changes===0,reported:true};
}
// Read compatibility only: never infer historical scope or rewrite stored data.
const readScan=r=>{const scan=JSON.parse(r.data);return {...scan,scope:scan.scope??'legacy_unknown',recorded_at:r.recorded_at};};
export async function latestScans(db,owner){
 const rows=await db.prepare('SELECT s.data,s.recorded_at FROM scan_runs s WHERE s.owner_id=? AND NOT EXISTS (SELECT 1 FROM scan_runs n WHERE n.owner_id=s.owner_id AND n.source_id=s.source_id AND (n.checked_at>s.checked_at OR (n.checked_at=s.checked_at AND (n.recorded_at>s.recorded_at OR (n.recorded_at=s.recorded_at AND n.run_id>s.run_id)))))').bind(owner).all();
 return rows.results.map(readScan);
}
export async function scanCoverage(db,owner,args){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==1||!validRun(args.run_id))fail();
 const rows=await db.prepare('SELECT data,recorded_at FROM scan_runs WHERE owner_id=? AND run_id=? ORDER BY source_id').bind(owner,args.run_id).all();
 const checks=new Map(rows.results.map(r=>{const s=readScan(r);return [s.source_id,s];}));
 const sources=scanSources.map(s=>({...s,check:checks.get(s.id)??null})),status_counts=Object.fromEntries(scanStatuses.map(s=>[s,0]));
 for(const s of sources)if(s.check)status_counts[s.check.status]++;
 const scope_counts={root:0,section:0,single_item:0,legacy_unknown:0};
 for(const s of sources)if(s.check)scope_counts[s.check.scope]++;
 const completed_source_checks=sources.filter(s=>s.check&&['root','section'].includes(s.check.scope)&&['success','empty'].includes(s.check.status)).length;
 const recorded=sources.filter(s=>s.check).length,completed=status_counts.success+status_counts.empty;
 return {run_id:args.run_id,expected:sources.length,recorded,completed,completed_source_checks,scope_counts,missing:sources.length-recorded,all_reported:recorded===sources.length,all_completed:completed_source_checks===sources.length,status_counts,sources,reported:true,parsers_implemented:false};
}
