# Freelancer AutoBid Design

## Intent and rollout

Build an isolated Python subsystem that scans Freelancer through its official OAuth API, evaluates Drawing_AI_Core fit, prepares bounded bids, routes one enabled account, persists every decision, and emits JSON/Markdown reports. It must run as a finite GitHub Actions job twice daily and on demand. Initial rollout is permanently safe-by-default: `DRY_RUN=true` and `AUTOBID_ENABLED=false`; enabling live bids is an explicit owner action.

No browser automation, CAPTCHA/KYC/verification bypass, password storage, or automated account registration is in scope. The official SDK exposes users, projects, and bids but no suitable public provisioning operation, so account creation and OAuth bootstrap remain normal manual Freelancer procedures.

## Architecture

`autobid` is independent of the drawing pipeline. Dataclasses in `models.py` are the internal contract. `freelancer/` adapts the official `freelancersdk` and normalizes unstable external payloads. `intelligence/` combines deterministic relevance and pricing rules with an OpenAI-compatible structured-JSON provider. `storage/` owns schema, counters, unique project reservations, and bid state. `reporting/` owns reports and notification interfaces. `service.py` orchestrates a single bounded run; `cli.py` is the only entry point.

Production persistence is PostgreSQL supplied as `DATABASE_URL`. A unique project row and transactional `reserve_project` operation protect the whole account pool from duplicate bids. SQLite is supported only for local development and unit tests. GitHub cache/artifacts are reports, never authoritative anti-duplicate state.

## Run flow and safety

The service opens a run, authenticates enabled accounts, scans active projects, and records only unseen projects. Hard filters execute before intelligence: non-open/awarded-not-biddable, empty descriptions, missing/unsafe budgets, existing local or remote bid, limits, disabled accounts, and emergency stop. Deterministic scoring produces a 0–100 baseline and reason codes. When configured, the LLM must return schema-valid JSON for classification, pricing, and proposal; malformed output causes a skip. Rule pricing always clamps to project budget and configured safety bounds.

Before `place_project_bid`, the service checks state, queries account bids where supported, and transactionally reserves the project. A placement timeout is never blindly retried: the adapter queries bids to reconcile the result and records `UNKNOWN` if still ambiguous. Authentication, policy/restriction, repeated 429, balance, or a configured sequence of bid failures activates the current-run circuit breaker while scanning and reporting continue.

## Account routing and limits

Accounts come only from `FREELANCER_ACCOUNTS_JSON`, containing non-secret metadata plus names of token environment variables; raw tokens never enter state, logs, reports, or exceptions. Routing first filters enabled/quota-eligible accounts, then ranks profile-tag overlap, success rate, rating, and recent use. With insufficient history it uses persisted least-recently-used/round-robin behavior. Limits are enforced globally per run/day/month and per account/day.

## Intelligence contracts

Scoring favors photo/image/PDF/scan/sketch inputs, 2D CAD and DXF/DWG/SVG outputs, fabrication context, dimensional accuracy, contour cleanup, batches, and follow-on work. It penalizes complex new 3D, visualization/rendering, PCB, artistic-only work, suspicious content, low budget, and off-domain projects. Thresholds default to AUTO_BID 88 and REVIEW 75.

Pricing uses category base prices, complexity/batch multipliers, project budget, configured minimum/maximum, and optional bounded LLM recommendation. If no safe amount exists or it exceeds `MAX_AUTO_BID`, the project is skipped. Delivery is similarly bounded by `MAX_DELIVERY_DAYS`.

Proposal generation must mention at least two extracted project specifics, stay concise, and never invent experience, clients, or completed work. The full proposal is persisted before any remote mutation.

## API boundary

The adapter uses official SDK operations `get_self`, `search_projects`, `get_project_by_id`, `get_bids`, and `place_project_bid`. It maps SDK exceptions and HTTP semantics into authentication, rate-limit, eligibility/policy, temporary, and ambiguous-placement errors. Read operations may use bounded retries; the bid POST itself is attempted once.

## Reporting and operations

Every run writes `report.json` and `report.md`, appends Markdown to `GITHUB_STEP_SUMMARY`, and optionally sends Telegram notifications when both Telegram secrets exist. Notifications cover each successful bid, authentication failures, emergency stop, and the run summary. Sensitive values are redacted by construction.

The workflow runs at `0 6,15 * * *`, supports `workflow_dispatch`, uses a non-cancelling `freelancer-autobid` concurrency group, installs the package, runs targeted AutoBid tests, executes one CLI run, and uploads non-sensitive reports.

## Verification

Unit tests use fake clients and temporary SQLite databases, never production APIs. They cover duplicate prevention across runs/accounts, thresholds and closed projects, routing/quota exhaustion, pricing bounds, dry-run/disabled modes, placement timeout reconciliation, 429/auth circuit breaking, malformed LLM JSON, monthly limits, and emergency stop.
