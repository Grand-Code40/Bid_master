from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from enum import StrEnum


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class SourceStatus(StrEnum):
    UNVERIFIED = "unverified"
    PUBLIC = "public"
    LOGIN_REQUIRED = "login_required"
    HUMAN_REQUIRED = "human_required"
    AUTHENTICATED = "authenticated"
    RESTRICTED = "restricted"
    ERROR = "error"


class ConnectionStep(StrEnum):
    NOT_STARTED = "not_started"
    FORM_READY = "form_ready"
    EMAIL_VERIFICATION = "email_verification"
    PHONE_VERIFICATION = "phone_verification"
    HUMAN_CHECK = "human_check"
    TERMS_CONFIRMATION = "terms_confirmation"
    AUTHENTICATED = "authenticated"
    ACCESS_VERIFIED = "access_verified"
    FAILED = "failed"


@dataclass(frozen=True)
class PublicProfile:
    display_name: str = "CAIgraph"
    email: str | None = field(default=None, repr=False)
    country: str | None = None
    city: str | None = None


@dataclass(frozen=True)
class SourceSpec:
    id: str
    name: str
    allowed_hosts: tuple[str, ...]
    listing_urls: tuple[str, ...] = ()
    registration_url: str | None = None
    login_url: str | None = None
    implemented: bool = False
    automated_access: str = "unverified"
    verified_capabilities: tuple[str, ...] = ()


@dataclass(frozen=True)
class Listing:
    source_id: str
    external_id: str
    canonical_url: str
    title: str = ""
    description: str = ""
    detail_complete: bool = False
    listing_kind: str = "unknown"
    cad_categories: tuple[str, ...] = ()
    budget_min: Decimal | None = None
    budget_max: Decimal | None = None
    currency: str | None = None
    budget_unit: str | None = None
    bids_count: int | None = None
    published_at: datetime | None = None
    raw_date: str | None = None
    availability: str = "unknown"
    requested_formats: tuple[str, ...] = ()
    explicit_constraints: tuple[str, ...] = ()


@dataclass(frozen=True)
class Observation:
    listing: Listing
    observed_at: datetime
    present_fields: frozenset[str]
    field_provenance: dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        if self.observed_at.tzinfo is None:
            raise ValueError("Observation time must include timezone")
        allowed = set(Listing.__dataclass_fields__) - {"source_id", "external_id", "canonical_url"}
        if not self.present_fields <= allowed:
            raise ValueError("Unknown observation field")


def listing_dict(listing: Listing) -> dict:
    data = asdict(listing)
    for key in ("budget_min", "budget_max"):
        if data[key] is not None:
            data[key] = str(data[key])
    if data["published_at"] is not None:
        data["published_at"] = data["published_at"].isoformat()
    return data


def listing_from_dict(data: dict) -> Listing:
    data = dict(data)
    for key in ("budget_min", "budget_max"):
        if data.get(key) is not None:
            data[key] = Decimal(data[key])
    if data.get("published_at") is not None:
        data["published_at"] = datetime.fromisoformat(data["published_at"])
    for key in ("cad_categories", "requested_formats", "explicit_constraints"):
        data[key] = tuple(data.get(key, ()))
    return Listing(**data)

