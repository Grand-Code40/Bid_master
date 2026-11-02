# Source Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Read real CAD listings from FL.ru, retain and refresh them without duplicates, and support resumable browser-based source/account connection without sending bids.

**Architecture:** Add a separate discovery package beside the existing finite AutoBid service. Source adapters normalize observations; independent storage tracks listings, source health and connection checkpoints. An HTTP reader and a dedicated persistent browser reader share the same adapter interface; the CLI produces a readable report.

**Tech Stack:** Python >=3.11, SQLite, Beautiful Soup for HTML extraction, optional Playwright Chromium browser transport, pytest. Pin compatible dependency ranges during implementation after consulting the official documentation. Reuse the existing Python environment for verification when possible; new browser installations and caches must reside on D:.

**Spec:** `docs/superpowers/specs/2026-11-02-source-access-design.md`

**Status:** Implemented in branch feat/source-access. Native execution and fresh whole-branch review completed; both Important findings have regression coverage. Local integration decision remains with the owner.

## Global Constraints

- “Искать широкий набор CAD-задач, включая сложные 3D-задачи. Выполнимость определяет владелец.”
- “Не добавлять планирование загрузки и резервирование рабочего времени.”
- “Опубликованный бюджет не считать фактической оплатой.”
- “Тяжёлые данные, профили браузера, временные файлы и результаты проверок размещать только в D:\DrawingAI_runs\<задача-дата>.”
- Preserve existing AutoBid behavior and its 39 tests. Never use its processed-project reservation to suppress discovery updates.
- First live adapter: FL.ru public engineering listings and project detail pages. Freelance.ru and Telegram are unverified registry entries; Kwork requires resolving its published automated-access restrictions before implementing an automated collector.
- Exact identity is `(source_id, external_id)`; keep uncertain cross-source duplicate candidates separate.
- No bids, messages, payments, document uploads or autonomous contract acceptance in the discovery process.
- Use CAIgraph as the default public brand; retain Константин Аистов and Casei as alternative public display names. No fabricated legal identity, location or extra accounts.
- No passwords, verification codes, session cookies or private mailbox content in code, tests, fixtures, reports or commits.
- An already signed-in ChatGPT browser proves site access, not access for a background Python worker. Use a separately verified persistent browser profile for the worker; never extract ChatGPT cookies.
- Enable no recurring job or paid service during verification. Provide a finite scan first and a separately invoked watcher.

## Review Focus

- Repeated observations that omit a field must not erase an earlier verified value: storage test in Task 1.
- A login page, CAPTCHA or consent screen returned with HTTP 200 must not become an empty successful scan: parser/transport tests in Task 2.
- Salary ranges, contests and “по договоренности” must not be interpreted as fixed-price CAD orders: normalization tests in Task 2.
- A source failure or interrupted scan must preserve earlier observations and report partial coverage: orchestration tests in Task 3.
- Browser profile contention and overlapping watcher runs must fail clearly without damaging the profile or double-counting observations: lifecycle tests in Task 4.

## File Structure

- `autobid/discovery/models.py`: normalized listings, observations, source definitions and status enums.
- `autobid/discovery/registry.py`: source URLs, capabilities and verified/unverified registration state.
- `autobid/discovery/storage.py`: independent SQLite schema, observations, source health and connection checkpoints.
- `autobid/discovery/fetch.py`: bounded HTTP transport and typed access results.
- `autobid/discovery/browser.py`: optional persistent-browser transport and interactive connection lifecycle.
- `autobid/discovery/fl.py`: FL.ru list/detail parsing and source-specific access detection.
- `autobid/discovery/service.py`: finite scan orchestration, refreshes and partial-failure handling.
- `autobid/discovery/report.py`: source health, listing changes and budget statistics with coverage labels.
- `autobid/discovery/cli.py`: `sources`, `scan`, `import-url`, `connect`, `report`, `watch`.
- `autobid/discovery/runtime.py`: D:-rooted paths and process/profile locking.
- `tests/discovery/`: focused tests and small sanitized HTML fixtures from observed public pages.
- `docs/autobid/DISCOVERY.md`: operator instructions, commands, actual support matrix and limitations.
- `pyproject.toml`: optional browser/parser dependencies, CLI entry point, include new tests in the default suite.

## Task 1: Durable observations and source registry

