import test from 'node:test';
import assert from 'node:assert/strict';
import {transition, publicReview} from '../src/review.mjs';

const draft = () => ({source_id:'fl',external_id:'42',canonical_url:'https://www.fl.ru/projects/42/test.html',text:'Approved exact text',revision:1,state:'draft',approved_revision:null,claim_token:null,claimed_at:null,evidence:null,delivery_url:null});
const owner = {role:'owner',now:'2026-11-02T12:00:00Z'};
const agent = {role:'agent',now:'2026-11-02T12:01:00Z',newClaimToken:'A'.repeat(32)};
const act = (row,action,data={},ctx=owner) => transition(row,{action,revision:row.revision,...data},ctx);
const approved = () => act(draft(),'approve');
const queued = () => act(approved(),'queue');
const sending = () => act(queued(),'claim',{},agent);

test('only owner approves and approval binds exact revision',()=>{
  assert.equal(approved().approved_revision,1);
  assert.throws(()=>act(draft(),'approve',{},agent),/owner_required/);
  assert.throws(()=>act(draft(),'approve',{revision:2}),/stale_revision/);
  assert.throws(()=>act(draft(),'approve',{revision:true}),/stale_revision/);
});
test('save invalidates approval without mutating original',()=>{
  const before=approved(); const after=act(before,'save',{text:'Changed'});
  assert.deepEqual([after.state,after.revision,after.approved_revision],['draft',2,null]);
  assert.equal(before.state,'approved'); assert.equal(before.text,'Approved exact text');
  assert.equal(act(before,'save',{text:before.text}).state,'approved');
});
test('text validation rejects empty, overlong, non-string and NUL',()=>{
  for(const text of ['', ' ', 'x'.repeat(8001), null, 'x\0y']) assert.throws(()=>act(draft(),'save',{text}),/invalid_text/);
});
test('queue requires approval and repeated queue is idempotent',()=>{
  assert.throws(()=>act(draft(),'queue'),/approval_required/);
  const row=queued(); assert.deepEqual(act(row,'queue'),row);
  assert.throws(()=>act({...approved(),approved_revision:2},'queue'),/approval_required/);
});
test('claim preserves exact text, only agent can claim, no automatic reclaim',()=>{
  const row=sending(); assert.equal(row.text,draft().text); assert.equal(row.claim_token,agent.newClaimToken);
  assert.throws(()=>act(queued(),'claim'),/agent_required/);
  assert.throws(()=>act(row,'claim',{},agent),/review_locked/);
  assert.throws(()=>act(row,'save',{text:'other'}),/review_locked/);
  assert.throws(()=>act(row,'cancel'),/review_locked/);
});
test('cancel clears approval and increments revision',()=>{
  const row=act(queued(),'cancel'); assert.deepEqual([row.state,row.revision,row.approved_revision],['draft',2,null]);
});
test('uncertain blocks claim until evidence-based recovery',()=>{
  const row=act(sending(),'result',{outcome:'uncertain',evidence:'No response',claim_token:agent.newClaimToken},agent);
  assert.equal(row.state,'uncertain'); assert.throws(()=>act(row,'claim',{},agent),/review_locked/);
  const recovered=act(row,'result',{outcome:'not_sent',evidence:'Outgoing history checked',claim_token:agent.newClaimToken},agent);
  assert.deepEqual([recovered.state,recovered.revision,recovered.claim_token,recovered.approved_revision],['draft',2,null,null]);
  assert.throws(()=>act(recovered,'queue'),/approval_required/);
});
test('result requires claim, nonempty evidence, agent authorization',()=>{
  const data={outcome:'sent',evidence:'Observed in outgoing',claim_token:agent.newClaimToken};
  assert.throws(()=>act(sending(),'result',data),/agent_required/);
  assert.throws(()=>act(sending(),'result',{...data,claim_token:'wrong'},agent),/claim_mismatch/);
  assert.throws(()=>act(sending(),'result',{...data,evidence:''},agent),/invalid_text/);
  assert.throws(()=>act(sending(),'result',{...data,outcome:'retry'},agent),/invalid_outcome/);
});
test('delivery URL is same HTTPS host and strips query and fragment',()=>{
  const data={outcome:'sent',evidence:'Observed in outgoing',claim_token:agent.newClaimToken};
  const row=act(sending(),'result',{...data,delivery_url:'https://www.fl.ru/projects/42/test.html?token=hidden#x'},agent);
  assert.equal(row.delivery_url,draft().canonical_url);
  for(const delivery_url of ['http://www.fl.ru/x','https://evil.test/x','https://user:pass@www.fl.ru/x','https://www.fl.ru:444/x','https://www.fl.ru/\nx']) assert.throws(()=>act(sending(),'result',{...data,delivery_url},agent),/invalid_delivery_url/);
  assert.deepEqual(act(row,'result',data,agent),row);
});
test('public projection never leaks claim token or unknown private fields',()=>{
  const row={...sending(),private_secret:'do not expose'}; const result=publicReview(row);
  assert.equal(result.text,row.text); assert.equal('claim_token' in result,false); assert.equal('private_secret' in result,false);
});
test('missing or unknown role cannot mutate and unknown action rejects',()=>{
  assert.throws(()=>act(draft(),'save',{text:'new'},{now:owner.now}),/unauthorized/);
  assert.throws(()=>act(draft(),'delete'),/invalid_action/);
});
