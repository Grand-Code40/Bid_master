from __future__ import annotations

from dataclasses import asdict
from datetime import timedelta
import json
import logging
import sqlite3
import threading

from ..discovery.fetch import HttpFetcher
from ..discovery.models import utcnow
from ..discovery.registry import SOURCES, canonical_listing_url
from ..discovery.report import write_report
from ..discovery.runtime import LockBusy, RunLock
from ..discovery.service import DiscoveryService, ScanInterrupted
from ..discovery.storage import DiscoveryDatabase

from .reviews import ReviewStore, Conflict, NotFound

LOG = logging.getLogger(__name__)


class CenterController:
    def __init__(self, paths, *, fetcher_factory=HttpFetcher, clock=utcnow):
        self.paths, self.fetcher_factory, self.clock = paths, fetcher_factory, clock
        paths.prepare()
        self.settings_path = paths.child("command-center/settings.json")
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        if not paths.child("discovery.sqlite3").exists():
            with RunLock(paths.root), DiscoveryDatabase(paths.child("discovery.sqlite3")):
                pass
        self.reviews = ReviewStore(paths.child("command-center/reviews.sqlite3"), clock=clock)
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._worker = None
        self._scheduler = None
        self._closed = False
        self._scan = dict(running=False, started_at=None, finished_at=None, error=None, result=None)
        self._enabled, self._interval = False, 60
        try:
            settings = json.loads(self.settings_path.read_text(encoding="utf-8"))
            self._validate_monitor(settings["enabled"], settings["interval_minutes"])
            self._enabled, self._interval = settings["enabled"], settings["interval_minutes"]
        except FileNotFoundError:
            pass
        except (ValueError, KeyError, TypeError):
            LOG.warning("Invalid monitor settings; monitoring disabled")
        self._next_run = self.clock() + timedelta(minutes=self._interval) if self._enabled else None

    @staticmethod
    def _validate_monitor(enabled, interval_minutes):
        if type(enabled) is not bool or type(interval_minutes) is not int or interval_minutes not in (30, 60):
            raise ValueError("Choose a boolean enabled flag and a 30 or 60 minute interval")

    def snapshot(self):
        connection = sqlite3.connect(self.paths.child("discovery.sqlite3").as_uri() + "?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            listings = []
            for row in connection.execute("SELECT data,first_seen,last_seen FROM listings ORDER BY last_seen DESC"):
                item = json.loads(row["data"])
                try:
                    item["canonical_url"] = canonical_listing_url(item["source_id"], item["canonical_url"], item["external_id"])
                except (ValueError, KeyError):
                    item["canonical_url"] = None
                listings.append(item | dict(first_seen=row["first_seen"], last_seen=row["last_seen"]))
            states = {row["source_id"]: dict(row) for row in connection.execute("SELECT * FROM sources")}
        finally:
            connection.close()
        sources = [
            dict(id=key, name=source.name, implemented=source.implemented,
                 state=states.get(key, {}).get("state", "unverified"),
                 code=states.get(key, {}).get("code", "not_scanned"),
                 last_success=states.get(key, {}).get("last_success"))
            for key, source in SOURCES.items()
        ]
        orders = [item for item in listings if item["listing_kind"] == "order"]
        with self._lock:
            scan = dict(self._scan)
            monitor = dict(enabled=self._enabled, interval_minutes=self._interval,
                           next_run_at=self._next_run.isoformat() if self._next_run else None)
        return dict(listings=listings, sources=sources, scan=scan, monitor=monitor,
                    reviews=self.reviews.list(), agent=self.reviews.agent_status(),
                    summary=dict(total=len(listings), orders=len(orders),
                                 vacancies=sum(item["listing_kind"] == "vacancy" for item in listings),
                                 priced_orders=sum(item["budget_min"] is not None or item["budget_max"] is not None for item in orders)))

    def review_action(self, action, data):
        source, ident = data.get("source_id"), data.get("external_id")
        if not isinstance(source, str) or not isinstance(ident, str):
            raise ValueError("Invalid listing identity")
        item = next((item for item in self.snapshot()["listings"]
                     if item["source_id"] == source and item["external_id"] == ident), None)
        if item is None:
            raise NotFound("listing_not_found")
        if action in ("prepare", "approve", "queue"):
            if not item["canonical_url"] or item["listing_kind"] != "order" or item["availability"] == "closed":
                raise Conflict("listing_unavailable")
        if action == "prepare":
            return self.reviews.prepare(item)
        if action == "save":
            return self.reviews.save(source, ident, data.get("text"), data.get("revision"))
        if action in ("approve", "queue", "cancel"):
            return getattr(self.reviews, action)(source, ident, data.get("revision"))
        raise ValueError("Unknown review action")

    def start_scan(self):
        with self._lock:
            if self._closed or self._scan["running"]:
                return False
            self._scan = dict(running=True, started_at=self.clock().isoformat(),
                              finished_at=None, error=None, result=None)
            if self._enabled:
                self._next_run = self.clock() + timedelta(minutes=self._interval)
            self._worker = threading.Thread(target=self._scan_once, name="caigraph-scan")
            self._worker.start()
            return True

    def _scan_once(self):
        result, error = None, None
        try:
            with RunLock(self.paths.root), DiscoveryDatabase(self.paths.child("discovery.sqlite3")) as db:
                transport = self.fetcher_factory()
                stop = self._stop

                class InterruptibleFetcher:
                    def fetch(self, url):
                        if stop.is_set():
                            raise KeyboardInterrupt
                        return transport.fetch(url)

                try:
                    report = DiscoveryService(db, SOURCES, InterruptibleFetcher()).scan(["fl"], 2, 10)
                except ScanInterrupted as exc:
                    report, error = exc.report, "interrupted"
                write_report(report, db.list_listings(), self.paths.child("reports"),
                             source_states=db.source_states(), records=db.listing_records())
                result = asdict(report)
                if not error and not any(item["state"] in ("public", "authenticated") for item in report.sources.values()):
                    error = "source_unavailable"
        except LockBusy:
            error = "source_busy"
        except Exception:
            error = "scan_failed"
            LOG.exception("Discovery scan failed")
        finally:
            with self._lock:
                self._scan.update(running=False, finished_at=self.clock().isoformat(), error=error, result=result)

    def set_monitor(self, enabled, interval_minutes):
        self._validate_monitor(enabled, interval_minutes)
        with self._lock:
            if self._closed:
                raise ValueError("The command center is stopping")
            settings = dict(enabled=enabled, interval_minutes=interval_minutes)
            temporary = self.settings_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(settings), encoding="utf-8")
            temporary.replace(self.settings_path)
            self._enabled, self._interval = enabled, interval_minutes
            self._next_run = self.clock() + timedelta(minutes=interval_minutes) if enabled else None

    def check_schedule(self):
        with self._lock:
            if self._enabled and self._next_run is not None and self.clock() >= self._next_run:
                return self.start_scan()
            return False

    def start_scheduler(self):
        with self._lock:
            if self._closed or self._scheduler is not None:
                return
            def watch():
                while not self._stop.wait(1):
                    self.check_schedule()
            self._scheduler = threading.Thread(target=watch, name="caigraph-monitor", daemon=True)
            self._scheduler.start()

    def close(self):
        with self._lock:
            self._closed = True
            self._stop.set()
            threads = (self._scheduler, self._worker)
        for worker in threads:
            if worker and worker is not threading.current_thread():
                worker.join()

