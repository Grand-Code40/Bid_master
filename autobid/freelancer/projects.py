from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from autobid.models import Project

from .client import APIFormatError, FreelancerClient


def normalize_project(payload: Any, base_url: str) -> Project:
    if not isinstance(payload, dict):
        raise APIFormatError("project payload must be an object")
    project_id = payload.get("id") or payload.get("project_id")
    if project_id is None:
        raise APIFormatError("project id is missing")
    title = str(payload.get("title") or "").strip()
    description = str(payload.get("description") or "").strip()
    budget = payload.get("budget") if isinstance(payload.get("budget"), dict) else {}
    currency = payload.get("currency") if isinstance(payload.get("currency"), dict) else {}
    jobs = payload.get("jobs") if isinstance(payload.get("jobs"), list) else []
    skills = tuple(
        str(job.get("name") or job.get("seo_url") or "").strip()
        for job in jobs
        if isinstance(job, dict) and (job.get("name") or job.get("seo_url"))
    )
    seo_url = str(payload.get("seo_url") or project_id).strip("/")
    raw_created = payload.get("time_submitted") or payload.get("submitdate")
    created_at = None
    if isinstance(raw_created, (int, float)):
        created_at = datetime.fromtimestamp(raw_created, tz=timezone.utc)
    return Project(
        project_id=int(project_id),
        title=title,
        description=description,
        url=f"{base_url.rstrip('/')}/projects/{seo_url}",
        status=str(payload.get("status") or "UNKNOWN").upper(),
        budget_min=float(budget["minimum"]) if budget.get("minimum") is not None else None,
        budget_max=float(budget["maximum"]) if budget.get("maximum") is not None else None,
        currency_code=str(currency.get("code") or "USD"),
        skills=skills,
        created_at=created_at,
        owner_id=int(payload["owner_id"]) if payload.get("owner_id") is not None else None,
        bid_stats=payload.get("bid_stats") if isinstance(payload.get("bid_stats"), dict) else {},
    )


def fetch_fresh_projects(client: FreelancerClient, query: str, limit: int) -> list[Project]:
    return client.search_projects(query, limit)

