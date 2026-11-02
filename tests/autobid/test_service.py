from dataclasses import replace

from autobid.config import Settings
from autobid.freelancer.client import AuthError, RateLimitError
from autobid.models import Account, Project
from autobid.service import AutoBidService
from autobid.storage.database import Database


def project(project_id=1, **overrides):
    data = {
        "project_id": project_id,
        "title": "PDF sketch to laser-ready DXF",
        "description": "Redraw exact dimensions in 2D, close all contours, remove duplicate paths for laser cutting.",
        "url": f"https://example.test/{project_id}",
        "status": "ACTIVE",
        "budget_min": 50,
        "budget_max": 150,
        "skills": ("CAD",),
    }
    data.update(overrides)
    return Project(**data)


def account(account_id=7, **overrides):
    return Account(account_id, f"cad-{account_id}", f"secret-{account_id}", profile_tags=("dxf", "laser"), **overrides)


class FakeClient:
    def __init__(self, owner, projects, *, auth_error=False, place_errors=None):
        self.account = owner
        self.projects = projects
        self.auth_error = auth_error
        self.place_errors = list(place_errors or [])
        self.place_calls = []
        self.existing = {}
        self.project_details = {item.project_id: item for item in projects}

    def get_current_user(self):
        if self.auth_error:
            raise AuthError("bad token")
        return {"id": self.account.account_id, "username": self.account.username}

    def search_projects(self, _query, _limit):
        return self.projects

    def get_project(self, project_id):
        return self.project_details[project_id]

    def find_existing_bid(self, project_id):
        return self.existing.get(project_id)

    def place_bid(self, intent):
        self.place_calls.append(intent)
        if self.place_errors:
            raise self.place_errors.pop(0)
        result = {"id": 1000 + intent.project_id, "project_id": intent.project_id, "bidder_id": intent.account_id}
        self.existing[intent.project_id] = result
        return result


class MemoryNotifier:
    def __init__(self):
        self.events = []

    def notify(self, event, message):
        self.events.append((event, message))


def settings(tmp_path, accounts, **overrides):
    base = Settings(
        database_url=f"sqlite:///{tmp_path / 'state.db'}",
        accounts=tuple(accounts),
        autobid_enabled=True,
        dry_run=False,
        max_bids_per_run=10,
        max_bids_per_day=10,
        max_bids_per_month=10,
        max_bids_per_account_per_day=10,
        report_dir=str(tmp_path / "reports"),
    )
    return replace(base, **overrides)


def service(tmp_path, cfg, clients, notifier=None):
    db = Database(cfg.database_url)
    return AutoBidService(cfg, db, lambda item: clients[item.account_id], notifier=notifier or MemoryNotifier())


def test_closed_project_is_persisted_but_never_bid(tmp_path):
    owner = account()
    client = FakeClient(owner, [project(status="CLOSED")])

    report = service(tmp_path, settings(tmp_path, [owner]), {7: client}).run()

    assert report.projects_scanned == 1
    assert report.skipped == 1
    assert client.place_calls == []


def test_project_status_is_refreshed_before_bid(tmp_path):
    owner = account()
    client = FakeClient(owner, [project(status="ACTIVE")])
    client.project_details[1] = project(status="CLOSED")

    report = service(tmp_path, settings(tmp_path, [owner]), {7: client}).run()

    assert report.skipped == 1
    assert client.place_calls == []
    assert any(event.get("reason") == "project is closed or not accepting bids" for event in report.events)


def test_dry_run_and_disabled_mode_record_intent_without_api_bid(tmp_path):
    for suffix, overrides in (("dry", {"dry_run": True}), ("disabled", {"autobid_enabled": False})):
        case = tmp_path / suffix
        case.mkdir()
        owner = account()
        client = FakeClient(owner, [project()])
        report = service(case, settings(case, [owner], **overrides), {7: client}).run()
        assert report.intended_bids == 1
        assert report.bids_sent == 0
        assert client.place_calls == []


def test_same_project_seen_in_two_runs_is_bid_once(tmp_path):
    owner = account()
    client = FakeClient(owner, [project()])
    cfg = settings(tmp_path, [owner])

    first = service(tmp_path, cfg, {7: client}).run()
    second = service(tmp_path, cfg, {7: client}).run()

    assert first.bids_sent == 1
    assert second.new_projects == 0
    assert len(client.place_calls) == 1


def test_monthly_limit_blocks_live_bid(tmp_path):
    owner = account()
    first_client = FakeClient(owner, [project(1)])
    cfg = settings(tmp_path, [owner], max_bids_per_month=1)
    service(tmp_path, cfg, {7: first_client}).run()
    second_client = FakeClient(owner, [project(2)])

    report = service(tmp_path, cfg, {7: second_client}).run()

    assert report.skipped == 1
    assert second_client.place_calls == []


def test_auth_failure_opens_emergency_stop_and_notifies(tmp_path):
    owner = account()
    client = FakeClient(owner, [], auth_error=True)
    notifier = MemoryNotifier()

    report = service(tmp_path, settings(tmp_path, [owner]), {7: client}, notifier).run()

    assert report.emergency_stop is True
    assert any(event == "authentication_error" for event, _ in notifier.events)
    assert any(event == "emergency_stop" for event, _ in notifier.events)


def test_repeated_429_stops_bidding_but_scanner_continues(tmp_path):
    owner = account()
    client = FakeClient(
        owner,
        [project(1), project(2), project(3)],
        place_errors=[RateLimitError("429"), RateLimitError("429")],
    )
    cfg = settings(tmp_path, [owner], max_rate_limit_errors=2)

    report = service(tmp_path, cfg, {7: client}).run()

    assert report.projects_scanned == 3
    assert len(client.place_calls) == 2
    assert report.emergency_stop is True


def test_sequential_bid_failures_open_circuit_and_scanning_continues(tmp_path):
    owner = account()
    client = FakeClient(
        owner,
        [project(1), project(2), project(3)],
        place_errors=[RuntimeError("failure one"), RuntimeError("failure two")],
    )
    cfg = settings(tmp_path, [owner], max_sequential_bid_failures=2)

    report = service(tmp_path, cfg, {7: client}).run()

    assert report.projects_scanned == 3
    assert len(client.place_calls) == 2
    assert report.emergency_stop is True


def test_configured_emergency_stop_scans_without_bidding(tmp_path):
    owner = account()
    client = FakeClient(owner, [project(1), project(2)])

    report = service(tmp_path, settings(tmp_path, [owner], emergency_stop=True), {7: client}).run()

    assert report.projects_scanned == 2
    assert report.emergency_stop is True
    assert client.place_calls == []


def test_one_project_is_never_routed_to_two_accounts(tmp_path):
    accounts = (account(7), account(8))
    clients = {item.account_id: FakeClient(item, [project()]) for item in accounts}
    cfg = settings(tmp_path, accounts)

    service(tmp_path, cfg, clients).run()
    service(tmp_path, cfg, clients).run()

    assert sum(len(client.place_calls) for client in clients.values()) == 1


def test_remote_bid_on_any_pool_account_blocks_new_bid(tmp_path):
    accounts = (account(7), account(8))
    clients = {item.account_id: FakeClient(item, [project()]) for item in accounts}
    clients[8].existing[1] = {"id": 88, "project_id": 1, "bidder_id": 8}

    report = service(tmp_path, settings(tmp_path, accounts), clients).run()

    assert report.bids_sent == 0
    assert sum(len(client.place_calls) for client in clients.values()) == 0
    assert any(event.get("reason") == "existing remote bid in account pool" for event in report.events)