**Files:** models, registry, storage; `tests/discovery/test_storage.py`, `test_registry.py`.

**Interfaces:**

- `Listing`: source_id, external_id, canonical_url, title, description, listing_kind, cad_categories, budget_min/max (Decimal or null), currency, budget_unit, bids_count (int or null), published_at (aware datetime or null), availability, requested_formats and explicit_constraints.
- `Observation`: listing, observed_at, field_provenance and `present_fields`. Omitted fields differ from fields explicitly supplied as unknown.
- `DiscoveryDatabase(path: Path)` with `migrate()`, `upsert(observation) -> ChangeKind`, `list_listings(source_id: str | None = None)`, `set_source_state(...)`, `save_connection_step(...)`, `get_connection_step(...)`, `close()`.
- `SourceSpec`: id, allowed_hosts, listing_urls, registration_url, transport capabilities and verified capability flags.

- [x] Write failing tests: two observations with the same identity yield one listing and two observations; updated budget/status are retained; omitted descriptions do not overwrite known text; equal external IDs on different sources remain separate; unknown budget is null rather than zero; connection checkpoint resumes without storing credential values.
- [x] Run the new tests with `.venv\Scripts\python.exe -B -m pytest tests/discovery/test_storage.py tests/discovery/test_registry.py -q -p no:cacheprovider --basetemp D:\DrawingAI_runs\bid-master-source-access-2026-11-02\pytest-task1`. Expect failures for missing implementation.
- [x] Implement the dataclasses and a separate SQLite schema. Preserve immutable observations and update the current listing transactionally. Store public names as non-secret configuration; keep email/credential references outside tracked configuration.
- [x] Rerun the same tests. Expect all assertions to pass.
- [x] Commit this testable unit in the execution worktree.

## Task 2: Verified FL.ru reader with explicit access results

**Files:** fetch, fl, browser; `tests/discovery/test_fl.py`, `test_fetch.py`, `test_browser.py`, sanitized fixtures; parser/browser dependencies.

**Interfaces:**

- `FetchResult(url: str, status_code: int | None, html: str | None, access_state: SourceStatus, observed_at: datetime, error_code: str | None)`.
- `Fetcher.fetch(url: str) -> FetchResult`; HTTP and browser implementations obey this interface.
- `FlSource.parse_list(result: FetchResult) -> list[Observation]` and `FlSource.parse_detail(result: FetchResult) -> Observation`.
- `FlSource.canonicalize(url: str) -> str` accepts only known FL.ru listing/detail URLs; reject unsupported hosts/schemes before reading.
- `BrowserSession(profile_dir: Path)` opens an isolated persistent Chromium context; `connect(source: SourceSpec, public_profile: PublicProfile) -> ConnectionCheckpoint` fills only supported non-binding profile fields and reports the next required step. An account is marked connected only after a source-specific authenticated marker is observed.

- [x] Inspect current public list and detail DOM through the authorized browser. Capture only the small page fragments needed for fixtures, excluding advertising, mailbox data, credentials and personal account content. Put raw observations on D:, not in the repository.
- [x] Write failing tests with literal expected values for fixed price, range, missing budget, bids count zero vs unknown, salary/vacancy, closed project, and relative dates with observation time recorded. Include HTTP-200 login/challenge pages and unexpected page structure; these return an explicit access/error state instead of a successful empty list.
- [x] Test that credential values never appear in `FetchResult`, exception messages or connection checkpoints. Test unsupported URL rejection and bounded retry behavior for timeouts/429.
- [x] Run `tests/discovery/test_fl.py`, `test_fetch.py`, `test_browser.py` with D:-based temporary storage and expect failures.
- [x] Implement parsing from the observed markup. Preserve original currency/unit and raw date when exact timestamp cannot be determined. Do not invent exact dates. In HTTP mode cap response size, requests and retries. Browser mode uses supported page interaction and does not evade explicit site/account restrictions.
- [x] Implement connection checkpoints: `NOT_STARTED`, `FORM_READY`, `EMAIL_VERIFICATION`, `PHONE_VERIFICATION`, `HUMAN_CHECK`, `TERMS_CONFIRMATION`, `AUTHENTICATED`, `ACCESS_VERIFIED`, `FAILED`. Do not turn a successful form submission into proof of account creation; verify the resulting page.
- [x] Rerun the same tests. Expect all assertions to pass. Live account creation is not a prerequisite for passing transport tests.
- [x] Commit this testable unit.

