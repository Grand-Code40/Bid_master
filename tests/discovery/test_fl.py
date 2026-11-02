from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
import pytest
from autobid.discovery.fetch import FetchResult, classify_page
from autobid.discovery.fl import FlSource, ParseError

FIXTURES = Path(__file__).parent / "fixtures"
URL = "https://www.fl.ru/projects/category/inzhiniring/"
NOW = datetime(2026, 11, 2, 12, tzinfo=timezone.utc)


def result(name="fl-list.html", html=None, url=URL):
    return classify_page(url, 200, html if html is not None else (FIXTURES / name).read_text(encoding="utf-8"), NOW)


def test_real_list_card_fields():
    obs = FlSource().parse_list(result())[0]
    item = obs.listing
    assert item.external_id == "5527616"
    assert item.budget_min == item.budget_max == Decimal("5000")
    assert item.currency == "RUB"
    assert item.budget_unit == "project"
    assert item.bids_count == 28
    assert item.requested_formats == ("DXF", "PDF", "STEP")
    assert item.raw_date == "20 часов 38 минут назад"
    assert item.published_at is None
    assert item.availability == "open"
    assert obs.observed_at == NOW


@pytest.mark.parametrize("price,kind,want_min,want_max,unit", [
    ("10 000 ₽ – 15 000 ₽", "Вакансия (Россия)", "10000", "15000", "salary_unspecified"),
    ("до 1 500 ₽", "Заказ", None, "1500", "project"),
    ("от 2 000 ₽", "Конкурс", "2000", None, "prize"),
    ("по договоренности", "Заказ", None, None, "project"),
])
def test_price_types_do_not_mix_salary_prize_and_order(price, kind, want_min, want_max, unit):
    html = (FIXTURES / "fl-list.html").read_text(encoding="utf-8")
    start = html.index('<div class="b-post__price">')
    end = html.index('<div class="b-post__body">')
    html = html[:start] + '<div class="b-post__price">' + price + '</div>' + html[end:]
    html = html.replace('>Заказ</span>', '>' + kind + '</span>')
    item = FlSource().parse_list(result(html=html))[0].listing
    assert item.budget_min == (Decimal(want_min) if want_min else None)
    assert item.budget_max == (Decimal(want_max) if want_max else None)
    assert item.budget_unit == unit


def test_zero_missing_counter_and_closed_are_distinct():
    html = (FIXTURES / "fl-list.html").read_text(encoding="utf-8")
    source = FlSource()
    assert source.parse_list(result(html=html.replace("28 ответов", "Нет ответов")))[0].listing.bids_count == 0
    html = html.replace('data-id="fl-view-count-href"', 'data-id="unrelated"').replace('<div data-id="qa-order-status"></div>', '<div data-id="qa-order-status">Исполнитель определён</div>')
    obs = source.parse_list(result(html=html))[0]
    assert obs.listing.availability == "closed"
    assert obs.listing.bids_count is None
    assert "bids_count" not in obs.present_fields


def test_detail_preserves_base_currency_and_does_not_clear_list_counter():
    obs = FlSource().parse_detail(result("fl-detail.html", url="https://www.fl.ru/projects/5527616/test.html"))
    assert obs.listing.budget_max == Decimal("5000")
    assert obs.listing.currency == "RUB"
    assert "сборку" in obs.listing.description
    assert "bids_count" not in obs.present_fields
    assert obs.listing.raw_date == "01.11.2026 в 17:11"


@pytest.mark.parametrize("html,state", [
    ('<h1>Вход</h1><input type="password" value="topsecret">', "login_required"),
    ('<h1>Подтвердите, что вы не робот</h1><iframe src="https://smartcaptcha.yandexcloud.net/checkbox"></iframe>', "human_required"),
    ('<h1>Я соглашаюсь с условиями</h1><input value="topsecret">', "human_required"),
    ('<html><h1>New layout with no listings</h1></html>', "error"),
])
def test_200_non_listing_page_is_not_empty_success_or_secret_leak(html, state):
    response = result(html=html)
    assert response.access_state == state
    assert response.html is None
    assert "topsecret" not in repr(response)
    with pytest.raises(ParseError):
        FlSource().parse_list(response)


def test_public_page_with_login_link_and_background_captcha_script_is_public():
    response = result(html=(FIXTURES / "fl-list.html").read_text(encoding="utf-8") + '<script src="smartcaptcha.yandexcloud.net/captcha.js"></script><a href="/account/login/">Вход</a>')
    assert response.access_state == "public"


def test_reject_unknown_paths_and_strip_tracking_without_accepting_credentials():
    source = FlSource()
    assert source.canonicalize("https://fl.ru/projects/5527616/test.html?utm_source=share#x") == "https://www.fl.ru/projects/5527616/test.html"
    for url in ("https://www.fl.ru/account/delete", "https://www.fl.ru/away/?href=http://localhost", "http://www.fl.ru/projects/", "https://user:secret@www.fl.ru/projects/"):
        with pytest.raises(ValueError):
            source.canonicalize(url)


def test_rejects_slug_that_could_inject_markdown():
    with pytest.raises(ValueError):
        FlSource().canonicalize("https://www.fl.ru/projects/10/x)![click](https:evil).html")
