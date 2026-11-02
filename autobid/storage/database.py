from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from autobid.models import Account, BidStatus, Project, ScoreResult

from .migrations import SCHEMA


def _utc_iso(value: datetime | None = None) -> str:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc).isoformat()


class Database:
    """Small DB-API repository supporting SQLite locally and PostgreSQL in CI."""

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self._postgres = database_url.startswith(("postgres://", "postgresql://"))
        if self._postgres:
            try:
                import psycopg
                from psycopg.rows import dict_row
            except ImportError as exc:
                raise RuntimeError("PostgreSQL DATABASE_URL requires psycopg") from exc
            self._connection = psycopg.connect(database_url, row_factory=dict_row)
        elif database_url.startswith("sqlite:///"):
            path = database_url.removeprefix("sqlite:///")
            if path != ":memory:":
                Path(path).parent.mkdir(parents=True, exist_ok=True)
            self._connection = sqlite3.connect(path, timeout=30, check_same_thread=False)
            self._connection.row_factory = sqlite3.Row
            self._connection.execute("PRAGMA foreign_keys=ON")
            self._connection.execute("PRAGMA busy_timeout=30000")
        else:
            raise ValueError("DATABASE_URL must use postgresql:// or sqlite:///")

    def close(self) -> None:
        self._connection.close()

    def _sql(self, statement: str) -> str:
        return statement.replace("?", "%s") if self._postgres else statement

    def _execute(self, statement: str, params: tuple[Any, ...] = ()):
        return self._connection.execute(self._sql(statement), params)

    def _transaction(self):
        # Psycopg 3 closes a Connection used directly as a context manager.
        # Its explicit transaction context commits/rolls back without closing it.
        return self._connection.transaction() if self._postgres else self._connection

    def migrate(self) -> None:
        with self._transaction():
            for statement in SCHEMA:
                self._execute(statement)

    def start_run(self, run_id: str, started_at: datetime | None = None) -> None:
        with self._transaction():
            self._execute(
                "INSERT INTO runs(run_id, started_at, status) VALUES(?, ?, ?) ON CONFLICT(run_id) DO NOTHING",
                (run_id, _utc_iso(started_at), "RUNNING"),
            )

    def finish_run(self, run_id: str, status: str, report: dict[str, Any]) -> None:
        with self._transaction():
            self._execute(
                "UPDATE runs SET finished_at=?, status=?, report_json=? WHERE run_id=?",
                (_utc_iso(), status, json.dumps(report, sort_keys=True), run_id),
            )

    def reserve_project(self, project: Project, run_id: str) -> bool:
        description_hash = hashlib.sha256(project.description.encode("utf-8")).hexdigest()
        with self._transaction():
            cursor = self._execute(
                """
                INSERT INTO projects(project_id, title, description_hash, url, created_at, first_seen_at, run_id)
                VALUES(?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id) DO NOTHING
                """,
                (
                    project.project_id,
                    project.title,
                    description_hash,
                    project.url,
                    _utc_iso(project.created_at) if project.created_at else None,
                    _utc_iso(),
                    run_id,
                ),
            )
            return cursor.rowcount == 1

    def project_exists(self, project_id: int) -> bool:
        return self._execute("SELECT 1 FROM projects WHERE project_id=?", (project_id,)).fetchone() is not None

    def save_decision(
        self,
        *,
        project_id: int,
        run_id: str,
        score: ScoreResult,
        selected_account: int | None = None,
        amount: float | None = None,
        delivery_days: int | None = None,
        proposal: str | None = None,
        error: str | None = None,
    ) -> None:
        with self._transaction():
            self._execute(
                """
                INSERT INTO decisions(project_id, run_id, score, decision, reasons_json, selected_account,
                    bid_amount, delivery_days, proposal, created_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    score=excluded.score, decision=excluded.decision, reasons_json=excluded.reasons_json,
                    selected_account=excluded.selected_account, bid_amount=excluded.bid_amount,
                    delivery_days=excluded.delivery_days, proposal=excluded.proposal
                """,
                (
                    project_id, run_id, score.score, score.decision.value, json.dumps(score.reasons),
                    selected_account, amount, delivery_days, proposal, _utc_iso(),
                ),
            )
            self._execute(
                """
                UPDATE projects SET score=?, decision=?, selected_account=?, bid_amount=?, delivery_days=?,
                    proposal=?, error=? WHERE project_id=?
                """,
                (score.score, score.decision.value, selected_account, amount, delivery_days, proposal, error, project_id),
            )

    def get_project_record(self, project_id: int) -> dict[str, Any] | None:
        row = self._execute("SELECT * FROM projects WHERE project_id=?", (project_id,)).fetchone()
        return dict(row) if row is not None else None

    def record_bid(
        self,
        project_id: int,
        run_id: str,
        account_id: int,
        status: BidStatus,
        amount: float,
        delivery_days: int,
        proposal: str,
        api_result: dict[str, Any] | None,
        error: str | None = None,
        *,
        created_at: datetime | None = None,
    ) -> bool:
        encoded_result = json.dumps(api_result or {}, sort_keys=True, default=str)
        timestamp = _utc_iso(created_at)
        with self._transaction():
            cursor = self._execute(
                """
                INSERT INTO bids(project_id, run_id, account_id, status, amount, delivery_days, proposal,
                    api_result, error, created_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id) DO NOTHING
                """,
                (project_id, run_id, account_id, status.value, amount, delivery_days, proposal, encoded_result, error, timestamp),
            )
            if cursor.rowcount != 1:
                return False
            self._execute(
                "UPDATE projects SET api_result=?, error=? WHERE project_id=?",
                (encoded_result, error, project_id),
            )
            if status is BidStatus.SENT:
                self._execute(
                    "UPDATE accounts SET bids_used=bids_used+1, last_bid_at=?, success_count=success_count+1 WHERE account_id=?",
                    (timestamp, account_id),
                )
            elif status is BidStatus.FAILED:
                self._execute(
                    "UPDATE accounts SET failure_count=failure_count+1 WHERE account_id=?",
                    (account_id,),
                )
            return True

    def upsert_account(self, account: Account) -> None:
        with self._transaction():
            self._execute(
                """
                INSERT INTO accounts(account_id, username, enabled, bids_used, bids_remaining, last_bid_at,
                    success_count, failure_count, profile_tags_json, rating)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_id) DO UPDATE SET
                    username=excluded.username, enabled=excluded.enabled,
                    bids_remaining=excluded.bids_remaining, profile_tags_json=excluded.profile_tags_json,
                    rating=excluded.rating
                """,
                (
                    account.account_id, account.username, int(account.enabled), account.bids_used,
                    account.bids_remaining, _utc_iso(account.last_bid_at) if account.last_bid_at else None,
                    account.success_count, account.failure_count, json.dumps(account.profile_tags), account.rating,
                ),
            )

    def count_sent_bids(self, *, since: datetime | None = None, account_id: int | None = None) -> int:
        clauses = ["status=?"]
        params: list[Any] = [BidStatus.SENT.value]
        if since is not None:
            clauses.append("created_at>=?")
            params.append(_utc_iso(since))
        if account_id is not None:
            clauses.append("account_id=?")
            params.append(account_id)
        row = self._execute(f"SELECT COUNT(*) AS total FROM bids WHERE {' AND '.join(clauses)}", tuple(params)).fetchone()
        return int(row["total"])

    def last_bid_at(self, account_id: int) -> datetime | None:
        row = self._execute(
            "SELECT MAX(created_at) AS last_bid_at FROM bids WHERE account_id=? AND status=?",
            (account_id, BidStatus.SENT.value),
        ).fetchone()
        value = row["last_bid_at"] if row else None
        return datetime.fromisoformat(value) if value else None
