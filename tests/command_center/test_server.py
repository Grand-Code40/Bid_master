import json
import threading
import time
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from http.client import HTTPConnection
from pathlib import Path

import pytest

from autobid.discovery.fetch import classify_page
from autobid.discovery.models import Listing, Observation, SourceStatus
from autobid.discovery.runtime import RunLock, RuntimePaths
from autobid.discovery.storage import DiscoveryDatabase


def api():
    # A missing module is an explicit assertion failure until the service exists.
    import importlib.util
    assert importlib.util.find_spec("autobid.command_center"), "Command center API is not implemented"
    from autobid.command_center.server import CenterController, create_server
    return CenterController, create_server


def seeded_paths(tmp_path):
    paths = RuntimePaths.from_root(tmp_path)
    paths.prepare()
    with DiscoveryDatabase(paths.child("discovery.sqlite3")) as db:
        for ident, budget, bids, kind in (("1", Decimal("5000"), 0, "order"), ("2", None, None, "vacancy")):
            item = Listing("fl", ident, f"https://www.fl.ru/projects/{ident}/drawing.html",
                           title="<script>bad()</script> Чертёж", description="Нужен DXF",
                           budget_max=budget, currency="RUB" if budget else None,
                           bids_count=bids, listing_kind=kind, availability="open")
            db.upsert(Observation(item, datetime(2026, 11, 2, tzinfo=timezone.utc),
                                  frozenset({"title", "description", "budget_max", "currency", "bids_count", "listing_kind", "availability"})))
        db.set_source_state("fl", SourceStatus.PUBLIC, "ok")
    return paths


class FixtureFetcher:
    def __init__(self, entered=None, release=None):
        self.entered, self.release = entered, release

    def fetch(self, url):
        if self.entered:
            self.entered.set()
            assert self.release.wait(5), "Test failed to release fixture transport"
        filename = "fl-list.html" if "/category/" in url else "fl-detail.html"
        html = (Path(__file__).parents[1] / "discovery" / "fixtures" / filename).read_text(encoding="utf-8")
        return classify_page(url, 200, html)


def wait_scan(center):
    deadline = time.monotonic() + 6
    while center.snapshot()["scan"]["running"] and time.monotonic() < deadline:
        time.sleep(.02)
    assert not center.snapshot()["scan"]["running"]


def request(server, method, path, body=None, token=None, origin=None, host=None):
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
    headers = {}
    if token:
        headers["X-CAIgraph-Token"] = token
    if origin:
        headers["Origin"] = origin
    if host:
        headers["Host"] = host
    payload = None if body is None else json.dumps(body)
    if body is not None:
        headers["Content-Type"] = "application/json"
    connection.request(method, path, payload, headers)
    response = connection.getresponse()
    result = response.status, response.getheaders(), response.read()
    connection.close()
    return result


def test_snapshot_preserves_unknown_zero_and_source_connection_state(tmp_path):
    Center, _ = api()
    center = Center(seeded_paths(tmp_path))
    try:
        state = center.snapshot()
        assert state["summary"] == {"total": 2, "orders": 1, "vacancies": 1, "priced_orders": 1}
        items = {row["external_id"]: row for row in state["listings"]}
        assert items["1"]["budget_max"] == "5000"
        assert items["1"]["bids_count"] == 0
        assert items["2"]["budget_max"] is None and items["2"]["bids_count"] is None
        assert items["1"]["title"] == "<script>bad()</script> Чертёж"
        sources = {source["id"]: source for source in state["sources"]}
        assert sources["fl"]["state"] == "public" and sources["fl"]["last_success"]
        assert sources["telegram"]["implemented"] is False
        assert state["monitor"]["enabled"] is False
    finally:
        center.close()


def test_background_scan_excludes_duplicate_and_saves_real_report(tmp_path):
    Center, _ = api()
    entered, release = threading.Event(), threading.Event()
    center = Center(seeded_paths(tmp_path), fetcher_factory=lambda: FixtureFetcher(entered, release))
    try:
        assert center.start_scan() is True
        assert entered.wait(3)
        assert center.start_scan() is False
        assert center.snapshot()["scan"]["running"]
        release.set()
        wait_scan(center)
        state = center.snapshot()
        assert state["summary"]["total"] == 3
        assert state["scan"]["result"]["new"] == 1
        assert state["scan"]["error"] is None
        assert center.paths.child("reports/latest.json").is_file()
    finally:
        release.set()
        center.close()


