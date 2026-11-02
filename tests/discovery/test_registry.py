import pytest
from autobid.discovery.registry import SOURCES, source_for_url
from autobid.discovery.models import ConnectionStep
from autobid.discovery.storage import DiscoveryDatabase


def test_only_implemented_source_accepts_urls():
    assert source_for_url("https://www.fl.ru/projects/5527616/test.html").id == "fl"
    assert SOURCES["telegram"].implemented is False
    assert SOURCES["kwork"].automated_access == "restricted"
    for url in ("file:///secret", "https://www.fl.ru.evil.test/projects/10/x.html", "https://user:pass@www.fl.ru/projects/", "https://www.fl.ru:444/projects/", "https://kwork.ru/projects"):
        with pytest.raises(ValueError):
            source_for_url(url)


def test_checkpoint_rejects_arbitrary_secret_values(tmp_path):
    with DiscoveryDatabase(tmp_path / "market.sqlite3") as db:
        with pytest.raises(ValueError):
            db.save_connection_step("fl", "password=do-not-store")
        db.save_connection_step("fl", ConnectionStep.FORM_READY)
        assert db.get_connection_step("fl") == ConnectionStep.FORM_READY
        assert b"do-not-store" not in (tmp_path / "market.sqlite3").read_bytes()

