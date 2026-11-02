from __future__ import annotations

import json
from typing import Protocol
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class Notifier(Protocol):
    def notify(self, event: str, message: str) -> None: ...


class NullNotifier:
    def notify(self, event: str, message: str) -> None:
        return None


class TelegramNotifier:
    def __init__(self, bot_token: str, chat_id: str, *, opener=urlopen, timeout: float = 15.0) -> None:
        self._url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        self._chat_id = chat_id
        self._opener = opener
        self._timeout = timeout

    def notify(self, event: str, message: str) -> None:
        payload = urlencode({"chat_id": self._chat_id, "text": f"[{event}] {message}"}).encode("utf-8")
        request = Request(self._url, data=payload, method="POST")
        with self._opener(request, timeout=self._timeout) as response:
            response.read()


class SafeNotifier:
    """Notification failures are collected but never abort state persistence."""

    def __init__(self, delegate: Notifier) -> None:
        self.delegate = delegate
        self.errors: list[str] = []

    def notify(self, event: str, message: str) -> None:
        try:
            self.delegate.notify(event, message)
        except Exception as exc:
            self.errors.append(f"{event}: {exc.__class__.__name__}")

