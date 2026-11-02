# Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Merge the collector and make the local CAD command center available through one Windows shortcut.
**Architecture:** Reuse discovery storage and scanner through a loopback HTTP service. Static browser UI consumes JSON endpoints. PowerShell and a Windows shortcut launch the existing Python environment.
**Tech Stack:** Python 3.11+, SQLite, stdlib HTTP, vanilla HTML/CSS/JS, Windows PowerShell.
**Spec:** docs/superpowers/specs/2026-11-02-command-center-design.md

## Global Constraints
- Data/temp/logs/profiles on D:\DrawingAI_runs only.
- Real data, no outgoing proposals or registrations, no additional dependencies.
- Loopback binding, Host validation, CSRF token, safe rendering of untrusted listing content.
- Existing user authorization includes local merge and launch. Native execution continues without another approval gate.

## Review Focus
- Repeated launch or foreign port occupant: reopen only the matching command center.
- Refresh during another scan or stop: preserve saved data and expose busy/failure states.
- Untrusted website content: render as text, only permit verified source links.
- Hidden process launch failure: show a useful Windows error instead of silently disappearing.
- Missing/unknown budget and bid count: preserve distinction from zero.

## Task 1: Local service
**Files:** autobid/command_center/{__init__.py,controller.py,server.py}; tests/command_center/test_server.py.
**Interfaces:** CenterController(paths, fetcher_factory=HttpFetcher); snapshot(), start_scan(), set_monitor(enabled, interval_minutes), close(); create_server(controller, port=8765).
- [x] Add meaningful tests of real SQLite snapshots and HTTP boundaries, asynchronous scan exclusion, reporting failure and schedule settings.
- [x] Run targeted pytest; expected failure because the new API is absent.
- [x] Implement loopback server, protected mutations and asynchronous collector lifecycle.
- [x] Run targeted and full pytest; expected all pass.
- [x] Commit service.

## Task 2: UI and one-button launch
**Files:** autobid/command_center/static/{index.html,app.css,app.js}; autobid/command_center/__main__.py; scripts/Start-CommandCenter.ps1; pyproject.toml; docs/autobid/COMMAND_CENTER.md; tests/command_center/test_launch.py.
**Interfaces:** HTTP /api/state, /api/scan, /api/monitor, /api/stop; launcher main(argv).
- [x] Add launcher regression tests for reusing a matching service and rejecting a foreign port.
- [x] Run targeted tests; expected failures for absent launch behavior.
- [x] Build responsive Russian dashboard, hidden launcher and useful startup errors; package static assets.
- [x] Verify actual browser behavior and run full suite.
- [x] Commit, obtain one fresh whole-change review, address important findings, merge locally as already authorized.
- [x] Install a shortcut in the project folder and Windows Desktop, launch it twice, verify one service.


Verified after local merge: 104 tests passed; Desktop shortcut opened the same server twice (PID 14168, one listener); 61 saved listings. Monitoring is off initially.
