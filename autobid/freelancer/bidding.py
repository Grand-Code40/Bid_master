from __future__ import annotations

from typing import Any, Protocol

from autobid.models import BidIntent

from .client import AmbiguousBidError


class BiddingClient(Protocol):
    def find_existing_bid(self, project_id: int) -> dict[str, Any] | None: ...
    def place_bid(self, intent: BidIntent) -> dict[str, Any]: ...


def safe_place_bid(client: BiddingClient, intent: BidIntent) -> dict[str, Any]:
    existing = client.find_existing_bid(intent.project_id)
    if existing is not None:
        return {**existing, "existing": True}
    try:
        return client.place_bid(intent)
    except AmbiguousBidError:
        reconciled = client.find_existing_bid(intent.project_id)
        if reconciled is not None:
            return {**reconciled, "reconciled": True}
        raise
