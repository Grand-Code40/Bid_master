from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from autobid.models import RunReport


@dataclass(frozen=True, slots=True)
class ReportPaths:
    json_path: Path
    markdown_path: Path


def report_dict(report: RunReport) -> dict[str, Any]:
    data = asdict(report)
    for key in ("started_at", "finished_at"):
        if isinstance(data[key], datetime):
            data[key] = data[key].astimezone(timezone.utc).isoformat()
    return data


def report_markdown(report: RunReport) -> str:
    started = report.started_at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# Freelancer AutoBid — {started}",
        "",
        f"- Projects scanned: {report.projects_scanned}",
        f"- New projects: {report.new_projects}",
        f"- Relevant: {report.relevant}",
        f"- Auto bids sent: {report.bids_sent}",
        f"- Intended bids: {report.intended_bids}",
        f"- Skipped: {report.skipped}",
        f"- Emergency stop: {'YES' if report.emergency_stop else 'no'}",
    ]
    for event in report.events:
        lines.extend(["", f"## {event.get('kind', 'EVENT')}"])
        for key, value in event.items():
            if key != "kind" and value is not None:
                lines.append(f"- {key.replace('_', ' ').title()}: {value}")
    if report.errors:
        lines.extend(["", "## Errors"])
        lines.extend(f"- {error}" for error in report.errors)
    return "\n".join(lines) + "\n"


class ReportWriter:
    def __init__(self, output_dir: str | Path, *, summary_path: str | Path | None = None) -> None:
        self.output_dir = Path(output_dir)
        raw_summary = summary_path or os.environ.get("GITHUB_STEP_SUMMARY")
        self.summary_path = Path(raw_summary) if raw_summary else None

    def write(self, report: RunReport) -> ReportPaths:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        json_path = self.output_dir / "report.json"
        markdown_path = self.output_dir / "report.md"
        markdown = report_markdown(report)
        json_path.write_text(json.dumps(report_dict(report), indent=2, sort_keys=True), encoding="utf-8")
        markdown_path.write_text(markdown, encoding="utf-8")
        if self.summary_path:
            self.summary_path.parent.mkdir(parents=True, exist_ok=True)
            with self.summary_path.open("a", encoding="utf-8") as handle:
                handle.write(markdown)
        return ReportPaths(json_path, markdown_path)