## Task 3: Finite scanning, reports and operator CLI

**Files:** service, report, cli; `tests/discovery/test_service.py`, `test_cli.py`; CLI entry point.

**Interfaces:**

- `DiscoveryService(database, registry, fetcher).scan(source_ids: list[str], max_pages: int, max_details: int) -> ScanReport`.
- `ScanReport`: scan_id, timestamps, visited sources, source outcomes, new/updated/unchanged counts, incomplete coverage and report paths; never credentials.
- `write_report(report, listings, output_dir: Path) -> ReportPaths` produces JSON and Markdown; budgets grouped by currency and publication kind, denominators shown.
- `main(argv: list[str] | None = None) -> int`: finite `scan` by default, maximum 2 list pages and 10 detail pages in initial verification. `import-url` dispatches only to a supporting adapter. `sources` shows verified capabilities; `connect` opens the interactive connection session; `report` reads existing state.

- [x] Write failing integration tests using fixture transports: initial scan persists the expected listings; second scan updates one budget and one closed status without duplicates; one inaccessible source does not lose data from a successful source; a detail failure preserves the list observation and labels coverage incomplete; a novel unsupported URL is rejected without claiming to scrape it.
- [x] Add CLI tests proving public `scan` works without Freelancer OAuth, LLM, Telegram or email credentials and cannot call the existing bid-placement service. `sources` must distinguish unverified sources from accessible ones.
- [x] Run these tests with D:-based basetemp and expect failures.
- [x] Implement the finite service, report and CLI. Reuse project conventions; keep existing `autobid.cli scan/run` semantics intact. Update pytest discovery to include both old and new suites.
- [x] Rerun the same tests. Expect all assertions to pass.
- [x] Commit this testable unit.

## Task 4: Safe local lifecycle and end-to-end verification

**Files:** runtime and watcher CLI; `tests/discovery/test_runtime.py`; `docs/autobid/DISCOVERY.md`.

**Interfaces:**

- `RuntimePaths.from_root(root: Path)` resolves database, browser profile, reports and temporary directories under the explicit data root. Windows default root is `D:\DrawingAI_runs\bid-master-source-access-2026-11-02`; fail with an actionable message if unavailable instead of silently falling back to C:.
- `RunLock(root: Path)` excludes overlapping writers and browser-profile users; lock state must not contain secrets. Release on normal exit; documented recovery for an abandoned lock.
- `watch --interval-seconds 3600` invokes finite scans and waits interruptibly. It runs only when explicitly started; installing a Windows scheduled task or background service is out of this delivery.

- [x] Write failing tests: conflicting lock refuses the second writer; an exception releases ownership; path validation rejects escape from the configured root; missing D: does not create files on C:; fake clock verifies watcher interval and interruption without real long sleeps.
- [x] Run these tests and expect failures, then implement path/lifecycle logic and rerun to passing.
- [x] Run the full suite once: `.venv\Scripts\python.exe -B -m pytest tests -q -p no:cacheprovider --basetemp D:\DrawingAI_runs\bid-master-source-access-2026-11-02\pytest-full`. Confirm all original 39 tests and new tests pass.
- [x] Run a bounded live public FL.ru scan and compare at least two listing titles, links, budgets and visible counters against the browser. Repeat once to verify updates and duplicate handling. If runtime network access differs from the agent browser, report that limitation instead of using fabricated observations or declaring the connector complete.
- [x] Run a browser session continuity check in the dedicated profile without creating an account: browser transport can revisit a public page after reopening. Verify actual authenticated persistence separately only after an owner-authorized login/registration.
- [x] Document commands, verified source capabilities, account-connection steps still requiring user participation, current data coverage, and cleanup paths/sizes. No claimed support for unverified sites and no claim of complete market coverage.
- [x] Commit the final unit and perform a whole-change review before reporting implementation complete.

## Self-review

The tasks cover the registry, non-destructive refreshes, read-only collection, manual URL entry, browser sessions, resumable account connection, finite runs, optional repetition, reports and D:-only artifacts. Live email/password/phone verification depends on owner-approved external steps and is not replaced by mock tests. Full UI, outgoing bids, messaging, workload planning and autonomous web-wide source discovery remain outside this first delivery as specified. No production account or recurring job has been created while preparing this plan.
