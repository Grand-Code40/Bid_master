from dataclasses import replace
from pathlib import Path
from decimal import Decimal

from autobid.discovery.fetch import classify_page
from autobid.discovery.registry import SOURCES
from autobid.discovery.service import DiscoveryService
from autobid.discovery.storage import DiscoveryDatabase

FIXTURES = Path(__file__).parent / "fixtures"
LIST_URL = SOURCES["fl"].listing_urls[0]
REGISTRY = {"fl": replace(SOURCES["fl"], listing_urls=(LIST_URL,)), "telegram": SOURCES["telegram"]}


class FixtureFetcher:
    def __init__(self):
        self.list_html = (FIXTURES / "fl-list.html").read_text(encoding="utf-8")
        self.detail_html = (FIXTURES / "fl-detail.html").read_text(encoding="utf-8")
        self.calls = []

    def fetch(self, url):
        self.calls.append(url)
        return classify_page(url, 200, self.list_html if "/category/" in url else self.detail_html)


def test_scan_rescan_updates_without_duplicates(tmp_path):
    fetcher = FixtureFetcher()
    with DiscoveryDatabase(tmp_path / "db") as db:
        service = DiscoveryService(db, REGISTRY, fetcher)
        first = service.scan(["fl"], max_pages=1, max_details=1)
        assert (first.new, first.updated, first.unchanged) == (1, 0, 0)
        second = service.scan(["fl"], max_pages=1, max_details=1)
        assert (second.new, second.updated, second.unchanged) == (0, 0, 1)
        fetcher.list_html = fetcher.list_html.replace("5&nbsp;000", "6&nbsp;000").replace('<div data-id="qa-order-status"></div>', '<div data-id="qa-order-status">Исполнитель определён</div>')
        fetcher.detail_html = fetcher.detail_html.replace("5 000", "6 000").replace('Откликнуться</a>', 'Исполнитель определён</a>')
        third = service.scan(["fl"], max_pages=1, max_details=1)
        assert third.updated == 1
        assert len(db.list_listings()) == 1
        assert db.list_listings()[0].budget_max == Decimal("6000")
        assert db.list_listings()[0].availability == "closed"


def test_partial_sources_and_detail_failure_preserve_full_description(tmp_path):
    fetcher = FixtureFetcher()
    with DiscoveryDatabase(tmp_path / "db") as db:
        service = DiscoveryService(db, REGISTRY, fetcher)
        service.scan(["fl"], max_pages=1, max_details=1)
        original = db.list_listings()[0].description
        fetcher.detail_html = '<input type="password" value="never-report-this">'
        report = service.scan(["telegram", "fl"], max_pages=1, max_details=1)
        assert report.incomplete
        assert db.list_listings()[0].description == original
        assert "сборку" in original
        assert report.sources["telegram"]["code"] == "not_implemented"
        assert report.sources["fl"]["detail_failures"] == 1
        assert "never-report-this" not in str(report)
        assert len(db.list_listings()) == 1


def test_request_budgets_are_global_and_real_urls_are_used(tmp_path):
    fetcher = FixtureFetcher()
    with DiscoveryDatabase(tmp_path / "db") as db:
        report = DiscoveryService(db, SOURCES, fetcher).scan(["fl"], max_pages=1, max_details=0)
        assert fetcher.calls == [LIST_URL]
        assert report.list_pages == 1 and report.detail_pages == 0
        assert report.incomplete
        assert db.list_listings()[0].description


def test_unknown_url_rejected_before_fetch(tmp_path):
    import pytest
    fetcher = FixtureFetcher()
    with DiscoveryDatabase(tmp_path / "db") as db:
        with pytest.raises(ValueError):
            DiscoveryService(db, SOURCES, fetcher).import_url("https://unsupported.example/job")
    assert fetcher.calls == []



import pytest


@pytest.mark.parametrize("missing_selector", [".b-post__foot .b-post__bold", ".b-post__body .b-post__txt"])
def test_omitted_markup_preserves_derived_metadata(tmp_path, missing_selector):
    from bs4 import BeautifulSoup
    from autobid.discovery.fl import FlSource
    html = (FIXTURES / "fl-list.html").read_text(encoding="utf-8")
    with DiscoveryDatabase(tmp_path / "db") as db:
        source = FlSource()
        db.upsert(source.parse_list(classify_page(LIST_URL, 200, html))[0])
        soup = BeautifulSoup(html.replace("28 ответов", "29 ответов"), "html.parser")
        soup.select_one(missing_selector).decompose()
        db.upsert(source.parse_list(classify_page(LIST_URL, 200, str(soup)))[0])
        item = db.list_listings()[0]
        assert item.listing_kind == "order"
        assert item.budget_unit == "project"
        assert item.requested_formats == ("DXF", "PDF", "STEP")
        assert item.bids_count == 29


def test_interrupt_after_saved_observation_retains_partial_result(tmp_path):
    fetcher = FixtureFetcher()
    original_fetch = fetcher.fetch
    def interrupted(url):
        if "/category/" not in url:
            raise KeyboardInterrupt
        return original_fetch(url)
    fetcher.fetch = interrupted
    with DiscoveryDatabase(tmp_path / "db") as db:
        db.set_source_state("fl", "public", "ok")
        last_success = db.source_states()["fl"]["last_success"]
        with pytest.raises(KeyboardInterrupt) as caught:
            DiscoveryService(db, REGISTRY, fetcher).scan(["fl"], max_pages=1, max_details=1)
        assert len(db.list_listings()) == 1
        assert db.source_states()["fl"]["code"] == "interrupted"
        assert db.source_states()["fl"]["last_success"] == last_success
        report = caught.value.report
        assert report.incomplete and report.finished_at
        assert report.new == 1 and report.list_pages == 1
        assert report.sources["fl"]["code"] == "interrupted"


def test_import_interrupt_marks_source_without_losing_last_success(tmp_path):
    class Interrupted:
        def fetch(self, url):
            raise KeyboardInterrupt
    with DiscoveryDatabase(tmp_path / "db") as db:
        db.set_source_state("fl", "public", "ok")
        previous = db.source_states()["fl"]["last_success"]
        with pytest.raises(KeyboardInterrupt) as caught:
            DiscoveryService(db, REGISTRY, Interrupted()).import_url("https://www.fl.ru/projects/5527616/test.html")
        assert db.source_states()["fl"]["code"] == "interrupted"
        assert db.source_states()["fl"]["last_success"] == previous
        assert caught.value.report.incomplete



@pytest.mark.parametrize("operation", ["scan", "import"])
@pytest.mark.parametrize("committed", [False, True])
def test_interruption_counts_only_records_that_were_committed(tmp_path, monkeypatch, operation, committed):
    with DiscoveryDatabase(tmp_path / "db") as db:
        actual_upsert = db.upsert
        def interrupted_write(observation):
            if committed:
                actual_upsert(observation)
            raise KeyboardInterrupt
        monkeypatch.setattr(db, "upsert", interrupted_write)
        service = DiscoveryService(db, REGISTRY, FixtureFetcher())
        with pytest.raises(KeyboardInterrupt) as caught:
            if operation == "scan":
                service.scan(["fl"], max_pages=1, max_details=1)
            else:
                service.import_url("https://www.fl.ru/projects/5527616/test.html")
        assert len(db.list_listings()) == int(committed)
        assert caught.value.report.new == int(committed)

