from __future__ import annotations

import json
from dataclasses import dataclass

from autobid.config import Settings
from autobid.models import Decision, PriceResult, Project, ScoreResult

from .llm import OpenAICompatibleLLM
from .pricing import price_project
from .proposal import ProposalGenerator
from .scoring import score_project


class IntelligenceError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class IntelligenceResult:
    score: ScoreResult
    price: PriceResult
    proposal: str
    specifics: tuple[str, ...]


def project_specifics(project: Project) -> tuple[str, ...]:
    text = project.text
    candidates = (
        ("pdf", "PDF source"),
        ("exact dimension", "exact dimensions"),
        ("scale", "exact scale"),
        ("closed contour", "closed contours"),
        ("close all contour", "closed contours"),
        ("duplicate", "duplicate path cleanup"),
        ("open path", "open path cleanup"),
        ("laser", "laser cutting readiness"),
        ("cnc", "CNC readiness"),
        ("dxf", "DXF output"),
        ("2d", "2D geometry"),
    )
    return tuple(dict.fromkeys(label for phrase, label in candidates if phrase in text))


class HybridIntelligence:
    def __init__(self, settings: Settings, llm: OpenAICompatibleLLM | None = None) -> None:
        self.settings = settings
        self.llm = llm
        self.proposals = ProposalGenerator()

    def evaluate(self, project: Project) -> IntelligenceResult:
        baseline = score_project(project, self.settings)
        specifics = project_specifics(project)
        llm_amount = None
        if self.llm is not None:
            classification = self.llm.complete_json(
                f"Classify this project for photo/PDF/sketch to production 2D CAD work:\n{json.dumps({'title': project.title, 'description': project.description, 'skills': project.skills})}",
                {
                    "type": "object",
                    "properties": {
                        "score": {"type": "integer", "minimum": 0, "maximum": 100},
                        "reasons": {"type": "array", "items": {"type": "string"}},
                        "specifics": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["score", "reasons", "specifics"],
                    "additionalProperties": False,
                },
            )
            llm_score = max(0, min(100, int(classification["score"])))
            combined = round(baseline.score * 0.7 + llm_score * 0.3)
            decision = Decision.AUTO_BID if combined >= self.settings.auto_bid_score else Decision.REVIEW if combined >= self.settings.review_score else Decision.SKIP
            baseline = ScoreResult(combined, decision, tuple(dict.fromkeys((*baseline.reasons, *map(str, classification["reasons"])))))
            pricing = self.llm.complete_json(
                f"Recommend a bounded bid amount for category rules and this budget: {project.budget_min}-{project.budget_max} {project.currency_code}",
                {
                    "type": "object",
                    "properties": {"amount": {"type": "number"}, "delivery_days": {"type": "integer"}, "rationale": {"type": "string"}},
                    "required": ["amount", "delivery_days", "rationale"],
                    "additionalProperties": False,
                },
            )
            llm_amount = float(pricing["amount"])
        elif self.settings.llm_required:
            raise IntelligenceError("LLM_REQUIRED is true but no provider is configured")

        price = price_project(project, self.settings, llm_amount)
        if len(specifics) < 2:
            raise IntelligenceError("fewer than two verifiable project specifics")
        if self.llm is None:
            proposal = self.proposals.generate(project, specifics)
        else:
            generated = self.llm.complete_json(
                f"Write a concise truthful proposal that explicitly mentions at least two of these project specifics: {json.dumps(specifics)}. Project: {project.title}\n{project.description}",
                {
                    "type": "object",
                    "properties": {
                        "proposal": {"type": "string"},
                        "specifics_used": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["proposal", "specifics_used"],
                    "additionalProperties": False,
                },
            )
            declared_used = {str(value).strip().lower() for value in generated["specifics_used"]}
            verified_used = tuple(value for value in specifics if value.lower() in declared_used)
            proposal = self.proposals.validate(str(generated["proposal"]), project, verified_used)
        return IntelligenceResult(baseline, price, proposal, specifics)
