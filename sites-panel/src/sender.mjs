// Local-only sender policy component; intentionally NOT routed by API or MCP.
// ctx must be constructed by trusted server code, never copied from tool/HTTP JSON.
// The future adapter must persist confirmation/claim atomically with ReviewStore CAS.
import {transition} from './review.mjs';
const fail=code=>{throw new Error(code);};
const keys=['source_id','external_id','canonical_url','text','revision','sender_account','recipient_account','price','currency','deadline','credit_cost'];
const binding=['source_id','external_id','canonical_url','text','revision'];
const nonempty=x=>typeof x==='string'&&x.trim().length>0&&x.length<=8000&&!x.includes('\0');
function current(row){
 if(!['approved','queued'].includes(row.state))fail('review_locked');
 if(row.approved_revision!==row.revision)fail('approval_required');
}
function matches(row,d){if(binding.some(k=>row[k]!==d[k]))fail('confirmation_mismatch');}
function fresh(at,now){const delta=Date.parse(now)-Date.parse(at);return Number.isFinite(delta)&&delta>=0&&delta<=300000;}
export function confirmDelivery(row,details,ctx){
 if(ctx?.role!=='owner')fail('owner_required');
 current(row);
 if(!details||typeof details!=='object'||Array.isArray(details)||Object.keys(details).length!==keys.length||keys.some(k=>!Object.hasOwn(details,k))||!Number.isFinite(Date.parse(ctx.now)))fail('invalid_confirmation');
 matches(row,details);
 if(!['fl','freelance'].includes(details.source_id)||!nonempty(details.sender_account)||!nonempty(details.recipient_account)||![0,1].includes(details.credit_cost))fail('invalid_confirmation');
 if(details.price===null?details.currency!==null:typeof details.price!=='number'||!Number.isFinite(details.price)||details.price<0||!(/^[A-Z]{3}$/).test(details.currency??''))fail('invalid_confirmation');
 if(details.deadline!==null&&!nonempty(details.deadline))fail('invalid_confirmation');
 return {...row,delivery_confirmation:{...details,version:1,confirmed_at:ctx.now}};
}
export function claimDelivery(row,ctx){
 if(ctx?.enabled!==true)fail('sender_disabled');
 if(ctx.role!=='sender')fail('sender_required');
 if(!['fl','freelance'].includes(row.source_id))fail('source_not_supported');
 if(row.state!=='queued')fail('review_locked');
 current(row);
 const d=row.delivery_confirmation;
 if(!d||d.version!==1)fail('delivery_confirmation_required');
 matches(row,d);
 const s=ctx.session;
 if(!s||s.authenticated!==true||s.source_id!==d.source_id||s.sender_account!==d.sender_account||!fresh(s.verified_at,ctx.now))fail('session_required');
 const p=ctx.preflight;
 if(!p||p.availability!=='open'||p.already_sent!==false||p.form_supported!==true||!fresh(p.verified_at,ctx.now)||keys.some(k=>p[k]!==d[k]))fail('preflight_required');
 // Only this gated adapter maps sender capability into the internal domain role.
 // Writer/agent tool scope is never promoted into sender capability.
 return transition(row,{action:'claim'},{role:'agent',now:ctx.now,newClaimToken:ctx.newClaimToken});
}
