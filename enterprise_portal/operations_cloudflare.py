"""One operator-configured Cloudflare Zone; never exposes raw provider responses."""
import ipaddress
import http.client
import json
import re
import ssl
from urllib import error, request
from django.views.decorators.debug import sensitive_variables

from .operations_ai import NoRedirect
from .operations_store import StoreUnavailable

STATES = {"active", "pending", "initializing", "moved", "deleted", "deactivated"}


class ProviderUnavailable(Exception):
    pass


class TargetChanged(Exception):
    pass


def domain_name(value):
    if not isinstance(value, str) or value != value.strip():
        raise ValueError("Invalid domain")
    value = value.removesuffix(".").encode("idna").decode("ascii").lower()
    if len(value) > 253 or "." not in value or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in value.split(".")):
        raise ValueError("Invalid domain")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ValueError("IP literals are not zones")


def path_url(path, domain):
    # A deliberately small canonical path grammar: no query, encoding, slash or dot ambiguity.
    if (not isinstance(path, str) or len(path) > 2048 or not path.startswith("/")
            or "//" in path or not re.fullmatch(r"/[A-Za-z0-9_./~-]*", path)
            or any(segment in (".", "..") for segment in path.split("/"))):
        raise ValueError("Invalid single public path")
    return "https://" + domain + path


@sensitive_variables()
def _call(zone, token, files=None):
    endpoint = "https://api.cloudflare.com/client/v4/zones/" + zone
    if files is not None:
        endpoint += "/purge_cache"
    req = request.Request(endpoint, method="GET" if files is None else "POST",
                          data=None if files is None else json.dumps({"files": files}).encode(),
                          headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    opener = request.build_opener(NoRedirect(), request.HTTPSHandler(context=ssl.create_default_context()))
    try:
        with opener.open(req, timeout=8) as response:
            if response.getcode() != 200 or response.geturl() != endpoint:
                raise ProviderUnavailable()
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ProviderUnavailable()
        payload = json.loads(raw)
        if not isinstance(payload, dict) or payload.get("success") is not True or not isinstance(payload.get("result"), dict):
            raise ProviderUnavailable()
        return payload["result"]
    except (OSError, error.URLError, http.client.HTTPException, ValueError, TypeError) as exc:
        raise ProviderUnavailable() from exc


def _configured(store):
    metadata = store.metadata()
    return all(metadata.get(slot, {}).get("configured") is True for slot in ("cloudflare_zone_id", "cloudflare_api_token"))


@sensitive_variables()
def _target(store):
    zone = store._read_for_provider("cloudflare_zone_id")
    token = store._read_for_provider("cloudflare_api_token")
    if not isinstance(zone, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", zone):
        raise ProviderUnavailable()
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,16384}", token):
        raise ProviderUnavailable()
    return zone.lower(), token


@sensitive_variables()
def _verified(zone, token):
    result = _call(zone, token)
    if result.get("id") != zone or not isinstance(result.get("status"), str) or result.get("status") not in STATES:
        raise ProviderUnavailable()
    try:
        return domain_name(result.get("name")), result["status"]
    except (ValueError, UnicodeError) as exc:
        raise ProviderUnavailable() from exc


@sensitive_variables()
def inspect(store, can_purge=False):
    empty = {"domain": None, "zone_status": None, "can_purge": False}
    if not _configured(store):
        return {**empty, "status": "not_configured", "detail": "请由企业老板配置 Cloudflare Token 和 Zone ID。"}
    zone, token = _target(store)
    domain, state = _verified(zone, token)
    return {"status": "ready", "domain": domain, "zone_status": state,
            "can_purge": bool(can_purge and state == "active"), "detail": "已核实配置的 Cloudflare 站点。"}


@sensitive_variables()
def purge(store, data):
    if not isinstance(data, dict) or set(data) != {"path", "expected_domain", "confirm"} or data["confirm"] is not True:
        raise ValueError("Explicit confirmation required")
    expected = domain_name(data["expected_domain"])
    if expected != data["expected_domain"]:
        raise ValueError("Use the verified domain")
    path_url(data["path"], expected)
    if not _configured(store):
        raise StoreUnavailable()
    zone, token = _target(store)
    domain, state = _verified(zone, token)
    if expected != domain or state != "active":
        raise TargetChanged()
    url = path_url(data["path"], domain)
    _call(zone, token, [url])
    return {"status": "ready", "domain": domain, "zone_status": state, "can_purge": True,
            "detail": "Cloudflare 已接受该页面的缓存清理请求。", "purged": True, "url": url}
