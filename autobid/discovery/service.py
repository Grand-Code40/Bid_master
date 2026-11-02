from __future__ import annotations

from dataclasses import asdict, dataclass, field
from uuid import uuid4

from .fl import FlSource, ParseError
from .models import SourceStatus, utcnow
from .registry import source_for_url


@dataclass
class ScanReport:
    mode: str = "scan"
    scan_id: str = field(default_factory=lambda: uuid4().hex[:12])
    started_at: str = field(default_factory=lambda: utcnow().isoformat())
    finished_at: str | None = None
    sources: dict = field(default_factory=dict)
    new: int = 0
    updated: int = 0
    unchanged: int = 0
    list_pages: int = 0
    detail_pages: int = 0
    incomplete: bool = False
    report_paths: dict = field(default_factory=dict)


class ScanInterrupted(KeyboardInterrupt):
    def __init__(self, report: ScanReport):
        super().__init__("Discovery scan interrupted")
        self.report = report


class DiscoveryService:
    def __init__(self, database, registry, fetcher):
        self.database, self.registry, self.fetcher = database, registry, fetcher
        self.adapter = FlSource()

    def _snapshot(self):
        return {(x.source_id, x.external_id): asdict(x) for x in self.database.list_listings()}

    def _finish(self, report, before, touched):
        after = self._snapshot()
        # Include committed changes even if interruption landed just before
        # the caller recorded the identity; never count a rolled-back write.
        changed = {key for key in after if key not in before or after[key] != before[key]}
        for key in (set(touched) | changed) & after.keys():
            if key not in before:
                report.new += 1
            elif before[key] != after[key]:
                report.updated += 1
            else:
                report.unchanged += 1
        report.finished_at = utcnow().isoformat()
        return report

    def scan(self, source_ids: list[str], max_pages: int = 2, max_details: int = 10) -> ScanReport:
        if not 1 <= max_pages <= 100 or not 0 <= max_details <= 1000:
            raise ValueError("Use 1..100 list pages and 0..1000 detail pages")
        report, before, touched = ScanReport(), self._snapshot(), set()
        detailed, visited = set(), set()
        source_id = None
        try:
            for source_id in dict.fromkeys(source_ids):
                source = self.registry.get(source_id)
                if not source or not source.implemented:
                    outcome = dict(state="unverified", code="not_implemented", detail_failures=0, list_failures=0, bounded=False)
                    report.sources[source_id] = outcome
                    report.incomplete = True
                    self.database.set_source_state(source_id, SourceStatus.UNVERIFIED, "not_implemented")
                    continue
                outcome = dict(state="unverified", code="not_scanned", detail_failures=0, list_failures=0, bounded=False)
                report.sources[source_id] = outcome
                queue = list(source.listing_urls)
                successes = 0
                while queue and report.list_pages < max_pages:
                    url = queue.pop(0)
                    if url in visited:
                        continue
                    visited.add(url)
                    response = self.fetcher.fetch(url)
                    report.list_pages += 1
                    try:
                        observations = self.adapter.parse_list(response)
                    except ParseError:
                        outcome.update(state=response.access_state.value if response.access_state != SourceStatus.PUBLIC else "error", code=response.error_code or "parse_error")
                        outcome["list_failures"] += 1
                        report.incomplete = True
                        continue
                    successes += 1
                    for observation in observations:
                        key = (observation.listing.source_id, observation.listing.external_id)
                        self.database.upsert(observation)
                        touched.add(key)
                        if key in detailed:
                            continue
                        if report.detail_pages >= max_details:
                            outcome["bounded"] = True
                            report.incomplete = True
                            continue
                        detailed.add(key)
                        detail_result = self.fetcher.fetch(observation.listing.canonical_url)
                        report.detail_pages += 1
                        try:
                            detail = self.adapter.parse_detail(detail_result)
                            self.database.upsert(detail)
                        except ParseError:
                            outcome["detail_failures"] += 1
                            report.incomplete = True
                    next_page = self.adapter.next_page(response)
                    if next_page and next_page not in visited:
                        queue.append(next_page)
                if queue:
                    outcome["bounded"] = True
                    report.incomplete = True
                if successes:
                    outcome["state"] = "public"
                    outcome["code"] = "partial" if outcome["list_failures"] or outcome["detail_failures"] else "ok"
                self.database.set_source_state(source_id, outcome["state"], outcome["code"])
        except KeyboardInterrupt:
            self._interrupted(report, before, touched, source_id)
        return self._finish(report, before, touched)

    def _interrupted(self, report, before, touched, source_id):
        report.incomplete = True
        if source_id is not None:
            report.sources.setdefault(source_id, {}).update(state="error", code="interrupted")
            self.database.set_source_state(source_id, SourceStatus.ERROR, "interrupted")
        raise ScanInterrupted(self._finish(report, before, touched)) from None

    def import_url(self, url: str) -> ScanReport:
        source = source_for_url(url)
        url = self.adapter.canonicalize(url)
        import re
        if not re.search(r"/projects/\d+/", url):
            raise ValueError("A supported project detail URL is required")
        before, report = self._snapshot(), ScanReport()
        try:
            response = self.fetcher.fetch(url)
            report.detail_pages = 1
            try:
                observation = self.adapter.parse_detail(response)
            except ParseError:
                state = response.access_state if response.access_state != SourceStatus.PUBLIC else SourceStatus.ERROR
                code = response.error_code or "parse_error"
                self.database.set_source_state(source.id, state, code)
                report.sources[source.id] = dict(state=state.value, code=code)
                report.incomplete = True
                return self._finish(report, before, set())
            self.database.upsert(observation)
            self.database.set_source_state(source.id, SourceStatus.PUBLIC, "ok")
            report.sources[source.id] = dict(state="public", code="ok")
            return self._finish(report, before, {(source.id, observation.listing.external_id)})

        except KeyboardInterrupt:
            touched = {(source.id, observation.listing.external_id)} if "observation" in locals() else set()
            self._interrupted(report, before, touched, source.id)
