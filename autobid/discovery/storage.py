from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .models import ConnectionStep, Observation, SourceStatus, listing_dict, listing_from_dict, utcnow


class DiscoveryDatabase:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.migrate()

    def migrate(self):
        self.connection.executescript("""
            CREATE TABLE IF NOT EXISTS listings (
                source_id TEXT NOT NULL, external_id TEXT NOT NULL,
                data TEXT NOT NULL, field_times TEXT NOT NULL, provenance TEXT NOT NULL,
                first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
                PRIMARY KEY (source_id, external_id)
            );
            CREATE TABLE IF NOT EXISTS observations (
                id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
                observed_at TEXT NOT NULL, data TEXT NOT NULL, present_fields TEXT NOT NULL,
                provenance TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sources (
                source_id TEXT PRIMARY KEY, state TEXT NOT NULL, code TEXT NOT NULL,
                checked_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS connections (
                source_id TEXT PRIMARY KEY, step TEXT NOT NULL, checked_at TEXT NOT NULL
            );
        """)
        columns = {row[1] for row in self.connection.execute("PRAGMA table_info(sources)")}
        if "last_success" not in columns:
            self.connection.execute("ALTER TABLE sources ADD COLUMN last_success TEXT")
            self.connection.commit()

    def upsert(self, observation: Observation) -> str:
        item = observation.listing
        incoming = listing_dict(item)
        stamp = observation.observed_at.astimezone(timezone.utc).isoformat()
        key = (item.source_id, item.external_id)
        with self.connection:
            old = self.connection.execute("SELECT * FROM listings WHERE source_id=? AND external_id=?", key).fetchone()
            data = json.loads(old["data"]) if old else incoming.copy()
            times = json.loads(old["field_times"]) if old else {}
            provenance = json.loads(old["provenance"]) if old else {}
            changed = False
            preserve_detail = data.get("detail_complete", False) and not incoming.get("detail_complete", False)
            for name in observation.present_fields:
                if preserve_detail and name in ("description", "detail_complete", "requested_formats", "explicit_constraints", "cad_categories", "raw_date"):
                    continue
                if name not in times or stamp >= times[name]:
                    changed |= data.get(name) != incoming[name]
                    data[name] = incoming[name]
                    times[name] = stamp
                    provenance[name] = observation.field_provenance.get(name, item.canonical_url)
            first = min(old["first_seen"], stamp) if old else stamp
            last = max(old["last_seen"], stamp) if old else stamp
            self.connection.execute(
                "INSERT OR REPLACE INTO listings VALUES (?,?,?,?,?,?,?)",
                (*key, json.dumps(data, ensure_ascii=False), json.dumps(times), json.dumps(provenance), first, last),
            )
            self.connection.execute(
                "INSERT INTO observations (source_id,external_id,observed_at,data,present_fields,provenance) VALUES (?,?,?,?,?,?)",
                (*key, stamp, json.dumps(incoming, ensure_ascii=False), json.dumps(sorted(observation.present_fields)), json.dumps(observation.field_provenance)),
            )
        return "new" if old is None else "updated" if changed else "unchanged"

    def list_listings(self, source_id: str | None = None):
        query = "SELECT data FROM listings"
        rows = self.connection.execute(query + " ORDER BY source_id,external_id") if source_id is None else self.connection.execute(query + " WHERE source_id=? ORDER BY external_id", (source_id,))
        return [listing_from_dict(json.loads(row["data"])) for row in rows]

    def listing_records(self):
        return [dict(row) | {"data": json.loads(row["data"]), "provenance": json.loads(row["provenance"])} for row in self.connection.execute("SELECT source_id,external_id,data,provenance,first_seen,last_seen FROM listings ORDER BY last_seen DESC")]

    def observation_count(self) -> int:
        return self.connection.execute("SELECT COUNT(*) FROM observations").fetchone()[0]

    def set_source_state(self, source_id: str, state: SourceStatus | str, code: str):
        state = SourceStatus(state)
        # Only machine codes, never raw transport exception text or authenticated URLs.
        if not code or len(code) > 64 or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789_" for c in code):
            raise ValueError("Source result requires a machine code")
        with self.connection:
            stamp = utcnow().isoformat()
            previous = self.source_states().get(source_id, {})
            last_success = stamp if state in (SourceStatus.PUBLIC, SourceStatus.AUTHENTICATED) else previous.get("last_success")
            self.connection.execute("INSERT OR REPLACE INTO sources (source_id,state,code,checked_at,last_success) VALUES (?,?,?,?,?)", (source_id, state.value, code, stamp, last_success))

    def source_states(self):
        return {row["source_id"]: dict(row) for row in self.connection.execute("SELECT * FROM sources")}

    def save_connection_step(self, source_id: str, step: ConnectionStep):
        step = ConnectionStep(step)
        with self.connection:
            self.connection.execute("INSERT OR REPLACE INTO connections VALUES (?,?,?)", (source_id, step.value, utcnow().isoformat()))

    def get_connection_step(self, source_id: str) -> ConnectionStep:
        row = self.connection.execute("SELECT step FROM connections WHERE source_id=?", (source_id,)).fetchone()
        return ConnectionStep(row["step"]) if row else ConnectionStep.NOT_STARTED

    def close(self):
        self.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

