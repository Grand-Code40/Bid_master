from __future__ import annotations

from autobid.config import Settings
from autobid.models import Project, ScoreResult

from .scoring import score_project


class ProjectClassifier:
    """Deterministic baseline; an LLM provider may add validated advisory data."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def classify(self, project: Project) -> ScoreResult:
        return score_project(project, self.settings)
