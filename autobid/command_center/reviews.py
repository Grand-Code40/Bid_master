from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
import secrets
import sqlite3
from urllib.parse import urlsplit, urlunsplit

from ..discovery.models import utcnow


class Conflict(RuntimeError):
    """The requested transition no longer matches the saved revision/state."""


class NotFound(LookupError):
    pass


def draft_text(item):
    title = str(item.get("title", "")).strip()[:240]
    formats = ", ".join(str(value) for value in item.get("requested_formats", ()))[:120]
    deliverable = f"Результат подготовим в формате {formats}." if formats else "Уточним нужный формат готового файла."
    return (
        f"Здравствуйте! Заинтересовал ваш проект «{title}».\n\n"
        f"{deliverable} Используем автоматизацию CAD-задач, чтобы сократить стоимость и время работы. "
        "Перед началом согласуем состав результата и способ его проверки.\n\n"
        "Пришлите, пожалуйста, исходные материалы, требования к точности и желаемый срок. "
        "После просмотра подтвердим возможность выполнения, окончательную стоимость и срок.\n\n"
        "CAIgraph"
    )


def checked_text(value, *, limit=8000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise ValueError("Invalid text")
    return value.strip()


def delivery_link(value, recipient):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("Invalid delivery URL")
    parsed, target = urlsplit(value), urlsplit(recipient)
    if (parsed.scheme != "https" or parsed.port not in (None, 443) or parsed.username or parsed.password
            or parsed.hostname != target.hostname or any(ord(c) < 33 for c in value)):
        raise ValueError("Delivery URL must use the recipient's site")
    return urlunsplit(("https", parsed.netloc, parsed.path, "", ""))


class ReviewStore:
    """Every transition uses a short SQLite write transaction; no remote I/O inside."""

    def __init__(self, path: Path, *, clock=utcnow):
        self.path, self.clock = Path(path), clock
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS reviews (
                    source_id TEXT NOT NULL, external_id TEXT NOT NULL, data TEXT NOT NULL,
                    PRIMARY KEY (source_id, external_id)
                );
                CREATE TABLE IF NOT EXISTS review_events (
                    id INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_state (id INTEGER PRIMARY KEY CHECK (id=1), last_seen TEXT);
            """)

    @contextmanager
    def _connection(self, *, write=False):
        connection = sqlite3.connect(self.path, timeout=10)
        try:
            if write:
                connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def public(row):
        return {key: value for key, value in row.items() if key != "claim_token"}

    @staticmethod
    def _get(connection, source_id, external_id):
        row = connection.execute("SELECT data FROM reviews WHERE source_id=? AND external_id=?",
                                 (source_id, external_id)).fetchone()
        if row is None:
            raise NotFound("review_not_found")
        return json.loads(row[0])

    def _write(self, connection, row, action):
        row["updated_at"] = self.clock().isoformat()
        connection.execute("INSERT OR REPLACE INTO reviews VALUES (?,?,?)",
                           (row["source_id"], row["external_id"], json.dumps(row, ensure_ascii=False)))
        connection.execute("INSERT INTO review_events (at,action,data) VALUES (?,?,?)",
                           (row["updated_at"], action, json.dumps(self.public(row), ensure_ascii=False)))
        return self.public(row)

    @staticmethod
    def _revision(row, revision):
        if type(revision) is not int or row["revision"] != revision:
            raise Conflict("stale_revision")

    def prepare(self, item):
        with self._connection(write=True) as connection:
            try:
                return self.public(self._get(connection, item["source_id"], item["external_id"]))
            except NotFound:
                row = dict(source_id=item["source_id"], external_id=item["external_id"],
                           canonical_url=item["canonical_url"], title=item["title"],
                           text=draft_text(item), revision=1, state="draft", approved_revision=None,
                           created_at=self.clock().isoformat(), claim_token=None, claimed_at=None,
                           evidence=None, delivery_url=None)
                return self._write(connection, row, "prepare")

    def get(self, source_id, external_id):
        with self._connection() as connection:
            return self.public(self._get(connection, source_id, external_id))

    def list(self):
        with self._connection() as connection:
            return [self.public(json.loads(row[0])) for row in connection.execute("SELECT data FROM reviews ORDER BY rowid")]

    def save(self, source_id, external_id, text, revision):
        text = checked_text(text)
        with self._connection(write=True) as connection:
            row = self._get(connection, source_id, external_id)
            self._revision(row, revision)
            if row["state"] not in ("draft", "approved"):
                raise Conflict("review_locked")
            if text == row["text"]:
                return self.public(row)
            row.update(text=text, revision=revision + 1, state="draft", approved_revision=None)
            return self._write(connection, row, "save")

    def approve(self, source_id, external_id, revision):
        with self._connection(write=True) as connection:
            row = self._get(connection, source_id, external_id)
            self._revision(row, revision)
            if row["state"] not in ("draft", "approved"):
                raise Conflict("review_locked")
            row.update(state="approved", approved_revision=revision)
            return self._write(connection, row, "approve")

    def queue(self, source_id, external_id, revision):
        with self._connection(write=True) as connection:
            row = self._get(connection, source_id, external_id)
            self._revision(row, revision)
            if row["state"] == "queued" and row["approved_revision"] == revision:
                return self.public(row)
            if row["state"] != "approved" or row["approved_revision"] != revision:
                raise Conflict("approval_required")
            row.update(state="queued")
            return self._write(connection, row, "queue")

    def cancel(self, source_id, external_id, revision):
        with self._connection(write=True) as connection:
            row = self._get(connection, source_id, external_id)
            self._revision(row, revision)
            if row["state"] not in ("queued", "approved"):
                raise Conflict("review_locked")
            row.update(state="draft", revision=revision + 1, approved_revision=None)
            return self._write(connection, row, "cancel")

    def claim(self, source_id=None):
        with self._connection(write=True) as connection:
            connection.execute("INSERT OR REPLACE INTO agent_state VALUES (1,?)", (self.clock().isoformat(),))
            for saved in connection.execute("SELECT data FROM reviews ORDER BY rowid").fetchall():
                row = json.loads(saved[0])
                if row["state"] != "queued" or (source_id and row["source_id"] != source_id):
                    continue
                if row["approved_revision"] != row["revision"]:
                    raise Conflict("approval_required")
                row.update(state="sending", claim_token=secrets.token_urlsafe(24), claimed_at=self.clock().isoformat())
                self._write(connection, row, "claim")
                return row
            return None

    def active(self):
        """Private recovery output for the local agent; never exposed in the web API."""
        with self._connection() as connection:
            return [item for (raw,) in connection.execute("SELECT data FROM reviews")
                    if (item := json.loads(raw))["state"] in ("sending", "uncertain")]

    def agent_status(self):
        with self._connection() as connection:
            row = connection.execute("SELECT last_seen FROM agent_state WHERE id=1").fetchone()
            return dict(last_seen=row[0] if row else None)

    def result(self, source_id, external_id, claim_token, outcome, evidence, delivery_url=None):
        if outcome not in ("sent", "not_sent", "uncertain"):
            raise ValueError("Invalid outcome")
        evidence = checked_text(evidence, limit=2000)
        if not isinstance(claim_token, str) or not claim_token.isascii():
            raise ValueError("Invalid claim token")
        with self._connection(write=True) as connection:
            row = self._get(connection, source_id, external_id)
            if not row.get("claim_token") or not secrets.compare_digest(claim_token, row["claim_token"]):
                raise Conflict("claim_mismatch")
            link = delivery_link(delivery_url, row["canonical_url"])
            if row["state"] == "sent" and outcome == "sent":
                return self.public(row)
            if row["state"] not in ("sending", "uncertain"):
                raise Conflict("review_locked")
            row.update(state={"sent": "sent", "not_sent": "draft", "uncertain": "uncertain"}[outcome],
                       evidence=evidence, delivery_url=link)
            if outcome == "not_sent":
                row.update(revision=row["revision"] + 1, approved_revision=None, claim_token=None, claimed_at=None)
            return self._write(connection, row, outcome)
