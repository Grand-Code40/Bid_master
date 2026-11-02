from __future__ import annotations

from datetime import datetime, timedelta, timezone

from autobid.models import Account, Project
from autobid.storage.database import Database


class AccountRouter:
    def __init__(self, database: Database, per_account_daily_limit: int) -> None:
        self.database = database
        self.per_account_daily_limit = per_account_daily_limit

    def select(self, project: Project, accounts: tuple[Account, ...]) -> Account | None:
        today = datetime.now(timezone.utc) - timedelta(days=1)
        eligible: list[Account] = []
        for account in accounts:
            self.database.upsert_account(account)
            if not account.enabled or account.bids_remaining == 0:
                continue
            if self.database.count_sent_bids(since=today, account_id=account.account_id) >= self.per_account_daily_limit:
                continue
            eligible.append(account)
        if not eligible:
            return None

        project_tokens = set(project.text.replace("/", " ").replace("-", " ").split())

        def rank(account: Account):
            overlap = len(project_tokens.intersection(account.profile_tags))
            history = account.success_rate
            rating = account.rating or 0.0
            last_bid = self.database.last_bid_at(account.account_id)
            # Strong profile affinity wins. Otherwise least recently used implements durable round-robin.
            recency = last_bid.timestamp() if last_bid else 0.0
            return (-overlap, -history, -rating, recency, account.account_id)

        return min(eligible, key=rank)
