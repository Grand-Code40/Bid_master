import json

import pytest

from autobid.config import Settings
from autobid.intelligence.llm import LLMResponseError, OpenAICompatibleLLM
from autobid.intelligence.engine import HybridIntelligence
from autobid.intelligence.pricing import PricingError, price_project
from autobid.intelligence.proposal import ProposalError, ProposalGenerator
from autobid.intelligence.scoring import score_project
from autobid.models import Decision, Project


def project(**overrides):
    data = {
        "project_id": 1001,
        "title": "Convert PDF sketch to laser-ready DXF",
        "description": (
            "Redraw the attached PDF at exact dimensions as a 2D DXF. "
            "Close all contours and remove duplicate paths for laser cutting."
        ),
        "url": "https://www.freelancer.com/projects/1001",
        "status": "ACTIVE",
        "budget_min": 50.0,
        "budget_max": 150.0,
        "currency_code": "USD",
        "skills": ("AutoCAD", "CAD/CAM"),
    }
    data.update(overrides)
    return Project(**data)


def settings(**overrides):
    data = {"database_url": "sqlite:///:memory:"}
    data.update(overrides)
    return Settings(**data)


def test_high_fit_project_reaches_auto_bid_with_reason_codes():
    result = score_project(project(), settings())

    assert result.score >= 88
    assert result.decision is Decision.AUTO_BID
    assert {"pdf_input", "dxf_output", "laser_cutting", "2d_geometry", "closed_contours"} <= set(result.reasons)


def test_complex_3d_project_is_not_auto_bid():
    item = project(
        title="Architectural 3D rendering",
        description="Create a complex 3D building model, animation and photorealistic rendering from scratch.",
    )

    result = score_project(item, settings())

    assert result.score < 75
    assert result.decision is Decision.SKIP
    assert "complex_3d" in result.reasons


def test_pricing_stays_inside_project_and_system_bounds():
    result = price_project(project(budget_min=80.0, budget_max=90.0), settings(min_acceptable_bid=60, max_auto_bid=100))

    assert result.amount == 90.0
    assert 1 <= result.delivery_days <= 7
    assert result.category == "complex_redraw"


def test_pricing_rejects_missing_or_impossible_budget():
    with pytest.raises(PricingError, match="budget"):
        price_project(project(budget_min=None, budget_max=None), settings())

    with pytest.raises(PricingError, match="MAX_AUTO_BID"):
        price_project(project(budget_min=600.0, budget_max=800.0), settings(max_auto_bid=500))


def test_llm_rejects_malformed_structured_response():
    calls = 0

    class Response:
        def read(self):
            return json.dumps({"choices": [{"message": {"content": "not json"}}]}).encode()

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def open_response(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return Response()

    llm = OpenAICompatibleLLM("https://llm.invalid/v1", "key", "model", max_retries=2, opener=open_response)

    with pytest.raises(LLMResponseError, match="valid JSON"):
        llm.complete_json("classify", {"type": "object", "required": ["score"]})
    assert calls == 3


def test_proposal_mentions_two_project_specifics_and_rejects_generic_text():
    generator = ProposalGenerator()
    item = project()

    proposal = generator.generate(item, ("exact dimensions", "closed contours", "laser cutting"))

    assert "exact dimensions" in proposal.lower()
    assert "closed contours" in proposal.lower()
    assert len(proposal) < 900

    with pytest.raises(ProposalError, match="two project specifics"):
        generator.validate("I can do this job quickly.", item, ("exact dimensions", "closed contours"))


def test_llm_proposal_cannot_substitute_invented_project_specifics():
    class SequenceLLM:
        def __init__(self):
            self.responses = iter((
                {"score": 100, "reasons": ["semantic_match"], "specifics": ["3D printing", "aerospace tolerance"]},
                {"amount": 80, "delivery_days": 2, "rationale": "bounded"},
                {"proposal": "I will handle 3D printing and aerospace tolerance.", "specifics_used": ["3D printing", "aerospace tolerance"]},
            ))

        def complete_json(self, _prompt, _schema):
            return next(self.responses)

    with pytest.raises(ProposalError, match="two project specifics"):
        HybridIntelligence(settings(), SequenceLLM()).evaluate(project())


def test_category_prices_are_configurable():
    custom = (
        ("simple_single_part", 40.0, 1),
        ("small_batch", 70.0, 2),
        ("large_batch", 150.0, 5),
        ("complex_redraw", 85.0, 2),
        ("sheet_metal_extended", 130.0, 4),
    )

    result = price_project(project(), settings(pricing_rules=custom))

    assert result.amount == 85.0
    assert result.delivery_days == 2
