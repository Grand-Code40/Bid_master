from urllib.parse import urlsplit

from .models import SourceSpec

SOURCES = {
    "fl": SourceSpec(
        "fl", "FL.ru", ("www.fl.ru", "fl.ru"),
        ("https://www.fl.ru/projects/category/inzhiniring/", "https://www.fl.ru/projects/category/3d-grafika/"),
        "https://www.fl.ru/account/registration/?providerType=1",
        "https://www.fl.ru/account/login/",
        True, "public_observed", ("list", "detail", "budget", "bids", "availability"),
    ),
    "freelance": SourceSpec("freelance", "Freelance.ru", ("freelance.ru", "www.freelance.ru")),
    "telegram": SourceSpec("telegram", "Telegram", ("t.me",)),
    "freelancer": SourceSpec("freelancer", "Freelancer.com", ("www.freelancer.com", "freelancer.com")),
    "kwork": SourceSpec("kwork", "Kwork", ("kwork.ru",), automated_access="restricted"),
}


def source_for_url(url: str) -> SourceSpec:
    try:
        parsed = urlsplit(url)
        valid = parsed.scheme == "https" and parsed.port in (None, 443) and not parsed.username and not parsed.password
    except ValueError:
        valid = False
    if valid:
        for source in SOURCES.values():
            if source.implemented and parsed.hostname in source.allowed_hosts:
                return source
    raise ValueError("Unsupported source URL")


def canonicalize_fl_url(url: str) -> str:
    import re
    from urllib.parse import parse_qs, urlencode, urlunsplit
    source = source_for_url(url)
    parsed = urlsplit(url)
    if source.id != "fl" or not re.fullmatch(r"/projects/(?:[0-9]+/[a-zA-Z0-9_-]+\.html|category/[a-z0-9/-]+/?)?", parsed.path):
        raise ValueError("Unsupported FL.ru page")
    query = parse_qs(parsed.query)
    kept = {}
    for key in ("page", "kind"):
        value = query.get(key, [""])[0]
        if value:
            if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= 10000:
                raise ValueError("Invalid listing query")
            kept[key] = value
    return urlunsplit(("https", "www.fl.ru", parsed.path, urlencode(kept), ""))

def canonical_listing_url(source_id: str, url: str, external_id: str | None = None) -> str:
    """Validate an observed project link, including sources without a native collector."""
    import re
    from urllib.parse import parse_qs, urlunsplit
    if source_id not in SOURCES or not isinstance(url, str) or len(url) > 2048 or any(ord(c) < 33 for c in url):
        raise ValueError("Unsupported listing URL")
    parsed = urlsplit(url)
    source = SOURCES[source_id]
    if (parsed.scheme != "https" or parsed.port not in (None, 443) or parsed.username or parsed.password
            or parsed.hostname not in source.allowed_hosts or "\\" in url or "%" in parsed.path):
        raise ValueError("Unsupported listing URL")
    path, identity, query = parsed.path.rstrip("/"), None, ""
    host = source.allowed_hosts[0]
    if source_id == "fl":
        match = re.fullmatch(r"/projects/([1-9][0-9]*)/[a-zA-Z0-9_-]+\.html", path)
        identity = match[1] if match else None
    elif source_id == "freelance":
        match = re.fullmatch(r"/task/view/([1-9][0-9]*)", path) or re.fullmatch(r"/projects/[a-zA-Z0-9_-]+-([1-9][0-9]*)\.html", path)
        identity = match[1] if match else None
    elif source_id == "telegram":
        match = re.fullmatch(r"/(?:s/)?([a-zA-Z][a-zA-Z0-9_]{3,63})/([1-9][0-9]*)", path)
        if match:
            identity = f"{match[1].lower()}/{match[2]}"
            path = "/" + identity
    elif source_id == "kwork":
        match = re.fullmatch(r"/projects/(?:view/)?([1-9][0-9]*)", path)
        identity = match[1] if match else None
        if path == "/projects":
            candidate = parse_qs(parsed.query).get("id", [""])[0]
            if re.fullmatch(r"[1-9][0-9]*", candidate):
                identity, query = candidate, "id=" + candidate
    elif source_id == "freelancer":
        if re.fullmatch(r"/projects/[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+(?:/details)?", path):
            if external_id is None or re.fullmatch(r"[1-9][0-9]*", external_id):
                return urlunsplit(("https", host, path, "", ""))
    if identity is None or (external_id is not None and identity != external_id):
        raise ValueError("Listing identity does not match URL")
    return urlunsplit(("https", host, path, query, ""))
