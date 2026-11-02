from types import SimpleNamespace

import pytest

from autobid.freelancer.bidding import safe_place_bid
from autobid.freelancer.client import (
    APIFormatError,
    AmbiguousBidError,
    AuthError,
    RateLimitError,
    SdkFreelancerClient,
)
from autobid.freelancer.projects import normalize_project
from autobid.models import Account, BidIntent


def payload(project_id=101):
    return {
        "id": project_id,
        "title": "PDF to DXF",
        "description": "Trace exact dimensions",
        "status": "active",
        "budget": {"minimum": 50, "maximum": 100},
        "currency": {"code": "USD"},
        "jobs": [{"name": "AutoCAD"}, {"name": "CAD/CAM"}],
        "seo_url": "pdf-to-dxf",
        "time_submitted": 1_700_000_000,
        "owner_id": 55,
    }


def account():
    return Account(7, "cad", "secret")


def test_project_payload_is_normalized_without_optional_fields():
    data = payload()
    data.pop("jobs")
    data.pop("currency")

    item = normalize_project(data, "https://www.freelancer.com")

    assert item.project_id == 101
    assert item.skills == ()
    assert item.currency_code == "USD"
    assert item.url == "https://www.freelancer.com/projects/pdf-to-dxf"


def test_missing_required_project_fields_raise_format_error():
    with pytest.raises(APIFormatError, match="project id"):
        normalize_project({"title": "missing id"}, "https://www.freelancer.com")


class SdkFailure(Exception):
    def __init__(self, error_code, message):
        super().__init__(message)
        self.error_code = error_code
        self.message = message


def sdk_with(**overrides):
    defaults = {
        "session_factory": lambda **_kwargs: object(),
        "get_self": lambda *_args, **_kwargs: {"id": 7, "username": "cad"},
        "search_projects": lambda *_args, **_kwargs: {"projects": [payload()]},
        "get_project_by_id": lambda *_args, **_kwargs: payload(),
        "get_bids": lambda *_args, **_kwargs: {"bids": []},
        "place_project_bid": lambda *_args, **_kwargs: SimpleNamespace(id=999, project_id=101, bidder_id=7),
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_sdk_adapter_maps_auth_and_rate_limit_errors():
    auth_sdk = sdk_with(get_self=lambda *_a, **_k: (_ for _ in ()).throw(SdkFailure("UNAUTHORIZED", "bad token")))
    limited_sdk = sdk_with(search_projects=lambda *_a, **_k: (_ for _ in ()).throw(SdkFailure("TOO_MANY_REQUESTS", "429")))

    with pytest.raises(AuthError):
        SdkFreelancerClient(account(), sdk=auth_sdk).get_current_user()
    with pytest.raises(RateLimitError):
        SdkFreelancerClient(account(), sdk=limited_sdk).search_projects("DXF", 10)


def test_search_requests_full_description_and_job_details():
    captured = {}

    def search_projects(*_args, **kwargs):
        captured.update(kwargs)
        return {"projects": [payload()]}

    client = SdkFreelancerClient(account(), sdk=sdk_with(search_projects=search_projects))

    client.search_projects("DXF", 10)

    assert captured["project_details"] == {"full_description": True, "job_details": True}


def test_adapter_detects_existing_bid_for_account():
    sdk = sdk_with(get_bids=lambda *_a, **_k: {"bids": [{"id": 77, "project_id": 101, "bidder_id": 7}]})
    client = SdkFreelancerClient(account(), sdk=sdk)

    existing = client.find_existing_bid(101)

    assert existing["id"] == 77


def test_timeout_is_reconciled_without_second_place_attempt():
    calls = {"place": 0, "bids": 0}

    class Client:
        def find_existing_bid(self, _project_id):
            calls["bids"] += 1
            return {"id": 88} if calls["bids"] > 1 else None

        def place_bid(self, _intent):
            calls["place"] += 1
            raise AmbiguousBidError("timeout")

    intent = BidIntent(101, 7, 75, 2, "Exact scale and closed contours.")

    result = safe_place_bid(Client(), intent)

    assert result == {"id": 88, "reconciled": True}
    assert calls == {"place": 1, "bids": 2}


def test_unresolved_timeout_never_blindly_retries():
    calls = 0

    class Client:
        def find_existing_bid(self, _project_id):
            return None

        def place_bid(self, _intent):
            nonlocal calls
            calls += 1
            raise AmbiguousBidError("timeout")

    with pytest.raises(AmbiguousBidError):
        safe_place_bid(Client(), BidIntent(101, 7, 75, 2, "Exact scale and closed contours."))
    assert calls == 1
