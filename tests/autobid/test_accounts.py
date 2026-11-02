from datetime import datetime, timezone

from autobid.freelancer.accounts import AccountRouter
from autobid.models import Account, BidStatus, Project
from autobid.storage.database import Database


def project():
    return Project(500, "Laser DXF", "Create laser-ready DXF", "u", "ACTIVE", 50, 100, skills=("CAD",))


def account(account_id, tags=(), **kwargs):
    return Account(account_id, f"account-{account_id}", f"token-{account_id}", profile_tags=tags, **kwargs)


def test_router_prefers_profile_match(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'state.db'}")
    db.migrate()
    router = AccountRouter(db, per_account_daily_limit=3)

    selected = router.select(project(), (account(1, ("translation",)), account(2, ("laser", "dxf"))))

    assert selected.account_id == 2


def test_router_round_robins_using_recent_usage(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'state.db'}")
    db.migrate()
    router = AccountRouter(db, per_account_daily_limit=3)
    accounts = (account(1), account(2))
    db.reserve_project(project(), "run")
    db.record_bid(500, "run", 1, BidStatus.SENT, 75, 2, "p", {}, created_at=datetime.now(timezone.utc))

    selected = router.select(project(), accounts)

    assert selected.account_id == 2


def test_router_returns_none_when_all_accounts_exhausted_or_disabled(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'state.db'}")
    db.migrate()
    router = AccountRouter(db, per_account_daily_limit=1)
    exhausted = account(1, bids_remaining=0)
    disabled = account(2, enabled=False)

    assert router.select(project(), (exhausted, disabled)) is None
