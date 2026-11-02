from __future__ import annotations

from autobid.config import Settings
from autobid.models import PriceResult, Project


class PricingError(ValueError):
    pass


def categorize(project: Project) -> str:
    text = project.text
    if any(term in text for term in ("sheet metal", "bend", "flat pattern")):
        return "sheet_metal_extended"
    if any(term in text for term in ("large batch", "dozens", "50 parts", "100 parts")):
        return "large_batch"
    if any(term in text for term in ("batch", "multiple parts", "several parts")):
        return "small_batch"
    if any(term in text for term in ("redraw", "exact dimension", "duplicate", "open path", "cleanup")):
        return "complex_redraw"
    return "simple_single_part"


def price_project(project: Project, settings: Settings, llm_recommendation: float | None = None) -> PriceResult:
    if project.budget_min is None or project.budget_max is None or project.budget_min > project.budget_max:
        raise PricingError("project budget is missing or invalid")
    if project.budget_min > settings.max_auto_bid:
        raise PricingError("project minimum exceeds MAX_AUTO_BID")
    category = categorize(project)
    configured = {name: (amount, days) for name, amount, days in settings.pricing_rules}
    if category not in configured:
        raise PricingError(f"missing pricing rule for {category}")
    rules_amount, rules_days = configured[category]
    if llm_recommendation is not None:
        # The model is advisory and can move the rules result by at most 20%.
        lower, upper = rules_amount * 0.8, rules_amount * 1.2
        rules_amount = max(lower, min(upper, llm_recommendation))
    floor = max(project.budget_min, settings.min_acceptable_bid)
    ceiling = min(project.budget_max, settings.max_auto_bid)
    if floor > ceiling:
        raise PricingError("no safe amount inside project budget and configured bounds")
    amount = round(max(floor, min(ceiling, rules_amount)), 2)
    days = min(settings.max_delivery_days, rules_days)
    return PriceResult(amount, days, category, f"rules={rules_amount:.2f}; budget={floor:.2f}-{ceiling:.2f}")
