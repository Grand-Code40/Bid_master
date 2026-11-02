# Review flow and cloud handoff
The owner wants a simpler command center: choose a CAD order, read a prepared reply, edit, approve, then respond. They will give the GitHub project to cloud dot. Existing Windows one-click startup must keep working.

## Scope
- Neutral white/charcoal interface, one blue action color, readable Russian text, clear order list and inline reply panel. No decorative hero, metric cards or green palette.
- Persist drafts and approval revisions. Editing revokes approval. Respond queues the exact approved revision; it does not claim that a message was sent.
- A local agent CLI imports browser-observed listings from known sources, claims queued replies atomically and records verified delivery. No agent command approves replies. Sending or uncertain deliveries cannot be retried automatically.
- Initial drafts use task title and observed formats, openly preliminary and editable; no invented expertise, price or deadlines. dot can replace drafts with personalized text for owner review.
- FL native collector remains HTTP on a 30/60 minute timer. Additional sources are agent imports until tested connectors exist.
- Portable install/run instructions, JSON example, exact dot handoff prompt, clear separation of cloud computer and public hosting.
- Upload reviewed code to existing origin without overwriting remote changes. No website deployment, real registration or actual bid in this work.

## Verification
Exercise persistence, stale revisions, editing invalidation, atomic claims, delivery evidence, no duplicate retry, source validation and sparse import. Test UI with real local SQLite fixtures, keyboard/mobile layouts and failures. Keep all runtime/test artifacts on D:.
