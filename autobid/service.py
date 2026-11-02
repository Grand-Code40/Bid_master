from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Callable

from autobid.config import Settings
from autobid.freelancer.accounts import AccountRouter
from autobid.freelancer.bidding import safe_place_bid
from autobid.freelancer.client import (
    AmbiguousBidError,
    AuthError,
    EligibilityError,
    FreelancerClient,
    FreelancerAPIError,
    PolicyError,
    RateLimitError,
)
from autobid.intelligence.engine import HybridIntelligence, IntelligenceError
from autobid.intelligence.llm import LLMResponseError, OpenAICompatibleLLM
from autobid.intelligence.pricing import PricingError
from autobid.intelligence.proposal import ProposalError
from autobid.models import BidIntent, BidStatus, Decision, Project, RunReport, ScoreResult
from autobid.reporting.notifier import Notifier, NullNotifier, SafeNotifier
from autobid.reporting.report import ReportWriter, report_dict
from autobid.storage.database import Database


class AutoBidService:
    def __init__(
        self,
        settings: Settings,
        database: Database,
        client_factory: Callable,
        *,
        intelligence: HybridIntelligence | None = None,
        notifier: Notifier | None = None,
        reporter: ReportWriter | None = None,
    ) -> None:
        self.settings = settings
        self.database = database
        self.client_factory = client_factory
        self.intelligence = intelligence or HybridIntelligence(settings, self._build_llm())
        self.notifier = SafeNotifier(notifier or NullNotifier())
        self.reporter = reporter or ReportWriter(settings.report_dir)

    def _build_llm(self):
        values = (self.settings.llm_base_url, self.settings.llm_api_key, self.settings.llm_model)
        if all(values):
            return OpenAICompatibleLLM(*values, max_retries=self.settings.llm_max_retries)
        if any(values):
            raise IntelligenceError("LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL must be configured together")
        return None

    def _skip(self, report: RunReport, project: Project, reason: str, score: ScoreResult | None = None) -> None:
        result = score or ScoreResult(0, Decision.SKIP, (reason,))
        self.database.save_decision(project_id=project.project_id, run_id=report.run_id, score=result, error=reason)
        report.skipped += 1
        report.events.append({"kind": "SKIPPED", "project": project.title, "score": result.score, "reason": reason, "url": project.url})

    def _limit_reason(self, report: RunReport) -> str | None:
        now = datetime.now(timezone.utc)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        month_start = day_start.replace(day=1)
        if report.bids_sent >= self.settings.max_bids_per_run:
            return "global per-run bid limit reached"
        if self.database.count_sent_bids(since=day_start) >= self.settings.max_bids_per_day:
            return "global daily bid limit reached"
        if self.database.count_sent_bids(since=month_start) >= self.settings.max_bids_per_month:
            return "global monthly bid limit reached"
        return None

    def run(self) -> RunReport:
        report = RunReport(run_id=str(uuid.uuid4()))
        self.database.migrate()
        self.database.start_run(report.run_id, report.started_at)
        circuit_open = self.settings.emergency_stop
        report.emergency_stop = circuit_open
        clients: dict[int, FreelancerClient] = {}
        scanner: FreelancerClient | None = None

        for account in self.settings.accounts:
            if not account.enabled:
                continue
            client = self.client_factory(account)
            clients[account.account_id] = client
            try:
                user = client.get_current_user()
                if int(user["id"]) != account.account_id:
                    raise AuthError("configured account_id does not match OAuth identity")
                scanner = scanner or client
            except AuthError as exc:
                circuit_open = report.emergency_stop = True
                report.errors.append(f"authentication failed for account {account.account_id}: {exc}")
                self.notifier.notify("authentication_error", f"Account {account.account_id} authentication failed")

        projects: list[Project] = []
        if scanner is None:
            report.errors.append("no authenticated enabled Freelancer account is available for scanning")
            circuit_open = report.emergency_stop = True
        else:
            try:
                projects = scanner.search_projects(self.settings.search_query, self.settings.search_limit)
            except (AuthError, RateLimitError) as exc:
                circuit_open = report.emergency_stop = True
                report.errors.append(f"project scan failed: {exc.__class__.__name__}")

        router = AccountRouter(self.database, self.settings.max_bids_per_account_per_day)
        sequential_failures = 0
        rate_limit_errors = 0

        for project in projects:
            report.projects_scanned += 1
            if not self.database.reserve_project(project, report.run_id):
                report.skipped += 1
                report.events.append({"kind": "SKIPPED", "project": project.title, "reason": "already processed", "url": project.url})
                continue
            report.new_projects += 1
            try:
                refreshed = scanner.get_project(project.project_id)
                if refreshed.project_id != project.project_id:
                    raise ValueError("project detail response id mismatch")
                project = refreshed
            except (FreelancerAPIError, ValueError) as exc:
                circuit_open = report.emergency_stop = True
                self._skip(report, project, f"project detail refresh failed: {exc.__class__.__name__}")
                continue
            if not project.accepts_bids:
                self._skip(report, project, "project is closed or not accepting bids")
                continue
            if not project.description.strip():
                self._skip(report, project, "empty project description")
                continue
            try:
                evaluated = self.intelligence.evaluate(project)
            except (IntelligenceError, LLMResponseError, PricingError, ProposalError, ValueError) as exc:
                self._skip(report, project, f"intelligence rejected project: {exc.__class__.__name__}")
                continue
            if evaluated.score.score >= self.settings.review_score:
                report.relevant += 1
            if evaluated.score.decision is not Decision.AUTO_BID:
                self._skip(report, project, "score below auto-bid threshold", evaluated.score)
                continue
            if circuit_open:
                self._skip(report, project, "emergency stop active", evaluated.score)
                continue
            limit_reason = self._limit_reason(report)
            if limit_reason:
                self._skip(report, project, limit_reason, evaluated.score)
                continue
            try:
                remote_owner = next(
                    (
                        account_id
                        for account_id, client in clients.items()
                        if client.find_existing_bid(project.project_id) is not None
                    ),
                    None,
                )
            except (AuthError, PolicyError, RateLimitError) as exc:
                circuit_open = report.emergency_stop = True
                self._skip(report, project, f"remote duplicate check failed: {exc.__class__.__name__}", evaluated.score)
                continue
            except FreelancerAPIError as exc:
                self._skip(report, project, f"remote duplicate check failed: {exc.__class__.__name__}", evaluated.score)
                continue
            if remote_owner is not None:
                self.database.save_decision(
                    project_id=project.project_id,
                    run_id=report.run_id,
                    score=evaluated.score,
                    selected_account=remote_owner,
                    amount=evaluated.price.amount,
                    delivery_days=evaluated.price.delivery_days,
                    proposal=evaluated.proposal,
                    error="existing remote bid in account pool",
                )
                report.skipped += 1
                report.events.append({
                    "kind": "SKIPPED", "project": project.title, "score": evaluated.score.score,
                    "reason": "existing remote bid in account pool", "account_id": remote_owner, "url": project.url,
                })
                continue
            selected = router.select(project, tuple(account for account in self.settings.accounts if account.account_id in clients))
            if selected is None:
                self._skip(report, project, "no enabled account with bid quota", evaluated.score)
                continue
            intent = BidIntent(project.project_id, selected.account_id, evaluated.price.amount, evaluated.price.delivery_days, evaluated.proposal)
            self.database.save_decision(
                project_id=project.project_id,
                run_id=report.run_id,
                score=evaluated.score,
                selected_account=selected.account_id,
                amount=evaluated.price.amount,
                delivery_days=evaluated.price.delivery_days,
                proposal=evaluated.proposal,
            )
            if not self.settings.live_bidding:
                self.database.record_bid(
                    project.project_id, report.run_id, selected.account_id, BidStatus.INTENDED,
                    intent.amount, intent.delivery_days, intent.proposal, {"dry_run": True},
                )
                report.intended_bids += 1
                report.events.append({
                    "kind": "INTENDED BID", "project": project.title, "score": evaluated.score.score,
                    "account": selected.username, "amount": intent.amount, "delivery_days": intent.delivery_days, "url": project.url,
                })
                continue
            client = clients[selected.account_id]
            try:
                result = safe_place_bid(client, intent)
                if result.get("existing"):
                    self.database.record_bid(
                        project.project_id, report.run_id, selected.account_id, BidStatus.SENT,
                        intent.amount, intent.delivery_days, intent.proposal, result,
                    )
                    report.skipped += 1
                    report.events.append({"kind": "SKIPPED", "project": project.title, "reason": "existing remote bid", "url": project.url})
                    continue
                self.database.record_bid(
                    project.project_id, report.run_id, selected.account_id, BidStatus.SENT,
                    intent.amount, intent.delivery_days, intent.proposal, result,
                )
                report.bids_sent += 1
                sequential_failures = 0
                event = {
                    "kind": "BID SENT", "project": project.title, "score": evaluated.score.score,
                    "account": selected.username, "amount": intent.amount, "delivery_days": intent.delivery_days, "url": project.url,
                }
                report.events.append(event)
                self.notifier.notify("bid_sent", f"{project.title}: {intent.amount} {project.currency_code}, {intent.delivery_days} days")
            except EligibilityError as exc:
                self.database.record_bid(project.project_id, report.run_id, selected.account_id, BidStatus.FAILED, intent.amount, intent.delivery_days, intent.proposal, None, str(exc))
                report.skipped += 1
            except RateLimitError as exc:
                rate_limit_errors += 1
                sequential_failures += 1
                self.database.record_bid(project.project_id, report.run_id, selected.account_id, BidStatus.FAILED, intent.amount, intent.delivery_days, intent.proposal, None, str(exc))
                report.skipped += 1
                if rate_limit_errors >= self.settings.max_rate_limit_errors:
                    circuit_open = report.emergency_stop = True
            except (AuthError, PolicyError, AmbiguousBidError) as exc:
                status = BidStatus.UNKNOWN if isinstance(exc, AmbiguousBidError) else BidStatus.FAILED
                self.database.record_bid(project.project_id, report.run_id, selected.account_id, status, intent.amount, intent.delivery_days, intent.proposal, None, str(exc))
                report.skipped += 1
                circuit_open = report.emergency_stop = True
            except Exception as exc:
                sequential_failures += 1
                self.database.record_bid(project.project_id, report.run_id, selected.account_id, BidStatus.FAILED, intent.amount, intent.delivery_days, intent.proposal, None, exc.__class__.__name__)
                report.skipped += 1
                if sequential_failures >= self.settings.max_sequential_bid_failures:
                    circuit_open = report.emergency_stop = True

        if report.emergency_stop:
            self.notifier.notify("emergency_stop", f"Run {report.run_id} stopped automatic bidding; scanning completed")
        report.finished_at = datetime.now(timezone.utc)
        report.errors.extend(self.notifier.errors)
        status = "EMERGENCY_STOP" if report.emergency_stop else "COMPLETED"
        self.database.finish_run(report.run_id, status, report_dict(report))
        self.reporter.write(report)
        self.notifier.notify(
            "run_summary",
            f"scanned={report.projects_scanned}, new={report.new_projects}, sent={report.bids_sent}, intended={report.intended_bids}, skipped={report.skipped}",
        )
        return report
