from __future__ import annotations

from collections.abc import Iterable

from autobid.config import Settings
from autobid.models import Decision, Project, ScoreResult


_SIGNALS: tuple[tuple[str, tuple[str, ...], int], ...] = (
    ("pdf_input", ("pdf",), 15),
    ("image_input", ("photo", "image", "scan", "sketch"), 12),
    ("dxf_output", ("dxf",), 20),
    ("cad_output", ("dwg", "svg", "cad"), 10),
    ("laser_cutting", ("laser", "plasma", "waterjet", "cnc"), 18),
    ("2d_geometry", ("2d", "two-dimensional"), 10),
    ("known_dimensions", ("exact dimension", "known dimension", "scale", "measurement"), 10),
    ("closed_contours", ("closed contour", "close all contour", "closed path"), 10),
    ("path_cleanup", ("duplicate", "open path", "cleanup", "clean up"), 8),
    ("batch", ("batch", "multiple parts", "several parts"), 7),
    ("repeat_work", ("ongoing", "similar work", "more work"), 5),
)

_PENALTIES: tuple[tuple[str, tuple[str, ...], int], ...] = (
    ("complex_3d", ("complex 3d", "3d model", "from scratch"), 55),
    ("rendering", ("rendering", "animation", "visualization", "photorealistic"), 45),
    ("pcb", ("pcb", "circuit board"), 70),
    ("art_only", ("illustration only", "digital painting", "character art"), 50),
)


def _matches(text: str, phrases: Iterable[str]) -> bool:
    return any(phrase in text for phrase in phrases)


def score_project(project: Project, settings: Settings) -> ScoreResult:
    text = project.text
    score = 10
    reasons: list[str] = []
    for code, phrases, weight in _SIGNALS:
        if _matches(text, phrases):
            score += weight
            reasons.append(code)
    for code, phrases, weight in _PENALTIES:
        if _matches(text, phrases):
            score -= weight
            reasons.append(code)
    if project.budget_max is not None and project.budget_max < settings.min_acceptable_bid:
        score -= 40
        reasons.append("low_budget")
    score = max(0, min(100, score))
    if score >= settings.auto_bid_score:
        decision = Decision.AUTO_BID
    elif score >= settings.review_score:
        decision = Decision.REVIEW
    else:
        decision = Decision.SKIP
    return ScoreResult(score=score, decision=decision, reasons=tuple(reasons))
