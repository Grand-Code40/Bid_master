import {safeMailText,markMailViewed} from './inbox.mjs';
import {validatedCanonicalUrl} from './urls.mjs';
const fail=(code='invalid_message')=>{throw new Error(code);};
const fields=['source_id','account_id','message_id','thread_id','received_at','observed_at','sender','plain_text','reference'];
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();};
const opaque=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(v);
const timestamp=(v,now)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v&&v<=now;
function validate(args,now){
 if(args?.source_id==='weblancer')fail('source_paused');
 if(!['fl','freelance','vmasshtabe'].includes(args?.source_id))fail('source_unsupported');
 exact(args,fields);for(const k of ['account_id','message_id','thread_id'])if(!opaque(args[k]))fail();
 if(!timestamp(args.received_at,now)||!timestamp(args.observed_at,now)||args.received_at>args.observed_at)fail();
 for(const [k,max] of [['sender',500],['plain_text',12000]])if(typeof args[k]!=='string'||!args[k].trim()||args[k].length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args[k])||/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?\/?>/.test(args[k]))fail();
 const urls=safeMailText(args.sender+'\n'+args.plain_text);exact(args.reference,['source_id','external_id','canonical_url']);const r=args.reference;
 try{if(r.source_id!==args.source_id||validatedCanonicalUrl(r.source_id,r.external_id,r.canonical_url)!==r.canonical_url)fail();}catch{fail();}
 if(urls.some(url=>url!==r.canonical_url))fail();
 return {...args,reference:{...r}};
}
const contentKey=data=>JSON.stringify(fields.filter(k=>k!=='observed_at').map(k=>k==='reference'?[data.reference.source_id,data.reference.external_id,data.reference.canonical_url]:data[k]));
const platformKey=row=>JSON.stringify(['platform',row.source_id,row.account_id,row.message_id]);
const projectPlatform=row=>({...JSON.parse(row.data),message_key:platformKey(row),kind:'platform_message',provenance:'caller_observed',link_status:'exact_url',external_id:row.external_id,recorded_at:row.recorded_at,panel_viewed_at:row.panel_viewed_at});
export async function recordPlatformMessage(db,owner,args,now){
 const data=validate(args,now),r=data.reference;
 const listing=await db.prepare('SELECT data FROM listings WHERE owner_id=? AND source_id=? AND external_id=?').bind(owner,r.source_id,r.external_id).first();
 if(!listing)fail('message_listing_not_found');const saved=JSON.parse(listing.data);if(saved.listing_kind!=='order'||saved.canonical_url!==r.canonical_url)fail('message_listing_not_found');
 const result=await db.prepare('INSERT INTO platform_messages(owner_id,source_id,account_id,message_id,received_at,recorded_at,data,external_id) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,source_id,account_id,message_id) DO NOTHING').bind(owner,data.source_id,data.account_id,data.message_id,data.received_at,now,JSON.stringify(data),r.external_id).run();
 const row=await db.prepare('SELECT * FROM platform_messages WHERE owner_id=? AND source_id=? AND account_id=? AND message_id=?').bind(owner,data.source_id,data.account_id,data.message_id).first();
 if(!row||contentKey(JSON.parse(row.data))!==contentKey(data))fail('message_conflict');return {message:projectPlatform(row),duplicate:result.meta.changes===0};
}
function parseKey(value){
 if(typeof value!=='string'||value.length>1024)fail();let key;try{key=JSON.parse(value);}catch{fail();}
 if(!Array.isArray(key)||key.some(x=>typeof x!=='string')||JSON.stringify(key)!==value)fail();
 if(key[0]==='platform'&&key.length===4&&['fl','freelance','vmasshtabe'].includes(key[1])&&opaque(key[2])&&opaque(key[3]))return key;
 if(key[0]==='mail'&&key.length===3&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key[1])&&/^[a-f0-9]{1,64}$/.test(key[2]))return key;
 fail();
}
export async function listUnifiedInbox(db,owner,cursor=null){
 let after=null;if(cursor!==null){try{if(typeof cursor!=='string'||cursor.length>2048)fail();after=JSON.parse(cursor);exact(after,['received_at','message_key']);if(!timestamp(after.received_at,'9999-12-31T23:59:59.999Z'))fail();parseKey(after.message_key);}catch{fail('invalid_message_cursor');}}
 const sql=`SELECT * FROM (
 SELECT 'platform_message' AS kind,json_array('platform',source_id,account_id,message_id) AS message_key,received_at,recorded_at,data,source_id,external_id,'exact_url' AS link_status,panel_viewed_at,'caller_observed' AS provenance,NULL AS receipt_to_storage_ms FROM platform_messages WHERE owner_id=?
 UNION ALL
 SELECT 'email_notification' AS kind,json_array('mail',m.mailbox,m.message_id) AS message_key,m.received_at,m.recorded_at,m.data,m.source_id,m.external_id,m.link_status,m.panel_viewed_at,CASE WHEN p.message_id IS NULL THEN 'caller_observed' ELSE 'provider_verified' END AS provenance,p.receipt_to_storage_ms FROM mail_notifications m LEFT JOIN mail_provider_provenance p ON m.owner_id=p.owner_id AND m.mailbox=p.mailbox AND m.message_id=p.message_id WHERE m.owner_id=?
 )${after?' WHERE (received_at,message_key)<(?,?)':''} ORDER BY received_at DESC,message_key DESC LIMIT 101`;
 const rows=(await db.prepare(sql).bind(owner,owner,...(after?[after.received_at,after.message_key]:[])).all()).results;
 const messages=rows.slice(0,100).map(row=>({...JSON.parse(row.data),message_key:row.message_key,kind:row.kind,provenance:row.provenance,source_id:row.source_id,external_id:row.external_id,link_status:row.link_status,received_at:row.received_at,recorded_at:row.recorded_at,panel_viewed_at:row.panel_viewed_at,receipt_to_storage_ms:row.receipt_to_storage_ms}));
 const last=messages.at(-1);return {messages,next_cursor:rows.length>100?JSON.stringify({received_at:last.received_at,message_key:last.message_key}):null,coverage:{mode:'local_storage',email_notifications:'partial_notifications_only',platform_messages:'caller_observed_only'}};
}
export async function markMessageViewed(db,owner,args,now){
 exact(args,['message_key']);const key=parseKey(args.message_key);if(!timestamp(now,'9999-12-31T23:59:59.999Z'))fail();
 if(key[0]==='mail'){try{await markMailViewed(db,owner,{mailbox:key[1],message_id:key[2]},now);}catch{fail('message_not_found');}}
 else{const result=await db.prepare('UPDATE platform_messages SET panel_viewed_at=COALESCE(panel_viewed_at,?) WHERE owner_id=? AND source_id=? AND account_id=? AND message_id=?').bind(now,owner,...key.slice(1)).run();if(result.meta.changes!==1)fail('message_not_found');}
 return {panel_viewed:true,provider_changed:false};
}
