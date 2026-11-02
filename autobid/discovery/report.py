from __future__ import annotations

import html
import json
from dataclasses import asdict
from pathlib import Path

from .models import listing_dict


def budget_groups(listings):
    groups = {}
    for item in listings:
        key = (item.currency, item.listing_kind, item.budget_unit)
        group = groups.setdefault(key, dict(currency=key[0], listing_kind=key[1], unit=key[2], count=0, known_budget_count=0, lowest=None, highest=None))
        group["count"] += 1
        values = [x for x in (item.budget_min, item.budget_max) if x is not None]
        if values:
            group["known_budget_count"] += 1
            group["lowest"] = min(values + ([group["lowest"]] if group["lowest"] is not None else []))
            group["highest"] = max(values + ([group["highest"]] if group["highest"] is not None else []))
    return [{k: str(v) if k in ("lowest", "highest") and v is not None else v for k, v in group.items()} for group in groups.values()]


def escape(value):
    text = html.escape(str(value), quote=False).replace("\n", " ")
    for char in ("\\", "*", "_", "[", "]", "|", chr(96)):
        text = text.replace(char, "\\" + char)
    return text


def report_markdown(report, listings, groups, states):
    lines = [
        "# CAIgraph — обзор CAD-заказов", "",
        f"{'Снимок сохранённых данных (без обращения к сайтам)' if report.mode == 'snapshot' else 'Проверка'}: {report.finished_at or report.started_at}. Новых: {report.new}; обновлено: {report.updated}; без изменений: {report.unchanged}.",
        f"Прочитано страниц списка: {report.list_pages}; страниц заказов: {report.detail_pages}.",
        "Выборка ограничена настройками обхода. Опубликованные бюджеты не являются подтверждённой оплатой.",
        "Есть неполное покрытие или ограничения доступа." if report.incomplete else "Все запрошенные страницы обработаны.",
        "", "| Источник | Состояние | Результат | Последний успешный доступ |", "|---|---|---|---|",
    ]
    for source_id, state in states.items():
        lines.append(f"| {escape(source_id)} | {escape(state['state'])} | {escape(state['code'])} | {escape(state.get('last_success') or 'неизвестно')} |")
    lines.extend(["", "## Опубликованные бюджеты", "", "| Тип | Валюта | Единица | Известно / записей | Диапазон |", "|---|---|---|---|---|"])
    for group in groups:
        lines.append(f"| {escape(group['listing_kind'])} | {escape(group['currency'] or 'не указана')} | {escape(group['unit'] or 'не указана')} | {group['known_budget_count']} / {group['count']} | {group['lowest'] or '—'} … {group['highest'] or '—'} |")
    lines.extend(["", "## Объявления", ""])
    for item in listings:
        budget = "не указан" if item.budget_min is None and item.budget_max is None else f"{item.budget_min if item.budget_min is not None else '…'}–{item.budget_max if item.budget_max is not None else '…'} {item.currency or ''}"
        bids = "неизвестно" if item.bids_count is None else str(item.bids_count)
        lines.extend([
            f"### [{escape(item.title or item.external_id)}]({item.canonical_url})", "",
            f"Источник: {escape(item.source_id)} · {escape(item.listing_kind)} · {escape(item.availability)}",
            f"Бюджет: {escape(budget)} · Отклики: {bids} · Дата на сайте: {escape(item.raw_date or 'не указана')}", "",
            escape(item.description), "",
        ])
    return "\n".join(lines)


def write_report(report, listings, output_dir: Path, *, source_states=None, records=None):
    output_dir.mkdir(parents=True, exist_ok=True)
    groups = budget_groups(listings)
    stem = f"{report.started_at[:10]}-{report.scan_id}"
    paths = {"json": str(output_dir / f"{stem}.json"), "markdown": str(output_dir / f"{stem}.md")}
    report.report_paths = paths
    states = source_states or report.sources
    data = {
        "schema_version": 1, "scan": asdict(report),
        "coverage": "bounded_observed_sample", "budget_meaning": "published_budget_not_paid",
        "source_states": states, "budget_groups": groups,
        "listings": [listing_dict(x) for x in listings],
        "listing_observations": records or [],
    }
    text = json.dumps(data, ensure_ascii=False, indent=2)
    markdown = report_markdown(report, listings, groups, states)
    for name, content in ((paths["json"], text), (paths["markdown"], markdown),
                          (str(output_dir / "latest.json"), text), (str(output_dir / "latest.md"), markdown)):
        path = Path(name)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(content, encoding="utf-8")
        temporary.replace(path)
    return paths

