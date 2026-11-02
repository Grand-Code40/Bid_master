from datetime import datetime, timedelta, timezone

from autobid.models import BidStatus, Decision, Project, ScoreResult
from autobid.storage.database import Database


def project(project_id=123):
    return Project(
        project_id=project_id,
        title="PDF to DXF",
        description="Create closed contours",
        url=f"https://example.test/{project_id}",
        status="ACTIVE",
        budget_min=50,
        budget_max=100,
    )


def test_reservation_prevents_same_project_across_runs_and_accounts(tmp_path):
    url = f"sqlite:///{tmp_path / 'state.db'}"
    first = Database(url)
    second = Database(url)
    first.migrate()
    second.migrate()

    assert first.reserve_project(project(), "run-one") is True
    assert second.reserve_project(project(), "run-two") is False
    assert second.project_exists(123) is True


def test_decision_preserves_proposal_before_bid(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'state.db'}")
    db.migrate()
    db.reserve_project(project(), "run-one")

    db.save_decision(
        project_id=123,
        run_id="run-one",
        score=ScoreResult(95, Decision.AUTO_BID, ("pdf_input", "dxf_output")),
        selected_account=7,
        amount=80,
        delivery_days=2,
        proposal="Exact dimensions and closed contours will be checked.",
    )

    saved = db.get_project_record(123)
    assert saved["proposal"] == "Exact dimensions and closed contours will be checked."
    assert saved["selected_account"] == 7
    assert saved["decision"] == "AUTO_BID"


def test_daily_and_monthly_sent_bid_counts(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'state.db'}")
    db.migrate()
    now = datetime.now(timezone.utc)
    for project_id, created_at in ((1, now), (2, now - timedelta(days=2)), (3, now - timedelta(days=40))):
        db.reserve_project(project(project_id), "run")
        db.record_bid(
            project_id=project_id,
            run_id="run",
            account_id=9,
            status=BidStatus.SENT,
            amount=75,
            delivery_days=2,
            proposal="p",
            api_result={"id": project_id},
            created_at=created_at,
        )

    assert db.count_sent_bids(since=now - timedelta(days=1)) == 1
    assert db.count_sent_bids(since=now - timedelta(days=1), account_id=9) == 1
    assert db.count_sent_bids(since=now - timedelta(days=31)) == 2


def test_bid_record_is_unique_per_project(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'state.db'}")
    db.migrate()
    db.reserve_project(project(), "run")

    assert db.record_bid(123, "run", 1, BidStatus.SENT, 70, 2, "proposal", {"id": 1}) is True
    assert db.record_bid(123, "run", 2, BidStatus.SENT, 80, 3, "proposal 2", {"id": 2}) is False
    assert db.count_sent_bids(account_id=1) == 1
    assert db.count_sent_bids(account_id=2) == 0


def test_postgres_uses_transaction_context_without_closing_connection():
    class Transaction:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    class Connection:
        def __init__(self):
            self.transaction_calls = 0

        def transaction(self):
            self.transaction_calls += 1
            return Transaction()

        def __enter__(self):
            raise AssertionError("Psycopg connection context would close the shared connection")

    db = object.__new__(Database)
    db._postgres = True
    db._connection = Connection()

    with db._transaction():
        pass

    assert db._connection.transaction_calls == 1
