from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from bs4 import BeautifulSoup
from .models import SourceStatus, utcnow
from .registry import canonicalize_fl_url


@dataclass(frozen=True)
class FetchResult:
    url: str
    status_code: int | None
    html: str | None = field(repr=False)
    access_state: SourceStatus
    observed_at: datetime
    error_code: str | None = None


class Fetcher(Protocol):
    def fetch(self, url: str) -> FetchResult: ...


def classify_page(url: str, status: int, html: str, observed_at: datetime | None = None) -> FetchResult:
    stamp = observed_at or utcnow()
    soup = BeautifulSoup(html, "html.parser")
    # Authentication and challenge forms are never returned to callers.
    public = bool(soup.select('[id^="project-item"] a[id^="prj_name_"], h1[id^="prj_name_"]'))
    for node in soup(["script", "style", "noscript"]):
        node.decompose()
    text = soup.get_text(" ", strip=True).lower()
    if status != 200:
        state, code = (SourceStatus.RESTRICTED, "rate_limited" if status == 429 else "http_restricted") if status in (401, 403, 429) else (SourceStatus.ERROR, "http_error")
    elif not public and (soup.select('iframe[src*="captcha"], .g-recaptcha, .smart-captcha') or re.search(r"не робот|verify you are human|just a moment|проверка браузера", text)):
        state, code = SourceStatus.HUMAN_REQUIRED, "human_check"
    elif not public and soup.select('input[type="password"]'):
        state, code = SourceStatus.LOGIN_REQUIRED, "login_required"
    elif not public and re.search(r"соглашаюсь с условиями|consent required", text):
        state, code = SourceStatus.HUMAN_REQUIRED, "consent_required"
    elif not public:
        state, code = SourceStatus.ERROR, "unexpected_structure"
    else:
        state, code = SourceStatus.PUBLIC, None
    if state != SourceStatus.PUBLIC:
        return FetchResult(url, status, None, state, stamp, code)
    # Only project sections and pagination leave transport. Remove account chrome,
    # forms, scripts and external attachment links from the retained HTML.
    keep = soup.select('[id^="project-item"]')
    if keep:
        html = "".join(str(node) for node in keep)
        pagination = soup.select_one(".fl-pagination, #fl-pagination")
        if pagination:
            html += str(pagination)
    else:
        title = soup.select_one('h1[id^="prj_name_"]')
        project_id = title["id"].removeprefix("prj_name_")
        info = soup.select_one(f"#project_info_{project_id}")
        budget_label = soup.find(string=re.compile(r"^\s*Бюджет:"))
        budget = budget_label.parent if budget_label else None
        html = str(title) + (str(budget) if budget else "") + (str(info) if info else "")
    clean = BeautifulSoup(html, "html.parser")
    for node in clean.select("script, style, input, textarea, form, iframe, noindex"):
        node.decompose()
    for node in clean.find_all(True):
        for key in list(node.attrs):
            if key.lower().startswith("on") or key in ("value", "data-ga-event"):
                del node.attrs[key]
    return FetchResult(url, status, str(clean), state, stamp)


class SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        from urllib.parse import urlsplit
        from .registry import source_for_url
        source_for_url(newurl)  # Reject credentials, foreign hosts and schemes before request.
        if urlsplit(newurl).path.startswith("/account/"):
            raise PermissionError("login_required")
        canonicalize_fl_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class HttpFetcher:
    def __init__(self, *, timeout: float = 20, attempts: int = 2, max_bytes: int = 4_000_000, open_url=None, sleep=time.sleep):
        if not 1 <= attempts <= 3 or not 1 <= timeout <= 60 or max_bytes < 1:
            raise ValueError("Invalid transport limits")
        self.timeout, self.attempts, self.max_bytes = timeout, attempts, max_bytes
        self.open_url = open_url or build_opener(SafeRedirectHandler()).open
        self.sleep = sleep

    def fetch(self, url: str) -> FetchResult:
        url = canonicalize_fl_url(url)
        code, status, state = "network_error", None, SourceStatus.ERROR
        for attempt in range(self.attempts):
            try:
                request = Request(url, headers={"User-Agent": "CAIgraphDiscovery/0.1 (public CAD listings)", "Accept": "text/html"})
                with self.open_url(request, timeout=self.timeout) as response:
                    status = response.status
                    body = response.read(self.max_bytes + 1)
                    if len(body) > self.max_bytes:
                        return FetchResult(url, status, None, SourceStatus.ERROR, utcnow(), "response_too_large")
                    content_type = response.headers.get("Content-Type", "text/html")
                    if "text/html" not in content_type:
                        return FetchResult(url, status, None, SourceStatus.ERROR, utcnow(), "unsupported_content")
                    match = re.search(r"charset=([\w-]+)", content_type)
                    encoding = match.group(1) if match else "utf-8"
                    return classify_page(url, status, body.decode(encoding, errors="replace"))
            except HTTPError as exc:
                status = exc.code
                code = "rate_limited" if status == 429 else "http_error"
                state = SourceStatus.RESTRICTED if status in (401, 403, 429) else SourceStatus.ERROR
                if status not in (429, 500, 502, 503, 504):
                    break
            except PermissionError:
                return FetchResult(url, None, None, SourceStatus.LOGIN_REQUIRED, utcnow(), "login_required")
            except ValueError:
                return FetchResult(url, None, None, SourceStatus.RESTRICTED, utcnow(), "redirect_not_allowed")
            except (URLError, OSError, LookupError):
                code = "network_error"
            if attempt + 1 < self.attempts:
                self.sleep(min(2 ** attempt, 10))
        return FetchResult(url, status, None, state, utcnow(), code)

