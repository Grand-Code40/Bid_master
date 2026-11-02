from __future__ import annotations

import argparse
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import sqlite3

from ..discovery.models import Listing, Observation, SourceStatus, listing_from_dict, utcnow
from ..discovery.registry import SOURCES, canonical_listing_url
from ..discovery.runtime import DEFAULT_ROOT, LockBusy, RunLock, RuntimePaths
from ..discovery.storage import DiscoveryDatabase
from .reviews import Conflict, NotFound, ReviewStore

IDENTITY = {"source_id", "external_id", "canonical_url"}
FIELDS = set(Listing.__dataclass_fields__) - IDENTITY


def parse_observation(data):
    if not isinstance(data, dict) or not set(data) <= IDENTITY | FIELDS | {"observed_at"}:
        raise ValueError("Unknown observation fields")
    if not IDENTITY | {"observed_at", "title"} <= set(data):
        raise ValueError("Identity, title and observed_at are required")
    item = {key: value for key, value in data.items() if key != "observed_at"}
    for key in ("source_id", "external_id"):
        if not isinstance(item[key], str) or not item[key] or len(item[key]) > 150:
            raise ValueError("Invalid listing identity")
    item["canonical_url"] = canonical_listing_url(item["source_id"], item["canonical_url"], item["external_id"])
    stamp = datetime.fromisoformat(data["observed_at"]) if isinstance(data["observed_at"], str) else None
    if stamp is None or stamp.tzinfo is None or stamp > utcnow() + timedelta(minutes=5):
        raise ValueError("Observed time must be a past timezone-aware timestamp")
    for key, limit in (("title", 500), ("description", 50000), ("raw_date", 200), ("currency", 8), ("budget_unit", 40)):
        if key in item and item[key] is not None:
            value = item[key]
            if not isinstance(value, str) or len(value) > limit or "\x00" in value:
                raise ValueError("Invalid text field")
    if not isinstance(item["title"], str) or not item["title"].strip():
        raise ValueError("Title is required")
    if item.get("description", "") is None:
        raise ValueError("Description must be text")
    for key in ("cad_categories", "requested_formats", "explicit_constraints"):
        if key in item and (not isinstance(item[key], list) or len(item[key]) > 40
                           or any(not isinstance(value, str) or len(value) > 500 for value in item[key])):
            raise ValueError("Invalid list field")
    for key in ("budget_min", "budget_max"):
        if item.get(key) is not None:
            value = item[key]
            if isinstance(value, bool) or not isinstance(value, (str, int, float)):
                raise ValueError("Invalid budget")
            try:
                amount = Decimal(str(value))
                if not amount.is_finite() or not 0 <= amount <= 1_000_000_000_000:
                    raise ValueError("Invalid budget")
            except InvalidOperation:
                raise ValueError("Invalid budget") from None
            item[key] = str(amount)
    if item.get("budget_min") is not None and item.get("budget_max") is not None:
        if Decimal(item["budget_min"]) > Decimal(item["budget_max"]):
            raise ValueError("Invalid budget range")
    if item.get("bids_count") is not None and (type(item["bids_count"]) is not int or not 0 <= item["bids_count"] <= 1_000_000):
        raise ValueError("Invalid bids count")
    if item.get("listing_kind", "unknown") not in ("order", "vacancy", "unknown"):
        raise ValueError("Invalid listing kind")
    if item.get("availability", "unknown") not in ("open", "closed", "unknown"):
        raise ValueError("Invalid availability")
    if "detail_complete" in item and type(item["detail_complete"]) is not bool:
        raise ValueError("Invalid detail flag")
    if item.get("published_at") is not None:
        published = datetime.fromisoformat(item["published_at"]) if isinstance(item["published_at"], str) else None
        if published is None or published.tzinfo is None or published > utcnow() + timedelta(minutes=5):
            raise ValueError("Invalid publication time")
    listing = listing_from_dict(item)
    present = frozenset(FIELDS & set(item))
    return Observation(listing, stamp, present, {field: item["canonical_url"] for field in present})


