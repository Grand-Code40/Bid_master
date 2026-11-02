from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import threading

import pytest

from tests.command_center.test_server import seeded_paths, request


def store_api(tmp_path):
    assert importlib.util.find_spec("autobid.command_center.reviews"), "Durable review workflow is missing"
    from autobid.command_center.reviews import ReviewStore, Conflict
    return ReviewStore(tmp_path / "reviews.sqlite3"), Conflict


def listing():
    return dict(source_id="fl", external_id="1", canonical_url="https://www.fl.ru/projects/1/drawing.html",
                title="Перенести план в CAD", description="Нужен DXF", requested_formats=["DXF"],
                listing_kind="order", availability="open")


def approved(store):
    row = store.prepare(listing())
    row = store.save("fl", "1", "Здравствуйте! Подготовим DXF после уточнения размеров.", row["revision"])
    return store.approve("fl", "1", row["revision"])


def test_draft_is_personalized_and_survives_reopen(tmp_path):
    store, _ = store_api(tmp_path)
    row = store.prepare(listing())
    assert row["state"] == "draft" and row["revision"] == 1
    assert "Перенести план в CAD" in row["text"] and "DXF" in row["text"]
    saved = store.save("fl", "1", "Мой ответ", row["revision"])
    reopened, _ = store_api(tmp_path)
    assert reopened.prepare(listing())["text"] == "Мой ответ"
    assert reopened.get("fl", "1")["revision"] == saved["revision"]


def test_edit_revokes_approval_and_stale_tabs_cannot_queue(tmp_path):
    store, conflict = store_api(tmp_path)
    row = approved(store)
    assert row["approved_revision"] == row["revision"]
    edited = store.save("fl", "1", "Новая стоимость: уточним по исходникам.", row["revision"])
    assert edited["state"] == "draft" and edited["approved_revision"] is None
    with pytest.raises(conflict):
        store.queue("fl", "1", row["revision"])
    with pytest.raises(conflict):
        store.queue("fl", "1", edited["revision"])
    with pytest.raises(conflict):
        store.save("fl", "1", "Устаревшая вкладка", row["revision"])
    assert store.get("fl", "1")["text"] == edited["text"]


def test_queue_claim_is_atomic_and_locks_exact_approved_text(tmp_path):
    store, conflict = store_api(tmp_path)
    row = approved(store)
    queued = store.queue("fl", "1", row["revision"])
    assert queued["state"] == "queued"
    # Retrying a successful request after a lost response is idempotent.
    assert store.queue("fl", "1", row["revision"])["state"] == "queued"
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: store.claim(), range(2)))
    claimed = [value for value in claims if value is not None]
    assert len(claimed) == 1
    assert claimed[0]["text"] == row["text"]
    assert claimed[0]["canonical_url"] == listing()["canonical_url"]
    assert claimed[0]["claim_token"]
    with pytest.raises(conflict):
        store.save("fl", "1", "Изменено во время отправки", row["revision"])
    with pytest.raises(conflict):
        store.cancel("fl", "1", row["revision"])
    assert "claim_token" not in store.get("fl", "1")


def test_uncertain_delivery_is_not_retried_after_restart(tmp_path):
    store, conflict = store_api(tmp_path)
    row = approved(store)
    store.queue("fl", "1", row["revision"])
    claim = store.claim()
    store.result("fl", "1", claim["claim_token"], "uncertain", "Страница не ответила после клика")
    reopened, _ = store_api(tmp_path)
    assert reopened.claim() is None
    assert reopened.get("fl", "1")["state"] == "uncertain"
    with pytest.raises(conflict):
        reopened.queue("fl", "1", row["revision"])
    done = reopened.result("fl", "1", claim["claim_token"], "sent",
                           "В исходящих виден опубликованный ответ", listing()["canonical_url"])
    assert done["state"] == "sent" and done["evidence"]
    assert reopened.claim() is None


def test_delivery_requires_claim_and_evidence_and_bad_token_cannot_unlock(tmp_path):
    store, conflict = store_api(tmp_path)
    row = approved(store)
    store.queue("fl", "1", row["revision"])
    claim = store.claim()
    with pytest.raises(conflict):
        store.result("fl", "1", "wrong", "not_sent", "Не отправлено")
    with pytest.raises(ValueError):
        store.result("fl", "1", claim["claim_token"], "sent", "")
    with pytest.raises(ValueError):
        store.result("fl", "1", claim["claim_token"], "sent", "Проверено", "javascript:alert(1)")
    row = store.result("fl", "1", claim["claim_token"], "not_sent", "Форма не открылась, отправки не было")
    assert row["state"] == "draft" and row["approved_revision"] is None
    assert store.claim() is None


def test_cancel_before_claim_revokes_approval(tmp_path):
    store, conflict = store_api(tmp_path)
    row = approved(store)
    store.queue("fl", "1", row["revision"])
    cancelled = store.cancel("fl", "1", row["revision"])
    assert cancelled["state"] == "draft" and cancelled["revision"] > row["revision"]
    assert store.claim() is None
    with pytest.raises(conflict):
        store.queue("fl", "1", row["revision"])


@pytest.mark.parametrize("text", ["", "   ", "x" * 8001, 12, None], ids=["empty", "blank", "too_long", "number", "null"])
def test_invalid_drafts_do_not_change_existing_text(tmp_path, text):
    store, _ = store_api(tmp_path)
    row = store.prepare(listing())
    with pytest.raises(ValueError):
        store.save("fl", "1", text, row["revision"])
    assert store.get("fl", "1")["text"] == row["text"]


def test_http_workflow_conflicts_and_unknown_listing(tmp_path):
    from autobid.command_center.controller import CenterController
    from autobid.command_center.server import create_server
    center = CenterController(seeded_paths(tmp_path))
    server = create_server(center, 0)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        token = json.loads(request(server, "GET", "/api/state")[2])["token"]
        identity = dict(source_id="fl", external_id="1")
        status, _, payload = request(server, "POST", "/api/review/prepare", identity, token)
        assert status == 200, "Review API is not implemented"
        row = json.loads(payload)
        data = identity | dict(revision=row["revision"], text="Подготовим проверяемый результат.")
        assert request(server, "POST", "/api/review/save", data)[0] == 403
        status, _, payload = request(server, "POST", "/api/review/save", data, token)
        assert status == 200
        row = json.loads(payload)
        data = identity | dict(revision=row["revision"])
        assert request(server, "POST", "/api/review/queue", data, token)[0] == 409
        assert request(server, "POST", "/api/review/approve", data, token)[0] == 200
        assert request(server, "POST", "/api/review/queue", data, token)[0] == 200
        state = json.loads(request(server, "GET", "/api/state")[2])
        assert state["reviews"][0]["state"] == "queued"
        assert "claim_token" not in json.dumps(state)
        assert request(server, "POST", "/api/review/prepare", identity | dict(external_id="missing"), token)[0] == 404
    finally:
        server.shutdown()
        server.server_close()
        center.close()
