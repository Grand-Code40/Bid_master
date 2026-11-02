import importlib.util
import json

import pytest

from autobid.discovery.storage import DiscoveryDatabase
from autobid.discovery.runtime import RuntimePaths


def api():
    assert importlib.util.find_spec("autobid.command_center.agent"), "Cloud-agent handoff is missing"
    from autobid.command_center.agent import main, ingest
    return main, ingest


def observed(**updates):
    return dict(source_id="freelance", external_id="13089",
                canonical_url="https://freelance.ru/task/view/13089?utm_source=test",
                title="Чертежи в производство", description="Нужны чертежи и раскрой.",
                listing_kind="order", budget_max="12000", currency="RUB", bids_count=0,
                observed_at="2026-11-02T10:00:00+03:00", **updates)


def test_ingest_deduplicates_and_sparse_observation_preserves_known_values(tmp_path):
    _, ingest = api()
    paths = RuntimePaths.from_root(tmp_path)
    assert ingest(paths, [observed()]) == {"new": 1, "updated": 0, "unchanged": 0}
    partial = {key: value for key, value in observed().items() if key not in ("description", "budget_max", "currency", "bids_count")}
    partial["observed_at"] = "2026-11-02T11:00:00+03:00"
    assert ingest(paths, [partial]) == {"new": 0, "updated": 0, "unchanged": 1}
    with DiscoveryDatabase(tmp_path / "discovery.sqlite3") as db:
        row = db.list_listings()[0]
        assert row.budget_max == 12000 and row.bids_count == 0
        assert row.canonical_url == "https://freelance.ru/task/view/13089"
        assert db.source_states()["freelance"]["code"] == "agent_observed"
    from autobid.command_center.controller import CenterController
    center = CenterController(paths)
    try:
        state = center.snapshot()
        assert state["listings"][0]["canonical_url"] == row.canonical_url
        assert next(item for item in state["sources"] if item["id"] == "freelance")["implemented"] is False
    finally:
        center.close()


@pytest.mark.parametrize("updates", [
    {"canonical_url": "https://freelance.ru.attacker.test/task/view/13089"},
    {"canonical_url": "https://user:pass@freelance.ru/task/view/13089"},
    {"canonical_url": "javascript:alert(1)"},
    {"canonical_url": "https://freelance.ru/task/view/999"},
    {"source_id": "other"},
    {"budget_max": "NaN"},
    {"budget_max": "-1"},
    {"bids_count": True},
    {"listing_kind": "service"},
    {"observed_at": "2026-11-02"},
    {"observed_at": "2099-01-01T00:00:00Z"},
    {"title": ["not", "text"]},
    {"approved": True},
], ids=["host", "userinfo", "scheme", "identity", "source", "nan", "negative", "bool_bids",
        "kind", "naive_time", "future_time", "text_type", "unknown_field"])
def test_invalid_import_batch_does_not_partially_write(tmp_path, updates):
    _, ingest = api()
    paths = RuntimePaths.from_root(tmp_path)
    with pytest.raises(ValueError):
        ingest(paths, [observed(), observed() | updates])
    path = tmp_path / "discovery.sqlite3"
    if path.exists():
        with DiscoveryDatabase(path) as db:
            assert db.list_listings() == []


def test_telegram_preview_and_post_share_identity(tmp_path):
    _, ingest = api()
    base = dict(source_id="telegram", external_id="cad_jobs/42", title="План в DWG",
                listing_kind="order", observed_at="2026-11-02T09:00:00Z")
    paths = RuntimePaths.from_root(tmp_path)
    ingest(paths, [base | dict(canonical_url="https://t.me/s/CAD_jobs/42")])
    ingest(paths, [base | dict(canonical_url="https://t.me/cad_jobs/42")])
    with DiscoveryDatabase(tmp_path / "discovery.sqlite3") as db:
        assert len(db.list_listings()) == 1


def test_cli_ingest_draft_and_claim_never_approves_or_sends(tmp_path, capsys):
    main, _ = api()
    payload = tmp_path / "observations.json"
    payload.write_text(json.dumps([observed()]), encoding="utf-8")
    prefix = ["--data-root", str(tmp_path)]
    assert main(prefix + ["ingest", str(payload)]) == 0
    capsys.readouterr()
    assert main(prefix + ["draft", "freelance", "13089"]) == 0
    draft = json.loads(capsys.readouterr().out)
    assert draft["state"] == "draft"
    assert main(prefix + ["claim"]) == 0
    assert json.loads(capsys.readouterr().out) is None
    assert main(prefix + ["queue"]) == 0
    assert json.loads(capsys.readouterr().out) == []
    text_file = tmp_path / "reply.txt"
    text_file.write_text("Персональный ответ после анализа задания.", encoding="utf-8")
    assert main(prefix + ["draft", "freelance", "13089", "--text-file", str(text_file), "--revision", str(draft["revision"])]) == 0
    assert json.loads(capsys.readouterr().out)["text"].startswith("Персональный")
