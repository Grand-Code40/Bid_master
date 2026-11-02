# Review flow implementation
Spec: ../specs/2026-11-02-review-flow-design.md
Base: c3ce3ac. Isolated existing D: worktree, branch feat/review-flow.

## Global constraints
No external bid, no false sent badge, no local secrets in GitHub. Preserve existing Windows launcher and discovery data. No capacity scheduling. User has authorized local integration and GitHub upload.

## Task 1 — Review storage and API
Write failing behavior tests for durable drafts, revisions, approval, queue and claims. Implement SQLite transactional review store and localhost API. Expected: focused tests pass and stale approval cannot be sent.

## Task 2 — Agent handoff
Write failing CLI/import tests. Add strict known-source URL/field validation, sparse observations, CLI ingest/draft/queue/claim/result/status. Expected: unknown fields/hosts rejected; existing FL data preserved; queue returns exact approved text. Add portable instructions.

## Task 3 — Simplify UI
Implement order list, reply side panel, explicit approve then queue action, neutral design, secondary settings. Expected: real browser walkthrough succeeds on desktop and 390px, no console errors or overflow. Existing monitor/error behavior remains.

## Task 4 — Verify, review and deliver
Full pytest suite, browser checks, packaging/CLI smoke. One fresh independent whole-branch review. Fix material issues, merge original branch, restart owned app and push existing repository. Expected: clean git status and verified remote commit.

## Review focus
Approval race across tabs/processes; claim crash and unknown delivery; malformed imported listings; untrusted text/links; idle UI refresh overwriting edits; data paths portability; accidental secrets; public hosting claims.
