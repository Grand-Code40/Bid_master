from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit

from bs4 import BeautifulSoup
from .fetch import FetchResult, classify_page
from .models import ConnectionStep, PublicProfile, SourceSpec, SourceStatus, utcnow
from .registry import canonicalize_fl_url


def connection_step(html: str) -> ConnectionStep:
    soup = BeautifulSoup(html, "html.parser")
    for node in soup(["script", "style"]):
        node.decompose()
    text = soup.get_text(" ", strip=True).lower()
    for link in soup.find_all("a", href=True):
        parsed = urlsplit(link["href"])
        if (not parsed.netloc or parsed.hostname in ("fl.ru", "www.fl.ru")) and parsed.path in ("/account/logout/", "/exit.php") and "выйти" in link.get_text().lower():
            return ConnectionStep.AUTHENTICATED
    if soup.select('iframe[src*="captcha"], .g-recaptcha, .smart-captcha') or "не робот" in text:
        return ConnectionStep.HUMAN_CHECK
    if re.search(r"код из sms|код из смс|подтвердите.*телефон", text):
        return ConnectionStep.PHONE_VERIFICATION
    if re.search(r"подтвердите.*почт|письмо.*подтвержд|verify.*email", text):
        return ConnectionStep.EMAIL_VERIFICATION
    if "пользовательского соглашения" in text and "соглашаюсь" in text:
        return ConnectionStep.TERMS_CONFIRMATION
    if soup.select('input[type="password"]'):
        return ConnectionStep.FORM_READY
    return ConnectionStep.NOT_STARTED


class BrowserSession:
    """Dedicated profile; never reads the owner's normal browser profile."""

    def __init__(self, profile_dir: Path, *, headless: bool = True, channel: str | None = None):
        self.profile_dir, self.headless, self.channel = profile_dir, headless, channel
        self._driver = self._context = self._page = None

    def __enter__(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise RuntimeError("Install the browser extra first") from None
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self._driver = sync_playwright().start()
        try:
            self._context = self._driver.chromium.launch_persistent_context(
                str(self.profile_dir), headless=self.headless, channel=self.channel,
                accept_downloads=False, timeout=30_000,
            )
            self._page = self._context.pages[0] if self._context.pages else self._context.new_page()
            self._page.set_default_timeout(20_000)
            return self
        except Exception:
            self.close()
            raise RuntimeError("Browser startup failed; install Chromium under the data root or use --browser-channel msedge") from None

    def fetch(self, url: str) -> FetchResult:
        url = canonicalize_fl_url(url)
        try:
            response = self._page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            # Navigation may have led to login; classify without emitting raw HTML.
            return classify_page(url, response.status if response else 0, self._page.content())
        except Exception:
            return FetchResult(url, None, None, SourceStatus.ERROR, utcnow(), "browser_error")

    def connect(self, source: SourceSpec, public_profile: PublicProfile, *, register: bool = False) -> ConnectionStep:
        if source.id != "fl":
            raise ValueError("Connection adapter not verified for this source")
        target = source.registration_url if register else source.login_url
        self._page.goto(target, wait_until="domcontentloaded")
        # This exact field was observed in the FL.ru registration form.
        email = self._page.get_by_placeholder("Укажите e-mail" if register else "Логин или e-mail", exact=True)
        if public_profile.email and email.count() == 1 and email.is_visible():
            email.fill(public_profile.email)
        return self.check_connection()

    def check_connection(self) -> ConnectionStep:
        if urlsplit(self._page.url).hostname not in ("fl.ru", "www.fl.ru"):
            return ConnectionStep.FAILED
        return connection_step(self._page.content())

    def close(self):
        try:
            if self._context:
                self._context.close()
        finally:
            if self._driver:
                self._driver.stop()
            self._context = self._driver = self._page = None

    def __exit__(self, *exc):
        self.close()

