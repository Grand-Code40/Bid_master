from __future__ import annotations

import json
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class LLMResponseError(RuntimeError):
    pass


class OpenAICompatibleLLM:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        max_retries: int = 2,
        timeout: float = 30.0,
        opener: Callable[..., Any] = urlopen,
    ) -> None:
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._api_key = api_key
        self._model = model
        self._max_retries = max_retries
        self._timeout = timeout
        self._opener = opener

    def complete_json(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any]:
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": "Return only JSON matching the supplied schema. Never invent project facts."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_schema", "json_schema": {"name": "autobid_response", "strict": True, "schema": schema}},
        }
        request = Request(
            self._url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        last_error: Exception | None = None
        invalid_response = False
        for attempt in range(self._max_retries + 1):
            try:
                with self._opener(request, timeout=self._timeout) as response:
                    body = json.loads(response.read().decode("utf-8"))
                content = body["choices"][0]["message"]["content"]
                result = json.loads(content)
                if not isinstance(result, dict):
                    raise ValueError("JSON root is not an object")
                missing = [key for key in schema.get("required", []) if key not in result]
                if missing:
                    raise ValueError(f"missing required fields: {missing}")
                return result
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                last_error = exc
                invalid_response = True
                if attempt < self._max_retries:
                    time.sleep(min(2**attempt, 4))
            except (HTTPError, URLError, TimeoutError) as exc:
                last_error = exc
                if attempt < self._max_retries:
                    time.sleep(min(2**attempt, 4))
        if invalid_response:
            raise LLMResponseError("LLM did not return valid JSON matching the schema after bounded retries") from last_error
        raise LLMResponseError("LLM request failed after bounded retries") from last_error
