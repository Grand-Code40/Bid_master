from __future__ import annotations

import argparse
from dataclasses import replace

from autobid.config import ConfigurationError, Settings
from autobid.freelancer.client import SdkFreelancerClient
from autobid.reporting.notifier import NullNotifier, TelegramNotifier
from autobid.reporting.report import report_markdown
from autobid.service import AutoBidService
from autobid.storage.database import Database


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Finite-run Freelancer AutoBid")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("run", help="Run using AUTOBID_ENABLED and DRY_RUN from the environment")
    subparsers.add_parser("scan", help="Force a safe dry-run scan regardless of live-bid settings")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        settings = Settings.from_env()
        if args.command == "scan":
            settings = replace(settings, autobid_enabled=False, dry_run=True)
        if not settings.accounts:
            raise ConfigurationError("FREELANCER_ACCOUNTS_JSON must contain at least one account")
        database = Database(settings.database_url)
        notifier = (
            TelegramNotifier(settings.telegram_bot_token, settings.telegram_chat_id)
            if settings.telegram_bot_token and settings.telegram_chat_id
            else NullNotifier()
        )
        service = AutoBidService(
            settings,
            database,
            lambda account: SdkFreelancerClient(account, base_url=settings.freelancer_url),
            notifier=notifier,
        )
        report = service.run()
        print(report_markdown(report))
        return 2 if report.emergency_stop else 0
    except ConfigurationError as exc:
        print(f"Configuration error: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