def test_existing_cli_lock_reports_busy_without_losing_data(tmp_path):
    Center, _ = api()
    center = Center(seeded_paths(tmp_path), fetcher_factory=FixtureFetcher)
    try:
        with RunLock(tmp_path):
            assert center.start_scan()
            wait_scan(center)
        state = center.snapshot()
        assert state["scan"]["error"] == "source_busy"
        assert state["summary"]["total"] == 2
        assert center.start_scan()
        wait_scan(center)
        assert center.snapshot()["scan"]["error"] is None
    finally:
        center.close()


def test_failed_scan_is_visible_and_existing_records_remain(tmp_path):
    Center, _ = api()
    class BrokenFetcher:
        def fetch(self, url):
            raise OSError("never-expose-private-transport-detail")
    center = Center(seeded_paths(tmp_path), fetcher_factory=BrokenFetcher)
    try:
        assert center.start_scan()
        wait_scan(center)
        state = center.snapshot()
        assert state["scan"]["error"] == "scan_failed"
        assert state["summary"]["total"] == 2
        assert "never-expose" not in json.dumps(state)
    finally:
        center.close()


def test_monitor_settings_survive_restart_and_invalid_values_are_rejected(tmp_path):
    Center, _ = api()
    paths = seeded_paths(tmp_path)
    center = Center(paths, fetcher_factory=FixtureFetcher)
    try:
        for enabled, interval in (("yes", 30), (True, 0), (True, 31), (True, True)):
            with pytest.raises(ValueError):
                center.set_monitor(enabled, interval)
        center.set_monitor(True, 30)
        state = center.snapshot()
        assert state["monitor"]["enabled"] and state["monitor"]["next_run_at"]
    finally:
        center.close()
    reopened = Center(paths, fetcher_factory=FixtureFetcher)
    try:
        state = reopened.snapshot()
        assert state["monitor"]["enabled"]
        assert state["monitor"]["interval_minutes"] == 30
        reopened.set_monitor(False, 60)
        assert reopened.snapshot()["monitor"]["next_run_at"] is None
    finally:
        reopened.close()


def test_due_monitor_scan_runs_and_stop_disallows_new_scans(tmp_path):
    Center, _ = api()
    current = [datetime(2026, 11, 2, tzinfo=timezone.utc)]
    center = Center(seeded_paths(tmp_path), fetcher_factory=FixtureFetcher, clock=lambda: current[0])
    center.set_monitor(True, 30)
    assert center.check_schedule() is False
    current[0] += timedelta(minutes=30)
    assert center.check_schedule() is True
    wait_scan(center)
    assert center.snapshot()["scan"]["result"]["new"] == 1
    assert center.check_schedule() is False
    center.close()
    assert center.start_scan() is False


def test_http_rejects_foreign_hosts_and_mutations_without_token(tmp_path):
    Center, create_server = api()
    center = Center(seeded_paths(tmp_path), fetcher_factory=FixtureFetcher)
    server = create_server(center, port=0)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        status, headers, body = request(server, "GET", "/api/state")
        assert status == 200
        state = json.loads(body)
        token = state["token"]
        assert request(server, "GET", "/api/state", host="attacker.example")[0] == 403
        assert request(server, "POST", "/api/scan", {})[0] == 403
        assert request(server, "POST", "/api/scan", {}, token="é")[0] == 403
        assert request(server, "POST", "/api/scan", {}, token, "https://attacker.example")[0] == 403
        assert request(server, "POST", "/api/monitor", {"enabled": True, "interval_minutes": 30}, token)[0] == 200
        assert request(server, "POST", "/api/monitor", {"enabled": True, "interval_minutes": 1}, token)[0] == 400
        assert request(server, "POST", "/api/scan", {}, token)[0] == 202
        wait_scan(center)
        status, headers, body = request(server, "GET", "/api/state")
        assert status == 200
        assert "Content-Security-Policy" in dict(headers)
        assert request(server, "GET", "/../../discovery.sqlite3")[0] == 404
        assert request(server, "GET", "/api/health")[0] == 200
        import sqlite3
        with sqlite3.connect(center.paths.child("discovery.sqlite3")) as broken:
            broken.execute("DROP TABLE listings")
        assert request(server, "GET", "/api/state")[0] == 503
        assert request(server, "POST", "/api/stop", {}, token)[0] == 200
        worker.join(3)
        assert not worker.is_alive()
    finally:
        server.shutdown()
        server.server_close()
        center.close()


