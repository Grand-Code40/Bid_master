# AutoBid security and policy boundaries

## Credentials

- Store OAuth tokens and database/LLM/Telegram credentials only in GitHub Secrets or a local uncommitted environment.
- Do not store Freelancer passwords. `FREELANCER_ACCOUNTS_JSON` references token environment-variable names; it does not contain tokens.
- Reports contain project/account metadata and API result IDs, never credential values.
- `.env` and local database files are gitignored. `.env.example` contains names and safe defaults only.

## Allowed automation

AutoBid uses official Freelancer SDK operations for OAuth sessions, current-user lookup, active project search, project details, bid lookup, and bid placement. A live placement is attempted once. If the POST times out, AutoBid queries project bids; if it cannot reconcile the outcome, it records `UNKNOWN`, opens the circuit breaker, and does not blindly retry.

The official public SDK documents user lookup/profile operations but no suitable account-provisioning endpoint. Initial account creation, consent, email/SMS verification, KYC, and OAuth authorization must therefore be completed through Freelancer's normal supported user flow. Add the resulting OAuth token to GitHub Secrets afterward.

Never add CAPTCHA solving, KYC or verification bypass, fingerprint manipulation, anti-bot evasion, password-based login, or browser automation for ordinary bidding.

## Emergency behavior

The current run stops live bidding on authentication failures, policy/account restrictions, unresolved placement timeouts, repeated rate limits, configured emergency stop, or the sequential-failure threshold. Project scanning and reporting continue where an authenticated scanner remains available.

Because a failed/unknown project remains processed, the safety bias is toward missing an opportunity rather than risking a duplicate bid. Operators can inspect PostgreSQL and the report before any manual recovery.

## Incident response

1. Set the GitHub Repository Variable `EMERGENCY_STOP=true`.
2. Rotate the affected OAuth/API secret.
3. Inspect `runs`, `projects`, and `bids`, especially `UNKNOWN` rows.
4. Confirm remote Freelancer bid state manually through supported interfaces.
5. Re-enable only after the account/API issue is resolved.
