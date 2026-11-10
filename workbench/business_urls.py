from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit


def public_business_url(value: str, *, embedded: bool) -> str:
    """Return a Django path under the DSH same-origin alias when embedding is enabled."""
    if not embedded or not isinstance(value, str) or not value.startswith("/") or value.startswith("//"):
        return value

    parts = urlsplit(value)
    path = parts.path
    if any(path == alias or path.startswith(alias + "/") for alias in ("/business", "/business-api", "/business-static", "/business-media")):
        return value
    mappings = (
        ("/api/", "/business-api/"),
        ("/static/", "/business-static/"),
        ("/uploads/", "/business-media/"),
    )
    for internal, public in mappings:
        if path == internal[:-1]:
            path = public[:-1]
            break
        if path.startswith(internal):
            path = public + path[len(internal) :]
            break
    else:
        path = "/business" + path
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))


def public_url(value: str) -> str:
    from django.conf import settings

    return public_business_url(value, embedded=bool(getattr(settings, "TRADELOOM_DSH_EMBED", False)))
