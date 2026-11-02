from __future__ import annotations

import re
from decimal import Decimal
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from .models import Listing, Observation, SourceStatus
from .registry import canonicalize_fl_url


class ParseError(ValueError):
    pass


def plain(node) -> str:
    return " ".join(node.stripped_strings) if node else ""


def budget_fields(text: str, kind: str) -> dict:
    unit = {"order": "project", "vacancy": "salary_unspecified", "contest": "prize"}.get(kind)
    text = text.replace("\xa0", " ").replace("\u202f", " ")
    currency = "RUB" if re.search(r"₽|руб", text, re.I) else "USD" if "$" in text else "EUR" if "€" in text else None
    values = re.findall(r"\d+(?:[ ]\d{3})*(?:[.,]\d+)?", text)
    numbers = [Decimal(value.replace(" ", "").replace(",", ".")) for value in values]
    low = high = None
    if currency and numbers:
        low = high = numbers[0]
        if len(numbers) > 1 and re.search(r"[-–—]", text):
            low, high = numbers[:2]
        elif re.search(r"\bдо\b", text, re.I):
            low = None
        elif re.search(r"\bот\b", text, re.I):
            high = None
    return dict(budget_min=low, budget_max=high, currency=currency, budget_unit=unit)


def annotations(text: str, context: str) -> dict:
    formats = tuple(name for name in ("DWG", "DXF", "PDF", "STEP", "STP", "IGES", "STL", "OBJ", "CDW") if re.search(rf"\b{name}\b", text, re.I))
    categories = []
    for category, pattern in (
        ("drawing", r"черт[её]ж|перерис|dxf|dwg|autocad|компас"),
        ("3d", r"\b3[dд]\b|step|solidworks|sketchup|revit|bim"),
        ("floor_plan", r"план.*этаж|этаж.*план|планиров"),
    ):
        if re.search(pattern, text, re.I):
            categories.append(category)
    if "inzhiniring" in context:
        categories.append("engineering")
    constraints = tuple(sentence.strip() for sentence in re.split(r"[\n.!?]", text) if re.search(r"конфиденц|nda|неразглаш|не.*облак|обязательно|провер", sentence, re.I))
    return dict(cad_categories=tuple(dict.fromkeys(categories)), requested_formats=formats, explicit_constraints=constraints)


class FlSource:
    canonicalize = staticmethod(canonicalize_fl_url)

    def _soup(self, result):
        if result.access_state not in (SourceStatus.PUBLIC, SourceStatus.AUTHENTICATED) or not result.html:
            raise ParseError(result.error_code or "no_public_content")
        return BeautifulSoup(result.html, "html.parser")

    def _observation(self, external_id, url, fields, result):
        return Observation(Listing("fl", external_id, url, **fields), result.observed_at, frozenset(fields), {name: result.url for name in fields})

    def parse_list(self, result) -> list[Observation]:
        soup = self._soup(result)
        cards = soup.select('[id^="project-item"]')
        if not cards:
            raise ParseError("unexpected_structure")
        observations = []
        for card in cards:
            link = card.select_one('a[id^="prj_name_"]')
            if not link or not plain(link):
                raise ParseError("invalid_listing")
            url = self.canonicalize(urljoin(result.url, link.get("href", "")))
            external_id = re.search(r"/projects/(\d+)/", url)
            if not external_id:
                raise ParseError("invalid_listing_url")
            kind_node = card.select_one(".b-post__foot .b-post__bold")
            kind_text = plain(kind_node).lower()
            kind = "vacancy" if "вакансия" in kind_text else "contest" if "конкурс" in kind_text else "order" if "заказ" in kind_text else "unknown"
            description_node = card.select_one(".b-post__body .b-post__txt")
            fields = dict(title=plain(link), detail_complete=False)
            if kind != "unknown":
                fields["listing_kind"] = kind
            # Listing snippets are not authoritative full descriptions.
            if description_node:
                fields["description"] = plain(description_node)
            price = card.select_one(".b-post__price")
            if price is not None:
                pricing = budget_fields(plain(price), kind)
                if kind == "unknown":
                    pricing.pop("budget_unit")
                fields.update(pricing)
            counter = card.select_one('[data-id="fl-view-count-href"]')
            counter_text = plain(counter).lower()
            if counter:
                match = re.search(r"(\d+)\s+ответ", counter_text)
                if match or "нет ответов" in counter_text:
                    fields["bids_count"] = int(match[1]) if match else 0
            status = plain(card.select_one('[data-id="qa-order-status"]')).lower()
            foot = card.select_one(".b-post__foot")
            if re.search(r"исполнитель определ[её]н|закрыт|заверш[её]н|отмен[её]н", status or plain(foot).lower()):
                fields["availability"] = "closed"
            elif card.find("a", title="Откликнуться") or (foot and foot.find("a", string=re.compile("Откликнуться"))):
                fields["availability"] = "open"
            date = card.select_one(".b-post__foot .text-gray-opacity-4")
            if date:
                fields["raw_date"] = plain(date)
            if description_node is not None:
                fields.update(annotations(fields["title"] + "\n" + fields["description"], result.url))
            observations.append(self._observation(external_id[1], url, fields, result))
        return observations

    def parse_detail(self, result) -> Observation:
        soup = self._soup(result)
        url = self.canonicalize(result.url)
        match = re.search(r"/projects/(\d+)/", url)
        if not match:
            raise ParseError("not_a_detail_url")
        external_id = match[1]
        title = soup.select_one(f"h1#prj_name_{external_id}")
        description = soup.select_one(f"#projectp{external_id}")
        if not title or not description:
            raise ParseError("unexpected_detail_structure")
        fields = dict(title=plain(title), description=plain(description), detail_complete=True)
        label = soup.find(string=re.compile(r"^\s*Бюджет:"))
        if label:
            price = budget_fields(plain(label.parent), "unknown")
            price.pop("budget_unit")  # Detail layout does not establish publication kind.
            fields.update(price)
        info = soup.select_one(f"#project_info_{external_id}")
        published = info.find(string=re.compile("Опубликован")) if info else None
        if published:
            fields["raw_date"] = plain(published.parent).replace("Опубликован", "").strip()
        status = plain(info).lower()
        if re.search(r"исполнитель определ[её]н|заказ закрыт|проект закрыт", status):
            fields["availability"] = "closed"
        elif soup.select_one("#reply_offer"):
            fields["availability"] = "open"
        fields.update(annotations(fields["title"] + "\n" + fields["description"], result.url))
        return self._observation(external_id, url, fields, result)

    def next_page(self, result) -> str | None:
        soup = self._soup(result)
        for link in soup.find_all("a", href=True):
            if re.search(r"Следующая", plain(link)):
                return self.canonicalize(urljoin(result.url, link["href"]))
        return None

