# AutoBid configuration

## GitHub Repository Secrets

Required:

- `AUTOBID_DATABASE_URL`: external PostgreSQL connection URL. Use a small managed PostgreSQL database (for example Neon, Supabase, RDS, or an equivalent provider) with TLS required by the provider.
- `FREELANCER_ACCOUNTS_JSON`: JSON array matching `autobid.example.json`. It contains account IDs, usernames, token environment-variable names, enabled flags, and profile tags — never raw tokens.
- `FREELANCER_ACCOUNT_01_TOKEN`, `FREELANCER_ACCOUNT_02_TOKEN`, etc.: per-account OAuth2 access tokens. The bundled workflow maps slots 01–05; extend the explicit mapping if more accounts are approved.

Required only when LLM assistance is enabled:

- `LLM_API_KEY`.

Optional notifications:

- `TELEGRAM_BOT_TOKEN`.
- `TELEGRAM_CHAT_ID`.

Use GitHub Repository Variables for non-secret values such as `LLM_BASE_URL`, `LLM_MODEL`, thresholds, limits, and rollout switches. Do not put a token in a Repository Variable.

## Persistent state

GitHub-hosted runners are ephemeral. Actions cache and report artifacts are not an authoritative database: caches may be evicted and artifacts expire. AutoBid therefore requires external PostgreSQL in the workflow. The database enforces one `projects.project_id` and one `bids.project_id`, so concurrent/replayed runs cannot bid the same project through different accounts. Workflow concurrency adds another operational guard but is not the source of truth.

The service creates these tables idempotently: `projects`, `decisions`, `bids`, `accounts`, and `runs`. Give the database user permission to create these tables and indexes, and then read/insert/update them. Restrict network access and rotate the password according to the provider's guidance.

## LLM provider

Set all three values together:

- `LLM_BASE_URL`: OpenAI-compatible API root ending at `/v1` (the client adds `/chat/completions`).
- `LLM_API_KEY`: secret credential.
- `LLM_MODEL`: provider model identifier.

Every LLM operation requests a strict JSON schema. The rule engine remains authoritative for project budget, `MIN_ACCEPTABLE_BID`, `MAX_AUTO_BID`, and delivery bounds. Set `LLM_REQUIRED=true` to skip every project if the configured provider is unavailable or returns invalid structured data. With no LLM configured and `LLM_REQUIRED=false`, deterministic scoring/pricing/proposals remain available.

## Rollout (owner-controlled)

Never advance stages automatically:

1. Keep `AUTOBID_ENABLED=false`, `DRY_RUN=true`; run fake tests and inspect reports.
2. Add production OAuth tokens and perform real API search with `DRY_RUN=true`.
3. Only after owner review, set `AUTOBID_ENABLED=true`, `DRY_RUN=false`, `MAX_BIDS_PER_RUN=1`, and `MAX_BIDS_PER_DAY=2`.
4. Increase limits only after owner review of real results.

`EMERGENCY_STOP=true` always prevents live bid calls while preserving scanning and reports.

## Key variables

| Variable | Default | Meaning |
|---|---:|---|
| `AUTO_BID_SCORE` | 88 | Minimum score for an automatic bid candidate |
| `REVIEW_SCORE` | 75 | Minimum score shown as relevant/review |
| `MIN_ACCEPTABLE_BID` | 25 | Lowest permitted bid amount |
| `MAX_AUTO_BID` | 500 | Highest permitted automatic bid amount |
| `MAX_DELIVERY_DAYS` | 7 | Delivery ceiling |
| `PRICING_RULES_JSON` | built-in safe table | JSON object with `amount` and `days` for all five pricing categories |
| `MAX_BIDS_PER_RUN` | 1 | Global successful bids in one run |
| `MAX_BIDS_PER_DAY` | 2 | Global calendar-day limit (UTC) |
| `MAX_BIDS_PER_MONTH` | 20 | Global calendar-month limit (UTC) |
| `MAX_BIDS_PER_ACCOUNT_PER_DAY` | 1 | Per-account rolling 24-hour routing limit |
| `MAX_SEQUENTIAL_BID_FAILURES` | 3 | Circuit-breaker threshold |
| `MAX_RATE_LIMIT_ERRORS` | 2 | Repeated-429 circuit-breaker threshold |

`PRICING_RULES_JSON` must define every category, for example:

```json
{
  "simple_single_part": {"amount": 55, "days": 1},
  "small_batch": {"amount": 110, "days": 3},
  "large_batch": {"amount": 240, "days": 6},
  "complex_redraw": {"amount": 120, "days": 3},
  "sheet_metal_extended": {"amount": 180, "days": 5}
}
```
