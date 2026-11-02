from __future__ import annotations

import argparse
from contextlib import nullcontext
import os
from pathlib import Path
import sqlite3

from .fetch import HttpFetcher
from .models import ConnectionStep, PublicProfile
from .registry import SOURCES
from .report import write_report
from .runtime import DEFAULT_ROOT, RuntimePaths, RunLock, runtime_environment, run_watch
from .service import DiscoveryService, ScanReport, ScanInterrupted
from .storage import DiscoveryDatabase



def build_parser():
    parser = argparse.ArgumentParser(description="CAIgraph: read-only CAD market discovery")
    parser.add_argument("--data-root", type=Path, default=Path(os.environ.get("DISCOVERY_DATA_ROOT", str(DEFAULT_ROOT))))
    parser.add_argument("--transport", choices=("http", "browser"), default="http")
    parser.add_argument("--browser-channel", choices=("msedge", "chrome"), default="msedge" if os.name == "nt" else None)
    subs = parser.add_subparsers(dest="command", required=True)
    subs.add_parser("sources", help="Verified capabilities and current source health")
    for name in ("scan", "watch"):
        scan = subs.add_parser(name, help="Read-only bounded scans" if name == "watch" else "One bounded read-only scan")
        scan.add_argument("--source", action="append", dest="sources")
        scan.add_argument("--max-pages", type=int, default=2)
        scan.add_argument("--max-details", type=int, default=10)
        if name == "watch":
            scan.add_argument("--interval-seconds", type=int, default=3600)
    imported = subs.add_parser("import-url", help="Read one supported project URL")
    imported.add_argument("url")
    subs.add_parser("report", help="Render saved observations")
    connect = subs.add_parser("connect", help="Open dedicated browser profile for account connection")
    connect.add_argument("source", choices=tuple(SOURCES))
    connect.add_argument("--register", action="store_true", help="Open registration instead of existing-account login")
    connect.add_argument("--no-wait", action="store_true", help="Save checkpoint and close instead of waiting for owner")
    connect.add_argument("--display-name", default="CAIgraph")
    return parser


def connect_account(args, db, paths):
    from .browser import BrowserSession
    from .fl import FlSource
    source = SOURCES[args.source]
    if not source.implemented:
        raise ValueError("Connection adapter not verified for this source")
    try:
        with BrowserSession(paths.child(f"profiles/{source.id}"), headless=False, channel=args.browser_channel) as browser:
            step = browser.connect(source, PublicProfile(args.display_name, os.environ.get("DISCOVERY_EMAIL")), register=args.register)
            while True:
                db.save_connection_step(source.id, step)
                print(f"Connection checkpoint: {step.value}", flush=True)
                if step == ConnectionStep.AUTHENTICATED:
                    result = browser.fetch(source.listing_urls[0])
                    try:
                        FlSource().parse_list(result)
                    except ValueError:
                        pass
                    else:
                        if browser.check_connection() == ConnectionStep.AUTHENTICATED:
                            db.save_connection_step(source.id, ConnectionStep.ACCESS_VERIFIED)
                            print("Connection checkpoint: access_verified")
                    break
                if args.no_wait:
                    break
                answer = input("Complete the required step in the browser; Enter to recheck, q to save and close: ")
                if answer.strip().lower() == "q":
                    break
                step = browser.check_connection()
    except (KeyboardInterrupt, EOFError):
        raise
    except Exception:
        raise RuntimeError("Account connection could not finish; checkpoint retained, retry connect") from None
    return 0


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        paths = RuntimePaths.from_root(args.data_root)
        paths.prepare()
        with runtime_environment(paths), RunLock(paths.root), DiscoveryDatabase(paths.child("discovery.sqlite3")) as db:
            if args.command == "sources":
                states = db.source_states()
                for key, source in SOURCES.items():
                    state = states.get(key, {}).get("state", "unverified")
                    print(f"{key}: {state}; implemented={source.implemented}; access={source.automated_access}; observed={','.join(source.verified_capabilities) or 'none'}; connection={db.get_connection_step(key).value}")
                return 0
            if args.command == "connect":
                return connect_account(args, db, paths)
            if args.command == "report":
                report = ScanReport(mode="snapshot", incomplete=True)
                output = write_report(report, db.list_listings(), paths.child("reports"), source_states=db.source_states(), records=db.listing_records())
                print(f"Saved data report (no network requests): {output['markdown']}")
                return 0
            if args.transport == "browser":
                from .browser import BrowserSession
                manager = BrowserSession(paths.child("profiles/fl"), channel=args.browser_channel)
            else:
                manager = nullcontext(HttpFetcher())
            with manager as fetcher:
                service = DiscoveryService(db, SOURCES, fetcher)
                def scan_once():
                    interrupted = None
                    try:
                        report = service.import_url(args.url) if args.command == "import-url" else service.scan(args.sources or ["fl"], args.max_pages, args.max_details)
                    except ScanInterrupted as exc:
                        report, interrupted = exc.report, exc
                    output = write_report(report, db.list_listings(), paths.child("reports"), source_states=db.source_states(), records=db.listing_records())
                    print(f"New: {report.new}; updated: {report.updated}; unchanged: {report.unchanged}. Report: {output['markdown']}", flush=True)
                    if interrupted is not None:
                        raise interrupted
                    return 0 if any(s["state"] == "public" for s in report.sources.values()) else 1
                if args.command == "watch":
                    run_watch(scan_once, args.interval_seconds)
                    return 0
                return scan_once()
    except (ValueError, RuntimeError) as exc:
        print(f"Discovery error: {exc}")
        return 2
    except (OSError, EOFError, sqlite3.Error):
        print("Discovery error: storage/browser unavailable or interactive input closed")
        return 2
    except KeyboardInterrupt:
        print("Stopped; saved observations and connection checkpoints retained")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

