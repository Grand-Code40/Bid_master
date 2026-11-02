# Freelancer AutoBid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a safe-by-default, finite-run Freelancer project scanner and bidder with durable cross-run idempotency.

**Architecture:** A typed orchestration service depends on narrow client, intelligence, repository, and notifier interfaces. PostgreSQL is authoritative in production; SQLite enables local/tests. The official Freelancer SDK stays behind an adapter and live bidding is disabled by default.

**Tech Stack:** Python 3.11+, stdlib dataclasses/sqlite/urllib, psycopg 3, freelancersdk 0.1.20, pytest.

**Spec:** `docs/superpowers/specs/2026-09-20-freelancer-autobid-design.md`

## Global Constraints

- Never automate CAPTCHA, KYC, SMS/email verification, fingerprinting, registration, or anti-bot bypass.
- Never send a live bid unless both `AUTOBID_ENABLED=true` and `DRY_RUN=false`.
- Never retry an ambiguous bid POST without first checking remote bids.
- One project receives at most one bid across the complete account pool.
- Runtime state is external PostgreSQL in GitHub Actions; artifacts/cache are not authoritative.
- Do not log secrets or store raw OAuth tokens.

## Review Focus

- An SDK payload missing optional nested keys must be normalized or skipped, not crash the run.
- Concurrent reservation of the same project must produce exactly one winner.
- A timeout followed by a visible remote bid must be recorded as sent without another POST.
- An impossible budget range must skip before proposal placement.
- Scanner progress must continue after the bidding circuit breaker opens.

---

### Task 1: Domain, configuration, and deterministic intelligence

**Files:**
- Create: `pyproject.toml`, `.env.example`, `autobid/config.py`, `autobid/models.py`
- Create: `autobid/intelligence/{classifier,scoring,pricing,proposal,llm}.py`
- Test: `tests/autobid/test_intelligence.py`, `tests/autobid/test_config.py`

**Interfaces:**
- Produces: `Settings.from_env()`, `score_project(Project) -> ScoreResult`, `price_project(Project, Settings) -> PriceResult`, `ProposalGenerator.generate(...)`.

- [ ] Write tests with literal expected threshold decisions, pricing clamps, malformed structured JSON failure, and two-specific proposal validation.
- [ ] Run `python -m pytest tests/autobid/test_config.py tests/autobid/test_intelligence.py -q`; expect import failures.
- [ ] Implement minimal dataclasses, strict environment parsing, deterministic rules, and bounded JSON LLM client.
- [ ] Re-run the same tests; expect all pass.

### Task 2: Durable storage and account pool

**Files:**
- Create: `autobid/storage/{database,migrations}.py`
- Create: `autobid/freelancer/accounts.py`
- Test: `tests/autobid/test_storage.py`, `tests/autobid/test_accounts.py`

**Interfaces:**
- Consumes: `Settings`, project/account dataclasses.
- Produces: `Database.migrate`, `reserve_project`, `save_decision`, `record_bid`, counter queries; `AccountRouter.select`.

- [ ] Write tests for duplicate reservation across runs/accounts, daily/monthly counters, quota exhaustion, routing affinity and round-robin fallback.
- [ ] Run targeted tests; expect missing modules.
- [ ] Implement parameterized SQLite/PostgreSQL repository with unique `project_id` reservation and account statistics.
- [ ] Re-run targeted tests; expect all pass.

### Task 3: Official API adapter and safe bidding

**Files:**
- Create: `autobid/freelancer/{client,projects,bidding}.py`
- Test: `tests/autobid/test_freelancer.py`

**Interfaces:**
- Produces: `FreelancerClient` protocol and `SdkFreelancerClient`; typed `AuthError`, `RateLimitError`, `EligibilityError`, `AmbiguousBidError`; `safe_place_bid`.

- [ ] Write fake-boundary tests for payload normalization, auth/429 mapping, one-shot placement, timeout reconciliation, and remote duplicate detection.
- [ ] Run targeted tests; expect missing modules.
- [ ] Implement official SDK calls behind lazy imports and safe exception mapping.
- [ ] Re-run targeted tests; expect all pass.

### Task 4: Orchestration, reports, notifications, and CLI

**Files:**
- Create: `autobid/service.py`, `autobid/reporting/{report,notifier}.py`, `autobid/cli.py`
- Test: `tests/autobid/test_service.py`, `tests/autobid/test_reporting.py`

**Interfaces:**
- Consumes: prior client/intelligence/storage interfaces.
- Produces: `AutoBidService.run() -> RunReport`, `python -m autobid.cli run|scan`.

- [ ] Write service tests for closed/processed skip, dry-run, disabled mode, same project/two accounts, limits, emergency stop, auth failure, 429 sequence, and scan continuation.
- [ ] Run targeted tests; expect missing service.
- [ ] Implement finite orchestration and redacted JSON/Markdown/Telegram reporting.
- [ ] Re-run targeted tests; expect all pass.

### Task 5: Workflow and operator documentation

**Files:**
- Create: `.github/workflows/freelancer-autobid.yml`
- Create: `docs/autobid/{README,CONFIGURATION,SECURITY}.md`, `autobid.example.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: CLI and environment contract.
- Produces: scheduled/manual finite GitHub Actions run and owner runbook.

- [ ] Add workflow with cron, dispatch, concurrency, targeted tests, CLI, summary and artifact upload.
- [ ] Document secrets, PostgreSQL setup, staged rollout, official API boundary, no account-provisioning endpoint, and manual dry/production commands.
- [ ] Run `python -m pytest tests/autobid -q`; expect all tests pass.
- [ ] Run `python -m compileall -q autobid`; expect exit 0.
