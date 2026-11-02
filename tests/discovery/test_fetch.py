from urllib.error import HTTPError, URLError
import pytest
from autobid.discovery.fetch import HttpFetcher, SafeRedirectHandler

URL = "https://www.fl.ru/projects/"


def test_retries_are_bounded_and_errors_do_not_leak_credentials():
    calls = []
    def failing(request, **kwargs):
        calls.append(request.full_url)
        raise URLError("secret-token-from-provider")
    result = HttpFetcher(open_url=failing, sleep=lambda _: None, attempts=2).fetch(URL)
    assert len(calls) == 2
    assert result.access_state == "error"
    assert result.error_code == "network_error"
    assert "secret-token" not in repr(result)


def test_rate_limit_stops_after_bounded_retry():
    def failing(request, **kwargs):
        raise HTTPError(URL, 429, "Too many", {"Retry-After": "999999"}, None)
    sleeps = []
    result = HttpFetcher(open_url=failing, sleep=sleeps.append, attempts=2).fetch(URL)
    assert result.error_code == "rate_limited"
    assert len(sleeps) == 1 and 0 <= sleeps[0] <= 10


def test_rejects_cross_host_redirect_before_sending_request():
    from urllib.request import Request
    with pytest.raises(ValueError):
        SafeRedirectHandler().redirect_request(Request(URL), None, 302, "", {}, "https://attacker.test/collect")


def test_maximum_response_size_stops_reading():
    from io import BytesIO
    class Response(BytesIO):
        status = 200
        headers = {}
        def geturl(self):
            return URL
    result = HttpFetcher(open_url=lambda *a, **kw: Response(b"x" * 100), max_bytes=20).fetch(URL)
    assert result.error_code == "response_too_large"
    assert result.html is None

