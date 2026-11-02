from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Mapping

from .models import Account


class ConfigurationError(ValueError):
    pass


DEFAULT_PRICING_RULES: tuple[tuple[str, float, int], ...] = (
    ("simple_single_part", 55.0, 1),
    ("small_batch", 110.0, 3),
    ("large_batch", 240.0, 6),
    ("complex_redraw", 120.0, 3),
    ("sheet_metal_extended", 180.0, 5),
)


def _bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigurationError(f"{name} must be a boolean")


def _int(env: Mapping[str, str], name: str, default: int, *, minimum: int = 0) -> int:
    try:
        value = int(env.get(name, str(default)))
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    if value < minimum:
        raise ConfigurationError(f"{name} must be >= {minimum}")
    return value


def _float(env: Mapping[str, str], name: str, default: float, *, minimum: float = 0) -> float:
    try:
        value = float(env.get(name, str(default)))
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be a number") from exc
    if value < minimum:
        raise ConfigurationError(f"{name} must be >= {minimum}")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str
    autobid_enabled: bool = False
    dry_run: bool = True
    auto_bid_score: int = 88
    review_score: int = 75
    min_acceptable_bid: float = 25.0
    max_auto_bid: float = 500.0
    max_delivery_days: int = 7
    pricing_rules: tuple[tuple[str, float, int], ...] = DEFAULT_PRICING_RULES
    max_bids_per_run: int = 1
    max_bids_per_day: int = 2
    max_bids_per_month: int = 20
    max_bids_per_account_per_day: int = 1
    emergency_stop: bool = False
    max_sequential_bid_failures: int = 3
    max_rate_limit_errors: int = 2
    search_query: str = "DXF CAD laser CNC PDF drawing"
    search_limit: int = 50
    llm_base_url: str | None = None
    llm_api_key: str | None = field(default=None, repr=False)
    llm_model: str | None = None
    llm_required: bool = False
    llm_max_retries: int = 2
    freelancer_url: str | None = None
    accounts: tuple[Account, ...] = ()
    report_dir: str = "reports"
    telegram_bot_token: str | None = field(default=None, repr=False)
    telegram_chat_id: str | None = None

    @property
    def live_bidding(self) -> bool:
        return self.autobid_enabled and not self.dry_run and not self.emergency_stop

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        source = os.environ if env is None else env
        database_url = source.get("DATABASE_URL", "").strip()
        if not database_url:
            raise ConfigurationError("DATABASE_URL is required")
        accounts = _parse_accounts(source)
        auto_score = _int(source, "AUTO_BID_SCORE", 88, minimum=1)
        review_score = _int(source, "REVIEW_SCORE", 75, minimum=0)
        if not 0 <= review_score < auto_score <= 100:
            raise ConfigurationError("thresholds must satisfy 0 <= REVIEW_SCORE < AUTO_BID_SCORE <= 100")
        return cls(
            database_url=database_url,
            autobid_enabled=_bool(source, "AUTOBID_ENABLED", False),
            dry_run=_bool(source, "DRY_RUN", True),
            auto_bid_score=auto_score,
            review_score=review_score,
            min_acceptable_bid=_float(source, "MIN_ACCEPTABLE_BID", 25.0),
            max_auto_bid=_float(source, "MAX_AUTO_BID", 500.0),
            max_delivery_days=_int(source, "MAX_DELIVERY_DAYS", 7, minimum=1),
            pricing_rules=_parse_pricing_rules(source.get("PRICING_RULES_JSON")),
            max_bids_per_run=_int(source, "MAX_BIDS_PER_RUN", 1),
            max_bids_per_day=_int(source, "MAX_BIDS_PER_DAY", 2),
            max_bids_per_month=_int(source, "MAX_BIDS_PER_MONTH", 20),
            max_bids_per_account_per_day=_int(source, "MAX_BIDS_PER_ACCOUNT_PER_DAY", 1),
            emergency_stop=_bool(source, "EMERGENCY_STOP", False),
            max_sequential_bid_failures=_int(source, "MAX_SEQUENTIAL_BID_FAILURES", 3, minimum=1),
            max_rate_limit_errors=_int(source, "MAX_RATE_LIMIT_ERRORS", 2, minimum=1),
            search_query=source.get("FREELANCER_SEARCH_QUERY", "DXF CAD laser CNC PDF drawing"),
            search_limit=_int(source, "FREELANCER_SEARCH_LIMIT", 50, minimum=1),
            llm_base_url=source.get("LLM_BASE_URL") or None,
            llm_api_key=source.get("LLM_API_KEY") or None,
            llm_model=source.get("LLM_MODEL") or None,
            llm_required=_bool(source, "LLM_REQUIRED", False),
            llm_max_retries=_int(source, "LLM_MAX_RETRIES", 2),
            freelancer_url=source.get("FREELANCER_URL") or None,
            accounts=accounts,
            report_dir=source.get("AUTOBID_REPORT_DIR", "reports"),
            telegram_bot_token=source.get("TELEGRAM_BOT_TOKEN") or None,
            telegram_chat_id=source.get("TELEGRAM_CHAT_ID") or None,
        )


def _parse_accounts(env: Mapping[str, str]) -> tuple[Account, ...]:
    raw = env.get("FREELANCER_ACCOUNTS_JSON", "[]")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigurationError("FREELANCER_ACCOUNTS_JSON must be valid JSON") from exc
    if not isinstance(data, list):
        raise ConfigurationError("FREELANCER_ACCOUNTS_JSON must be a JSON array")
    accounts: list[Account] = []
    for item in data:
        if not isinstance(item, dict) or not {"account_id", "username", "token_env"} <= item.keys():
            raise ConfigurationError("each account requires account_id, username, and token_env")
        token_env = str(item["token_env"])
        token = env.get(token_env, "")
        if not token:
            raise ConfigurationError(f"missing OAuth token in {token_env}")
        accounts.append(Account(
            account_id=int(item["account_id"]),
            username=str(item["username"]),
            token=token,
            enabled=bool(item.get("enabled", True)),
            profile_tags=tuple(str(tag).lower() for tag in item.get("profile_tags", [])),
            bids_remaining=int(item["bids_remaining"]) if item.get("bids_remaining") is not None else None,
            rating=float(item["rating"]) if item.get("rating") is not None else None,
        ))
    if len({account.account_id for account in accounts}) != len(accounts):
        raise ConfigurationError("account_id values must be unique")
    return tuple(accounts)


def _parse_pricing_rules(raw: str | None) -> tuple[tuple[str, float, int], ...]:
    if not raw:
        return DEFAULT_PRICING_RULES
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigurationError("PRICING_RULES_JSON must be valid JSON") from exc
    if not isinstance(data, dict):
        raise ConfigurationError("PRICING_RULES_JSON must be a JSON object")
    expected = {name for name, _amount, _days in DEFAULT_PRICING_RULES}
    if set(data) != expected:
        raise ConfigurationError(f"PRICING_RULES_JSON must define exactly: {', '.join(sorted(expected))}")
    rules: list[tuple[str, float, int]] = []
    for name in sorted(expected):
        value = data[name]
        if not isinstance(value, dict) or "amount" not in value or "days" not in value:
            raise ConfigurationError(f"pricing rule {name} requires amount and days")
        amount, days = float(value["amount"]), int(value["days"])
        if amount <= 0 or days <= 0:
            raise ConfigurationError(f"pricing rule {name} values must be positive")
        rules.append((name, amount, days))
    return tuple(rules)
