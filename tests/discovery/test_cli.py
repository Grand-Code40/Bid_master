import json
from pathlib import Path

from autobid.discovery.cli import main
from autobid.discovery.fetch import HttpFetcher, classify_page

FIXTURES = Path(__file__).parent / "fixtures"


def test_public_cli_scan_requires_no_account_and_produces_report(tmp_path, monkeypatch, capsys):
    for key in ("FREELANCER_ACCOUNTS_JSON", "OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "DISCOVERY_EMAIL"):
        monkeypatch.delenv(key, raising=False)
    html = (FIXTURES / "fl-list.html").read_text(encoding="utf-8")
    monkeypatch.setattr(HttpFetcher, "fetch", lambda self, url: classify_page(url, 200, html))
    # The legacy sender must never be reached even if live bidding is enabled.
    monkeypatch.setenv("AUTOBID_ENABLED", "true")
    monkeypatch.setenv("DRY_RUN", "false")
    monkeypatch.setattr("autobid.service.AutoBidService.run", lambda self: (_ for _ in ()).throw(AssertionError("unexpected bid pipeline")))
    assert main(["--data-root", str(tmp_path), "scan", "--max-pages", "1", "--max-details", "0"]) == 0
    data = json.loads((tmp_path / "reports" / "latest.json").read_text(encoding="utf-8"))
    assert data["listings"][0]["budget_max"] == "5000"
    assert data["scan"]["new"] == 1
    assert data["budget_groups"][0]["listing_kind"] == "order"
    assert data["budget_groups"][0]["known_budget_count"] == 1
    assert "report" in capsys.readouterr().out.lower()
    assert main(["--data-root", str(tmp_path), "sources"]) == 0
    output = capsys.readouterr().out
    assert "telegram" in output and "unverified" in output


def test_unsupported_import_and_bad_limits_are_actionable(tmp_path, capsys):
    assert main(["--data-root", str(tmp_path), "import-url", "https://example.test/no"]) == 2
    assert "Unsupported" in capsys.readouterr().out


def test_report_groups_salary_and_orders_separately(tmp_path):
    from autobid.discovery.models import Listing
    from autobid.discovery.report import budget_groups
    from decimal import Decimal
    rows = [
        Listing("fl","1","https://www.fl.ru/projects/1/x.html", listing_kind="order", budget_unit="project", currency="RUB", budget_min=Decimal(5000), budget_max=Decimal(5000)),
        Listing("fl","2","https://www.fl.ru/projects/2/x.html", listing_kind="vacancy", budget_unit="salary_unspecified", currency="RUB", budget_min=Decimal(100000), budget_max=Decimal(150000)),
        Listing("fl","3","https://www.fl.ru/projects/3/x.html", listing_kind="order"),
    ]
    groups = budget_groups(rows)
    assert len(groups) == 3
    assert sum(g["count"] for g in groups) == 3
    assert sum(g["known_budget_count"] for g in groups) == 2


def test_saved_report_is_not_labelled_as_a_fresh_network_scan(tmp_path):
    assert main(["--data-root", str(tmp_path), "report"]) == 0
    data = json.loads((tmp_path / "reports" / "latest.json").read_text(encoding="utf-8"))
    assert data["scan"]["mode"] == "snapshot"
    assert data["scan"]["list_pages"] == 0


def test_cli_interrupt_writes_partial_report_and_exits_130(tmp_path, monkeypatch):
    from autobid.discovery.storage import DiscoveryDatabase
    html = (FIXTURES / "fl-list.html").read_text(encoding="utf-8")
    def interrupted(self, url):
        if "/category/" in url:
            return classify_page(url, 200, html)
        raise KeyboardInterrupt
    monkeypatch.setattr(HttpFetcher, "fetch", interrupted)
    assert main(["--data-root", str(tmp_path), "scan", "--max-pages", "1", "--max-details", "1"]) == 130
    path = tmp_path / "reports" / "latest.json"
    assert path.exists()
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["scan"]["incomplete"]
    assert data["scan"]["sources"]["fl"]["code"] == "interrupted"
    assert data["scan"]["new"] == 1
    with DiscoveryDatabase(tmp_path / "discovery.sqlite3") as db:
        assert len(db.list_listings()) == 1
