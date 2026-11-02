from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any


class Decision(StrEnum):
    AUTO_BID = "AUTO_BID"
    REVIEW = "REVIEW"
    SKIP = "SKIP"


class BidStatus(StrEnum):
    INTENDED = "INTENDED"
    RESERVED = "RESERVED"
    SENT = "SENT"
    FAILED = "FAILED"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True, slots=True)
class Project:
    project_id: int
    title: str
    description: str
    url: str
    status: str
    budget_min: float | None
    budget_max: float | None
    currency_code: str = "USD"
    skills: tuple[str, ...] = ()
    created_at: datetime | None = None
    owner_id: int | None = None
    bid_stats: dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> str:
        return f"{self.title}\n{self.description}\n{' '.join(self.skills)}".lower()

    @property
    def accepts_bids(self) -> bool:
        return self.status.upper() in {"ACTIVE", "OPEN", "PENDING"}


@dataclass(frozen=True, slots=True)
class ScoreResult:
    score: int
    decision: Decision
    reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class PriceResult:
    amount: float
    delivery_days: int
    category: str
    rationale: str


@dataclass(frozen=True, slots=True)
class Account:
    account_id: int
    username: str
    token: str = field(repr=False)
    enabled: bool = True
    profile_tags: tuple[str, ...] = ()
    bids_used: int = 0
    bids_remaining: int | None = None
    last_bid_at: datetime | None = None
    success_count: int = 0
    failure_count: int = 0
    rating: float | None = None

    @property
    def success_rate(self) -> float:
        total = self.success_count + self.failure_count
        return self.success_count / total if total else 0.0


@dataclass(frozen=True, slots=True)
class BidIntent:
    project_id: int
    account_id: int
    amount: float
    delivery_days: int
    proposal: str


@dataclass(slots=True)
class RunReport:
    run_id: str
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None
    projects_scanned: int = 0
    new_projects: int = 0
    relevant: int = 0
    bids_sent: int = 0
    intended_bids: int = 0
    skipped: int = 0
    emergency_stop: bool = False
    events: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

