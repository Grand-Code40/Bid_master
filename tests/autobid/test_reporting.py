import json

from autobid.models import RunReport
from autobid.reporting.report import ReportWriter


def test_report_writer_creates_json_markdown_and_step_summary(tmp_path):
    report = RunReport("run-1", projects_scanned=54, new_projects=17, relevant=5, bids_sent=2, skipped=15)
    report.events.append({"kind": "BID SENT", "project": "PDF Sketches to DXF", "score": 96, "url": "https://example.test/1"})
    summary = tmp_path / "summary.md"

    paths = ReportWriter(tmp_path / "reports", summary_path=summary).write(report)

    data = json.loads(paths.json_path.read_text(encoding="utf-8"))
    markdown = paths.markdown_path.read_text(encoding="utf-8")
    assert data["projects_scanned"] == 54
    assert "Projects scanned: 54" in markdown
    assert "PDF Sketches to DXF" in summary.read_text(encoding="utf-8")
