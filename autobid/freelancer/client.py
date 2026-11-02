from __future__ import annotations

from dataclasses import asdict, is_dataclass
from types import SimpleNamespace
from typing import Any, Protocol

from autobid.models import Account, BidIntent, Project


class FreelancerAPIError(RuntimeError):
    pass


class APIFormatError(FreelancerAPIError):
    pass


class AuthError(FreelancerAPIError):
    pass


class RateLimitError(FreelancerAPIError):
    pass


class EligibilityError(FreelancerAPIError):
    pass


class PolicyError(FreelancerAPIError):
    pass


class TemporaryAPIError(FreelancerAPIError):
    pass


class AmbiguousBidError(FreelancerAPIError):
    """The bid POST outcome is unknown and must be reconciled, never retried blindly."""


class FreelancerClient(Protocol):
    account: Account

    def get_current_user(self) -> dict[str, Any]: ...
    def search_projects(self, query: str, limit: int) -> list[Project]: ...
    def get_project(self, project_id: int) -> Project: ...
    def find_existing_bid(self, project_id: int) -> dict[str, Any] | None: ...
    def place_bid(self, intent: BidIntent) -> dict[str, Any]: ...


def _official_sdk() -> SimpleNamespace:
    try:
        from freelancersdk.resources.projects.projects import (
            get_bids,
            get_project_by_id,
            place_project_bid,
            search_projects,
        )
        from freelancersdk.resources.projects.helpers import create_get_projects_project_details_object
        from freelancersdk.resources.users.helpers import create_get_users_details_object
        from freelancersdk.resources.users.users import get_self
        from freelancersdk.session import Session
    except ImportError as exc:
        raise RuntimeError("Install the freelancersdk package to use the production client") from exc
    return SimpleNamespace(
        session_factory=Session,
        get_self=get_self,
        user_details_factory=create_get_users_details_object,
        search_projects=search_projects,
        get_project_by_id=get_project_by_id,
        get_bids=get_bids,
        place_project_bid=place_project_bid,
        project_details_factory=create_get_projects_project_details_object,
    )


def _message(exc: Exception) -> tuple[str, str]:
    code = str(getattr(exc, "error_code", "") or "").upper()
    message = str(getattr(exc, "message", "") or exc)
    return code, message


def _translate(exc: Exception, *, bid_post: bool = False) -> FreelancerAPIError:
    code, message = _message(exc)
    combined = f"{code} {message}".upper()
    class_name = exc.__class__.__name__.upper()
    if "UNAUTHORIZED" in combined or "AUTH" in combined or "TOKEN" in combined:
        return AuthError(message)
    if "429" in combined or "TOO_MANY" in combined or "RATE_LIMIT" in combined:
        return RateLimitError(message)
    if any(term in combined for term in ("ELIGIB", "QUALIF", "BID_RESTRICT")):
        return EligibilityError(message)
    if any(term in combined for term in ("POLICY", "ACCOUNT_RESTRICT", "INSUFFICIENT_BALANCE", "PAYMENT")):
        return PolicyError(message)
    if any(term in combined or term in class_name for term in ("TIMEOUT", "CONNECTION", "NETWORK")):
        return AmbiguousBidError(message) if bid_post else TemporaryAPIError(message)
    return FreelancerAPIError(message)


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if is_dataclass(value):
        return asdict(value)
    data = getattr(value, "_data", None)
    if isinstance(data, dict):
        return dict(data)
    result: dict[str, Any] = {}
    for name in ("id", "project_id", "bidder_id", "amount", "period"):
        if hasattr(value, name):
            result[name] = getattr(value, name)
    return result


class SdkFreelancerClient:
    def __init__(self, account: Account, *, base_url: str | None = None, sdk: Any | None = None) -> None:
        self.account = account
        self.base_url = (base_url or "https://www.freelancer.com").rstrip("/")
        self._sdk = sdk or _official_sdk()
        session_kwargs = {"oauth_token": account.token}
        if base_url:
            session_kwargs["url"] = base_url
        self._session = self._sdk.session_factory(**session_kwargs)

    def _call(self, function, *args, bid_post: bool = False, **kwargs):
        try:
            return function(*args, **kwargs)
        except FreelancerAPIError:
            raise
        except Exception as exc:
            raise _translate(exc, bid_post=bid_post) from exc

    def get_current_user(self) -> dict[str, Any]:
        details_factory = getattr(self._sdk, "user_details_factory", None)
        details = details_factory(basic=True, reputation=True) if details_factory else None
        result = self._call(self._sdk.get_self, self._session, details) if details else self._call(self._sdk.get_self, self._session)
        if not isinstance(result, dict) or "id" not in result:
            raise APIFormatError("current user response is missing id")
        return result

    def search_projects(self, query: str, limit: int) -> list[Project]:
        from .projects import normalize_project

        details_factory = getattr(self._sdk, "project_details_factory", None)
        details = (
            details_factory(full_description=True, jobs=True)
            if details_factory
            else {"full_description": True, "job_details": True}
        )
        result = self._call(
            self._sdk.search_projects,
            self._session,
            query=query,
            limit=limit,
            active_only=True,
            project_details=details,
        )
        raw_projects = result.get("projects", []) if isinstance(result, dict) else result
        if not isinstance(raw_projects, list):
            raise APIFormatError("project search response has no projects list")
        return [normalize_project(item, self.base_url) for item in raw_projects]

    def get_project(self, project_id: int) -> Project:
        from .projects import normalize_project

        details_factory = getattr(self._sdk, "project_details_factory", None)
        details = details_factory(full_description=True, jobs=True) if details_factory else {"full_description": True, "job_details": True}
        result = self._call(self._sdk.get_project_by_id, self._session, project_id, project_details=details)
        if isinstance(result, dict) and "project" in result:
            result = result["project"]
        return normalize_project(result, self.base_url)

    def find_existing_bid(self, project_id: int) -> dict[str, Any] | None:
        result = self._call(self._sdk.get_bids, self._session, project_ids=[project_id], limit=100)
        bids = result.get("bids", []) if isinstance(result, dict) else result
        if not isinstance(bids, list):
            raise APIFormatError("bids response has no bids list")
        for bid in bids:
            mapped = _mapping(bid)
            if int(mapped.get("project_id", project_id)) == project_id and int(mapped.get("bidder_id", -1)) == self.account.account_id:
                return mapped
        return None

    def place_bid(self, intent: BidIntent) -> dict[str, Any]:
        if intent.account_id != self.account.account_id:
            raise EligibilityError("bid intent account does not match authenticated account")
        result = self._call(
            self._sdk.place_project_bid,
            self._session,
            project_id=intent.project_id,
            bidder_id=intent.account_id,
            description=intent.proposal,
            amount=intent.amount,
            period=intent.delivery_days,
            milestone_percentage=100,
            bid_post=True,
        )
        mapped = _mapping(result)
        if not mapped:
            raise APIFormatError("placed bid response is empty")
        return mapped
