"""Exercise the live isolated enterprise server with disposable QA accounts."""
from __future__ import annotations

import http.cookiejar
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


BASE = "http://127.0.0.1:27419"
ACCOUNT_FILE = Path(__file__).resolve().parents[1] / "testing" / "enterprise-accounts.json"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect())


def get(opener, path):
    try:
        with opener.open(BASE + path) as response:
            return response.status, response.headers, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read().decode()


def post(opener, path, values):
    request = urllib.request.Request(
        BASE + path,
        data=urllib.parse.urlencode(values).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with opener.open(request) as response:
            return response.status, response.headers, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read().decode()


def csrf(html):
    return re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', html).group(1)


def login(account):
    opener = client()
    status, _, page = get(opener, "/accounts/login/")
    assert status == 200, ("login_page", status)
    status, headers, _ = post(opener, "/accounts/login/", {
        "username": account["username"],
        "password": account["password"],
        "csrfmiddlewaretoken": csrf(page),
        "next": "/enterprise/",
    })
    assert status == 302 and headers.get("Location", "").endswith("/enterprise/"), ("login", status)
    return opener


def main():
    accounts = json.loads(ACCOUNT_FILE.read_text(encoding="utf-8"))["accounts"]
    status, _, health = get(client(), "/api/health")
    assert status == 200 and json.loads(health) == {"status": "ok", "database": "postgresql", "database_ok": True}, health
    status, headers, _ = get(client(), "/enterprise/")
    assert status == 302 and "/accounts/login/" in headers.get("Location", ""), (status, headers.get("Location"))

    registrar = login(accounts["registrar"])
    _, _, registrar_page = get(registrar, "/enterprise/")
    registrar_value = "http-registrar-private"
    status, _, _ = post(registrar, "/enterprise/entries", {
        "csrfmiddlewaretoken": csrf(registrar_page),
        "task_id": json.loads(ACCOUNT_FILE.read_text(encoding="utf-8"))["task_id"],
        "body": registrar_value,
    })
    assert status == 302, ("registrar_write", status)
    _, _, registrar_page = get(registrar, "/enterprise/")
    assert registrar_value in registrar_page, "registrar cannot read own entry"

    registrar2 = login(accounts["registrar2"])
    _, _, registrar2_page = get(registrar2, "/enterprise/")
    assert registrar_value not in registrar2_page, "other registrar can read private entry"
    assert registrar2_value_absent(registrar2)

    owner = login(accounts["owner"])
    _, _, owner_page = get(owner, "/enterprise/")
    assert "企业服务 QA 合成业务批次" in owner_page and "企业服务 QA 合成产品" in owner_page
    assert registrar_value in owner_page, "owner cannot read registrar entry"
    owner_value = "http-owner-write"
    status, _, _ = post(owner, "/enterprise/entries", {
        "csrfmiddlewaretoken": csrf(owner_page),
        "task_id": json.loads(ACCOUNT_FILE.read_text(encoding="utf-8"))["task_id"],
        "body": owner_value,
    })
    assert status == 302, ("owner_write", status)
    _, _, owner_page = get(owner, "/enterprise/")
    assert owner_value in owner_page

    admin = login(accounts["admin"])
    assert get(admin, "/admin/auth/user/")[0] == 200
    assert get(admin, "/admin/auth/group/")[0] == 200

    status, headers, page = get(registrar, "/accounts/logout/")
    assert status == 405, ("logout_requires_post", status)
    status, _, page = get(registrar, "/enterprise/")
    token = csrf(page)
    status, _, _ = post(registrar, "/accounts/logout/", {"csrfmiddlewaretoken": token})
    assert status == 302, ("logout", status)
    status, _, _ = get(registrar, "/enterprise/")
    assert status == 302, ("session_after_logout", status)
    print("PASS health=PostgreSQL; anonymous_redirect; registrar_write/private_read; owner_business_read/write; admin_users_groups; POST_logout/session_expiry")


def registrar2_value_absent(opener):
    status, _, page = get(opener, "/enterprise/")
    return status == 200 and "qa-fixture:registrar-private" not in page


if __name__ == "__main__":
    main()
