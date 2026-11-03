import {validatedCanonicalUrl} from './urls.mjs';
// Caller-observed notifications, never verified client replies. No Gmail client,
// remote fetch, HTML parser, attachments, tokens or external mark-as-read action.
const fail=(code='invalid_mail')=>{throw new Error(code);};
const fields=['mailbox','message_id','thread_id','received_at','observed_at','sender','subject','plain_text','reference'];
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail();}
function text(value,max,empty=false){if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fail();return value;}
function identity(args){
 text(args.mailbox,254);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.mailbox))fail();
 if(typeof args.message_id!=='string'||!/^[a-fA-F0-9]{1,64}$/.test(args.message_id))fail();
 return {mailbox:args.mailbox.toLowerCase(),message_id:args.message_id.toLowerCase()};
}
function timestamp(value,now){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value||value>now)fail();return value;}
// Fail closed on authentication-related mail, recognized secrets and opaque links.
// This is deliberately conservative, not a claim to detect every possible secret.
export function safeMailText(value){
 const normalized=value.normalize('NFKC');
 const urls=normalized.match(/https?:\/\/[^\s<>"']+/giu)??[];
 for(const raw of urls){let url;try{url=new URL(raw);}catch{fail('mail_unsafe_link');}
  // Match whole auth path segments, not substrings such as /author/designer.
  const authPath=/(?:^|\/)(?:verify|verification|confirm|confirmation|activate|activation|magic[-_]?link|sign[-_]?in|login|oauth2?|auth|authenticate|authentication|session|reset|password[-_]reset|reset[-_]password|recover|recovery)(?:\/|$)/iu;
  // Query/fragment/encoded paths can conceal secrets or tracking identifiers.
  if(url.username||url.password||url.search||url.hash||raw.includes('%')||authPath.test(url.pathname))fail('mail_unsafe_link');
 }
 // Credential assignments and recognizable secret formats. No whole-word
 // 'password' ban: ordinary discussion of project requirements is not a secret.
 if(/(?<![\p{L}\p{N}_])(?:(?:password|пароль|access[_ -]?token|refresh[_ -]?token|reset[_ -]?token|token|secret|api[_ -]?key|session)\s*[:=]|Bearer\s+\S+|(?:sk-(?:proj-)?|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN[^\r\n]*PRIVATE KEY-----)/iu.test(normalized))fail('mail_secret_content');
 // Explicit authentication phrases, with Unicode word boundaries and context.
 // In particular, 'presets', 'подтверждено ТЗ' and 'код детали' are not auth.
 if(/(?<![\p{L}\p{N}_])(?:(?:verification|confirmation|security|login|sign[ -]?in|one[ -]?time|authentication|recovery)\s+(?:code|token|password)|(?:reset\s+(?:your\s+)?password|password\s+reset)|(?:OTP|2FA|MFA)\s*(?::|code|\d{4,8})|код\s+(?:подтверждения|авторизации|аутентификации|(?:для\s+)?входа)|одноразов(?:ый|ого)\s+(?:код|пароль)|(?:восстановление|сброс)\s+пароля)(?![\p{L}\p{N}_])/iu.test(normalized))fail('mail_auth_content');
 if(/(?<![\p{L}\p{N}_])(?:(?:your\s+)?code\s*(?:is\s*)?[:=-]?\s*|(?:ваш\s+)?код\s*[:=-]\s*)\d{4,8}(?!\d)/iu.test(normalized))fail('mail_auth_content');
 return urls;
}
function validate(args,now){
 object(args,fields);const key=identity(args);
 if(typeof args.thread_id!=='string'||!/^[a-fA-F0-9]{1,64}$/.test(args.thread_id))fail();
 timestamp(args.received_at,now);timestamp(args.observed_at,now);if(args.received_at>args.observed_at)fail();
 text(args.sender,500);text(args.subject,500,true);text(args.plain_text,12000);
 const urls=safeMailText(args.sender+'\n'+args.subject+'\n'+args.plain_text);
 let reference=null;
 if(args.reference!==null){
  object(args.reference,['source_id','external_id','canonical_url']);
  const r=args.reference;let url;try{url=validatedCanonicalUrl(r.source_id,r.external_id,r.canonical_url);}catch{fail();}
  // An observed, literal canonical URL only. No title, sender or thread guessing.
  if(url!==r.canonical_url||!(args.subject+'\n'+args.plain_text).split(/\s+/).includes(url))fail();
  // Any second distinct URL is conservatively ambiguous, even an unrelated link.
  reference=new Set(urls).size===1?{source_id:r.source_id,external_id:r.external_id,canonical_url:url}:null;
 }
 return {...key,thread_id:args.thread_id.toLowerCase(),received_at:args.received_at,observed_at:args.observed_at,sender:args.sender,subject:args.subject,plain_text:args.plain_text,reference};
}
// Compare stable observed message content, not the time a repeated poll read it.
// Existing rows need no backfill; the first observation and viewed marker stay untouched.
const contentKey=mail=>JSON.stringify(fields.filter(k=>k!=='observed_at').map(k=>k==='reference'&&mail.reference?[mail.reference.source_id,mail.reference.external_id,mail.reference.canonical_url]:mail[k]));
const project=row=>({...JSON.parse(row.data),kind:'email_notification',source_id:row.source_id,external_id:row.external_id,link_status:row.link_status,recorded_at:row.recorded_at,panel_viewed_at:row.panel_viewed_at});
export async function recordMail(db,owner,args,now){
 const mail=validate(args,now),data=JSON.stringify(mail);let source=null,id=null,status=mail.reference?'unresolved':'unlinked';
 if(mail.reference){const r=mail.reference,row=await db.prepare('SELECT data FROM listings WHERE owner_id=? AND source_id=? AND external_id=?').bind(owner,r.source_id,r.external_id).first();
  if(row){const listing=JSON.parse(row.data);if(listing.listing_kind==='order'&&listing.canonical_url===r.canonical_url){source=r.source_id;id=r.external_id;status='exact_url';}}
 }
 const result=await db.prepare('INSERT INTO mail_notifications (owner_id,mailbox,message_id,received_at,recorded_at,data,source_id,external_id,link_status) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,mailbox,message_id) DO NOTHING').bind(owner,mail.mailbox,mail.message_id,mail.received_at,now,data,source,id,status).run();
 const row=await db.prepare('SELECT * FROM mail_notifications WHERE owner_id=? AND mailbox=? AND message_id=?').bind(owner,mail.mailbox,mail.message_id).first();
 if(!row||contentKey(JSON.parse(row.data))!==contentKey(mail))fail('mail_conflict');
 return {message:project(row),duplicate:result.meta.changes===0};
}
export async function listMail(db,owner,cursor=null){
 let after=null;if(cursor!==null){if(typeof cursor!=='string'||cursor.length>1024)fail();try{after=JSON.parse(cursor);}catch{fail();}object(after,['received_at','mailbox','message_id']);identity(after);timestamp(after.received_at,'9999-12-31T23:59:59.999Z');}
 const rows=await db.prepare('SELECT * FROM mail_notifications WHERE owner_id=?'+(after?' AND (received_at,mailbox,message_id)<(?,?,?)':'')+' ORDER BY received_at DESC,mailbox DESC,message_id DESC LIMIT 101').bind(owner,...(after?[after.received_at,after.mailbox,after.message_id]:[])).all();
 const messages=rows.results.slice(0,100).map(project),last=messages.at(-1);
 return {messages,next_cursor:rows.results.length>100?JSON.stringify({received_at:last.received_at,mailbox:last.mailbox,message_id:last.message_id}):null,import_mode:'observed_notifications_only'};
}
export async function markMailViewed(db,owner,args,now){
 object(args,['mailbox','message_id']);const key=identity(args);
 const result=await db.prepare('UPDATE mail_notifications SET panel_viewed_at=COALESCE(panel_viewed_at,?) WHERE owner_id=? AND mailbox=? AND message_id=?').bind(now,owner,key.mailbox,key.message_id).run();
 if(result.meta.changes!==1)fail('mail_not_found');return {panel_viewed:true,gmail_changed:false};
}
