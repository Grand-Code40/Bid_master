# Freelancer AutoBid

AutoBid is a finite-run, isolated subsystem for discovering Freelancer projects that match the Drawing_AI_Core capability: converting photos, scans, sketches, and PDFs into accurate 2D CAD/DXF/DWG/SVG files for laser, plasma, waterjet, and CNC production.

It uses Freelancer's official OAuth API through the official Python SDK. It does not use Selenium/Playwright, registration automation, CAPTCHA/KYC/verification bypasses, fingerprinting, or anti-bot workarounds.

## What one run does

1. Opens durable state and records a run.
2. Authenticates the enabled account pool without storing passwords.
3. Searches active Freelancer projects.
4. Atomically reserves only project IDs not seen before.
5. Applies hard filters, deterministic/optional-LLM scoring, bounded pricing, and proposal validation.
6. Routes one eligible account and checks for a remote bid.
7. Records the full proposal before any bid POST.
8. In safe mode, records an intended bid; in explicitly enabled live mode, performs one official API bid attempt.
9. Writes `report.json`, `report.md`, and the GitHub Actions step summary, then exits.

There is no daemon. The workflow runs at 09:00 and 18:00 Europe/Moscow (`0 6,15 * * *`) and supports manual dispatch.

## Local safe run

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[test]"
$env:DATABASE_URL = "sqlite:///autobid-local.db"
$env:AUTOBID_ENABLED = "false"
$env:DRY_RUN = "true"
$env:FREELANCER_ACCOUNTS_JSON = '[{"account_id":12345678,"username":"cad_profile_01","token_env":"FREELANCER_ACCOUNT_01_TOKEN","profile_tags":["dxf","laser"]}]'
$env:FREELANCER_ACCOUNT_01_TOKEN = "<OAuth token>"
.\.venv\Scripts\python.exe -m autobid.cli scan
```

Linux/GitHub runner:

```bash
python -m pip install -e '.[test]'
AUTOBID_ENABLED=false DRY_RUN=true python -m autobid.cli scan
```

`scan` always forces safe mode. `run` honors `AUTOBID_ENABLED` and `DRY_RUN` from the environment:

```bash
python -m autobid.cli run
```

Do not use SQLite for GitHub Actions. See [CONFIGURATION.md](CONFIGURATION.md) for external PostgreSQL and rollout setup.

## Implementation map

- `freelancer/`: official SDK adapter, account routing, and one-shot/reconciled bidding.
- `intelligence/`: scoring, hybrid bounded pricing, structured LLM provider, and proposal validation.
- `storage/`: PostgreSQL/SQLite schema and transactional idempotency.
- `reporting/`: JSON/Markdown reports and optional Telegram notifier.
- `service.py`: one complete run and circuit breaker.
- `cli.py`: `scan` and `run` commands.

Official references: [Freelancer Python SDK](https://github.com/freelancer/freelancer-sdk-python) and [Freelancer Developer Portal](https://developers.freelancer.com/).

