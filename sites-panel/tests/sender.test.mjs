import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmDelivery,claimDelivery} from '../src/sender.mjs';
const now='2026-11-02T12:00:00Z';
const row=()=>({source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html',text:'Exact approved reply',revision:1,state:'queued',approved_revision:1});
const details=()=>({source_id:'fl',external_id:'42',canonical_url:row().canonical_url,text:row().text,revision:1,sender_account:'owner-fl',recipient_account:'customer-42',price:null,currency:null,deadline:null,credit_cost:0});
const owner={role:'owner',now};
const ctx=()=>({role:'sender',now,enabled:true,newClaimToken:'A'.repeat(32),session:{source_id:'fl',sender_account:'owner-fl',authenticated:true,verified_at:now},preflight:{...details(),verified_at:now,availability:'open',already_sent:false,form_supported:true}});
const confirmed=()=>confirmDelivery(row(),details(),owner);
test('legacy queue and old approval cannot authorize delivery',()=>{assert.throws(()=>claimDelivery(row(),ctx()),/delivery_confirmation_required/);});
test('only owner explicitly confirms exact recipient and text',()=>{
 assert.throws(()=>confirmDelivery(row(),details(),{...owner,role:'agent'}),/owner_required/);
 for(const change of [{text:'Other'},{external_id:'43'},{revision:2},{canonical_url:'https://evil.test/'}])assert.throws(()=>confirmDelivery(row(),{...details(),...change},owner),/confirmation_mismatch/);
 assert.throws(()=>confirmDelivery(row(),{...details(),recipient_account:''},owner),/invalid_confirmation/);
 assert.throws(()=>confirmDelivery(row(),{...details(),extra:'injected'},owner),/invalid_confirmation/);
});
test('sender disabled and writer or generic agent cannot claim',()=>{
 assert.throws(()=>claimDelivery(confirmed(),{...ctx(),enabled:false}),/sender_disabled/);
 for(const role of ['owner','agent','writer'])assert.throws(()=>claimDelivery(confirmed(),{...ctx(),role}),/sender_required/);
});
test('authorized session and fresh complete preflight are mandatory',()=>{
 for(const session of [null,{...ctx().session,authenticated:false},{...ctx().session,sender_account:'other'},{...ctx().session,verified_at:'2026-11-02T11:54:59Z'},{...ctx().session,verified_at:'2026-11-02T12:01:00Z'}])assert.throws(()=>claimDelivery(confirmed(),{...ctx(),session}),/session_required/);
 for(const change of [{availability:'unknown'},{already_sent:true},{form_supported:false},{text:'Changed'},{recipient_account:'other'},{credit_cost:1},{verified_at:'2026-11-02T11:00:00Z'}])assert.throws(()=>claimDelivery(confirmed(),{...ctx(),preflight:{...ctx().preflight,...change}}),/preflight_required/);
});
test('confirmation binds additional form fields and cannot silently authorize paid credit',()=>{
 assert.throws(()=>confirmDelivery(row(),{...details(),price:100,currency:null},owner),/invalid_confirmation/);
 const d={...details(),price:100,currency:'RUB',deadline:'3 days',credit_cost:1};
 const r=confirmDelivery(row(),d,owner);
 assert.throws(()=>claimDelivery(r,ctx()),/preflight_required/);
 assert.equal(claimDelivery(r,{...ctx(),preflight:{...ctx().preflight,...d}}).state,'sending');
});
test('claim preserves exact snapshot, blocks changed approvals and cannot reclaim',()=>{
 const before=confirmed();const after=claimDelivery(before,ctx());
 assert.equal(before.state,'queued');assert.equal(after.state,'sending');assert.equal(after.text,before.text);assert.equal(after.claim_token,ctx().newClaimToken);
 assert.throws(()=>claimDelivery({...before,text:'Other'},ctx()),/confirmation_mismatch/);
 assert.throws(()=>claimDelivery({...before,approved_revision:null},ctx()),/approval_required/);
 assert.throws(()=>claimDelivery(after,ctx()),/review_locked/);
 assert.throws(()=>claimDelivery({...after,state:'uncertain'},ctx()),/review_locked/);
});
test('confirmation is detached from mutable caller data and rejects stale approval',()=>{
 const d=details();const r=confirmDelivery(row(),d,owner);d.text='mutated';assert.equal(r.delivery_confirmation.text,row().text);
 assert.throws(()=>confirmDelivery({...row(),approved_revision:null},details(),owner),/approval_required/);
});
test('Non-target and unknown platforms cannot be claimed even with imported confirmation',()=>{
 for(const source_id of ['kwork','other']){
  const r={...row(),source_id};const d={...details(),source_id};
  assert.throws(()=>confirmDelivery(r,d,owner),/invalid_confirmation/);
  assert.throws(()=>claimDelivery({...r,delivery_confirmation:{...d,version:1}}, {...ctx(),session:{...ctx().session,source_id},preflight:{...ctx().preflight,source_id}}),/source_not_supported/);
 }
});
test('editing, cancellation and confirmed non-delivery erase prior delivery confirmation',async()=>{
 const {transition}=await import('../src/review.mjs');
 const before=confirmed();
 const edited=transition({...before,state:'approved'},{action:'save',revision:1,text:'New text'},owner);
 const cancelled=transition(before,{action:'cancel',revision:1},owner);
 const sending=claimDelivery(before,ctx());
 const notSent=transition(sending,{action:'result',outcome:'not_sent',claim_token:ctx().newClaimToken,evidence:'Outgoing history checked; absent'}, {role:'agent',now});
 for(const after of [edited,cancelled,notSent])assert.equal(Object.hasOwn(after,'delivery_confirmation'),false);
 assert.ok(before.delivery_confirmation);
});
