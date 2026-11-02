from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal

from autobid.discovery.models import Listing, Observation, ConnectionStep
from autobid.discovery.storage import DiscoveryDatabase

NOW = datetime(2026, 11, 2, 12, tzinfo=timezone.utc)


def observation(**fields):
    listing = Listing(source_id="fl", external_id="10", canonical_url="https://www.fl.ru/projects/10/a.html", **fields)
    return Observation(listing, NOW, frozenset(fields), {key: listing.canonical_url for key in fields})


def test_refresh_merges_present_fields_and_keeps_history(tmp_path):
    with DiscoveryDatabase(tmp_path / "market.sqlite3") as db:
        assert db.upsert(observation(title="Чертёж", description="DXF и STEP", budget_min=Decimal("5000"), bids_count=0)) == "new"
        assert db.upsert(observation(budget_min=Decimal("4500"), bids_count=2, availability="closed")) == "updated"
        item = db.list_listings()[0]
        assert (item.title, item.description, item.budget_min, item.bids_count, item.availability) == ("Чертёж", "DXF и STEP", Decimal("4500"), 2, "closed")
        assert db.observation_count() == 2
        assert db.upsert(observation(bids_count=2)) == "unchanged"
        assert len(db.list_listings()) == 1
        assert db.observation_count() == 3


def test_null_differs_from_missing_and_zero(tmp_path):
    with DiscoveryDatabase(tmp_path / "market.sqlite3") as db:
        db.upsert(observation(budget_min=Decimal("100"), bids_count=0))
        db.upsert(observation(title="Редакция"))
        assert db.list_listings()[0].budget_min == Decimal("100")
        db.upsert(observation(budget_min=None))
        item = db.list_listings()[0]
        assert item.budget_min is None
        assert item.bids_count == 0


def test_equal_ids_on_different_sources_and_reopen(tmp_path):
    path = tmp_path / "market.sqlite3"
    with DiscoveryDatabase(path) as db:
        first = observation(title="DXF")
        db.upsert(first)
        db.upsert(replace(first, listing=replace(first.listing, source_id="another")))
        db.set_source_state("fl", "public", "ok")
        db.save_connection_step("fl", ConnectionStep.EMAIL_VERIFICATION)
    with DiscoveryDatabase(path) as db:
        assert len(db.list_listings()) == 2
        assert db.get_connection_step("fl") == ConnectionStep.EMAIL_VERIFICATION
        assert db.source_states()["fl"]["state"] == "public"


def test_older_observation_is_retained_but_cannot_roll_back_current(tmp_path):
    with DiscoveryDatabase(tmp_path / "market.sqlite3") as db:
        db.upsert(observation(bids_count=8))
        older = replace(observation(bids_count=2, description="older full text"), observed_at=datetime(2026, 11, 1, tzinfo=timezone.utc))
        db.upsert(older)
        assert db.list_listings()[0].bids_count == 8
        assert db.list_listings()[0].description == "older full text"
        assert db.observation_count() == 2


def test_source_error_preserves_last_success(tmp_path):
    with DiscoveryDatabase(tmp_path / "db") as db:
        db.set_source_state("fl", "public", "ok")
        success = db.source_states()["fl"]["last_success"]
        assert success
        db.set_source_state("fl", "error", "network_error")
        assert db.source_states()["fl"]["last_success"] == success
        assert db.source_states()["fl"]["state"] == "error"