def ingest(paths, data):
    if not isinstance(data, list) or not 1 <= len(data) <= 200:
        raise ValueError("Expected 1 to 200 observed listings")
    # Validate the entire batch before touching durable data.
    observations = [parse_observation(item) for item in data]
    paths.prepare()
    counts = dict(new=0, updated=0, unchanged=0)
    with RunLock(paths.root), DiscoveryDatabase(paths.child("discovery.sqlite3")) as db:
        for observation in observations:
            counts[db.upsert(observation)] += 1
        for source in {item.listing.source_id for item in observations}:
            # Importing data does not prove an authenticated connection.
            db.set_source_state(source, SourceStatus.UNVERIFIED, "agent_observed")
    return counts


def read_file(path, *, limit=4_000_000):
    with Path(path).open("rb") as handle:
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("Input file is too large")
    return raw.decode("utf-8-sig")


def build_parser():
    parser = argparse.ArgumentParser(description="CAIgraph cloud-agent bridge; no automatic approval or remote sending")
    parser.add_argument("--data-root", type=Path, default=Path(os.environ.get("DISCOVERY_DATA_ROOT", str(DEFAULT_ROOT))))
    subs = parser.add_subparsers(dest="command", required=True)
    subs.add_parser("status")
    subs.add_parser("queue", help="Read queued, approved-for-dispatch replies")
    subs.add_parser("active", help="Recover sending/uncertain claims; inspect remote state before any action")
    imported = subs.add_parser("ingest")
    imported.add_argument("file", type=Path)
    draft = subs.add_parser("draft", help="Create/read a draft, or save a revised personalized reply")
    draft.add_argument("source_id", choices=tuple(SOURCES))
    draft.add_argument("external_id")
    draft.add_argument("--text-file", type=Path)
    draft.add_argument("--revision", type=int)
    claim = subs.add_parser("claim", help="Atomically take one queued reply before a remote send")
    claim.add_argument("--source", choices=tuple(SOURCES))
    result = subs.add_parser("result", help="Record a checked outcome; read evidence and claim token from a local JSON file")
    result.add_argument("file", type=Path)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        paths = RuntimePaths.from_root(args.data_root)
        if args.command == "ingest":
            output = ingest(paths, json.loads(read_file(args.file)))
        else:
            paths.prepare()
            store = ReviewStore(paths.child("command-center/reviews.sqlite3"))
            if args.command == "draft":
                with DiscoveryDatabase(paths.child("discovery.sqlite3")) as db:
                    record = next((row["data"] for row in db.listing_records()
                                   if row["source_id"] == args.source_id and row["external_id"] == args.external_id), None)
                if record is None:
                    raise NotFound("listing_not_found")
                if record["listing_kind"] != "order" or record["availability"] == "closed":
                    raise Conflict("listing_unavailable")
                record["canonical_url"] = canonical_listing_url(args.source_id, record["canonical_url"], args.external_id)
                output = store.prepare(record)
                if args.text_file:
                    output = store.save(args.source_id, args.external_id, read_file(args.text_file, limit=40000), args.revision)
            elif args.command == "queue":
                output = [row for row in store.list() if row["state"] == "queued"]
            elif args.command == "active":
                output = store.active()
            elif args.command == "claim":
                output = store.claim(args.source)
            elif args.command == "result":
                data = json.loads(read_file(args.file, limit=20000))
                required = {"source_id", "external_id", "claim_token", "outcome", "evidence"}
                if not isinstance(data, dict) or not required <= set(data) or not set(data) <= required | {"delivery_url"}:
                    raise ValueError("Invalid outcome record")
                output = store.result(**data)
            else:
                output = dict(agent=store.agent_status(), counts={state: sum(row["state"] == state for row in store.list())
                              for state in ("draft", "approved", "queued", "sending", "sent", "uncertain")})
        print(json.dumps(output, ensure_ascii=False))
        return 0
    except (ValueError, TypeError, Conflict, NotFound, LockBusy, OSError, sqlite3.Error) as exc:
        # Do not echo raw input, credentials or transport details to logs.
        print(json.dumps(dict(error=type(exc).__name__, message="Check input, revision, data root and saved state.")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
