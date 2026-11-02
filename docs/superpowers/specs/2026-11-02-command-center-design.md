# CAIgraph command center
User request: merge the discovery branch and provide one Windows launch button.
Execution authorization: the user explicitly requested implementation and merging.
The existing Python collector has no graphical UI. Build a small local web UI over its real database.

## Scope and decisions
- Reuse the current Python environment, SQLite database and FL.ru adapter.
- One Windows shortcut launches a hidden process and opens the default browser at http://127.0.0.1:8765/.
- Repeated launches reopen the same service. A foreign process on that port produces a clear error.
- Show actual saved listings, budgets, bid counts, source health and last successful update.
- Search and filter orders/vacancies, availability and known budgets. Show full saved details and original source links.
- Manual refresh runs a bounded scan in the background; concurrent scans cannot duplicate work.
- Optional monitoring every 30 or 60 minutes, off initially, with durable settings and a visible next-run time.
- A stop control shuts down the local service; closing a browser tab alone leaves it running.
- No proposals, registrations or external messages are sent by this UI.
- Every runtime artifact stays under D:\DrawingAI_runs. Reuse the existing discovery data root.
- Local HTTP only, strict Host checking, random CSRF token on mutations, no external UI resources.
- New UI copy is Russian. Unknown budgets and bids remain unknown.
- Stored source HTML/text never executes in the UI.

## Approach
A stdlib Python HTTP server plus HTML/CSS/JavaScript requires no new runtime dependencies.
A desktop GUI would require another toolkit; a packaged Electron app would be disproportionate.
This is the implementer's choice for the requested one-button local launch, not a claim that the user chose a framework.

## Validation
Full Python suite after merges; controlled HTTP tests for data, refresh, locking, origin/token checks and shutdown.
Real Edge browser check for layout, filtering, source detail and refresh.
Launch the Windows shortcut twice and verify a single service process.

