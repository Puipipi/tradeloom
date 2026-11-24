"""Synthetic Cloudflare transport and request tests; no provider egress or credentials."""
import io
import json
import unittest
from unittest.mock import Mock, patch

from . import tests_operations as base_tests  # bootstraps standalone synthetic Django settings
from . import operations, operations_cloudflare as cf, operations_views
from .operations_store import CredentialStore

ZONE = "a" * 32
TOKEN = "synthetic-token"
DOMAIN = "example.invalid"


def store():
    result = Mock()
    result.metadata.return_value = {s: {"configured": True} for s in operations.SLOTS}
    result._read_for_provider.side_effect = lambda slot: {"cloudflare_zone_id": ZONE, "cloudflare_api_token": TOKEN}[slot]
    return result


def provider(payload, status=200, url=None):
    response = io.BytesIO(json.dumps(payload).encode())
    response.getcode = lambda: status
    response.geturl = lambda: url or "https://api.cloudflare.com/client/v4/zones/" + ZONE
    return response


def zone_payload(**kwargs):
    return {"success": True, "result": {"id": ZONE, "name": DOMAIN, "status": "active", "account": {"secret": "never-return"}, **kwargs}}


class TransportTests(unittest.TestCase):
    def test_exact_get_post_and_filtered_status(self):
        opener = Mock()
        endpoint = "https://api.cloudflare.com/client/v4/zones/" + ZONE
        opener.open.side_effect = [provider(zone_payload(name="EXAMPLE.INVALID.")), provider(zone_payload()),
                                   provider({"success": True, "result": {"id": "ignored"}}, url=endpoint + "/purge_cache")]
        with patch.object(cf.request, "build_opener", return_value=opener):
            self.assertEqual(cf.inspect(store(), True)["domain"], DOMAIN)
            result = cf.purge(store(), {"path": "/news/index.html", "expected_domain": DOMAIN, "confirm": True})
        self.assertNotIn("never-return", json.dumps(result))
        calls = opener.open.call_args_list
        self.assertEqual([c.args[0].get_method() for c in calls], ["GET", "GET", "POST"])
        self.assertEqual([c.args[0].full_url for c in calls], [endpoint, endpoint, endpoint + "/purge_cache"])
        self.assertEqual(json.loads(calls[-1].args[0].data), {"files": ["https://example.invalid/news/index.html"]})
        for call in calls:
            self.assertEqual(call.kwargs, {"timeout": 8})
            self.assertEqual(call.args[0].get_header("Authorization"), "Bearer " + TOKEN)

    def test_no_network_for_metadata_or_unconfigured(self):
        vault = store()
        vault.metadata.return_value["cloudflare_zone_id"]["configured"] = False
        with patch.object(operations, "vault", return_value=vault), patch.object(cf, "_call") as call:
            self.assertEqual(operations.capabilities()["cloudflare"]["status"], "not_configured")
            self.assertEqual(cf.inspect(vault)["status"], "not_configured")
        call.assert_not_called()

    def test_changed_target_never_posts(self):
        for change in ({"name": "other.invalid"}, {"status": "pending"}):
            with patch.object(cf, "_call", return_value=zone_payload(**change)["result"]) as call:
                with self.assertRaises(cf.TargetChanged):
                    cf.purge(store(), {"path": "/", "expected_domain": DOMAIN, "confirm": True})
                self.assertEqual(call.call_count, 1)

    def test_wrong_id_and_malformed_zone_never_authorize_purge(self):
        for change in ({"id": "b" * 32}, {"status": []}, {"name": "127.0.0.1"}, {"name": "evil.invalid/path"}):
            with patch.object(cf, "_call", return_value=zone_payload(**change)["result"]) as call:
                with self.assertRaises(cf.ProviderUnavailable):
                    cf.purge(store(), {"path": "/", "expected_domain": DOMAIN, "confirm": True})
                self.assertEqual(call.call_count, 1)

    def test_invalid_input_never_networks(self):
        bad_paths = ["https://evil.invalid/a", "//evil.invalid/a", "/a//b", "/../a", "/./a", "/a/..", "/%2e%2e/", "/a%2fb", "/a\\b", "/x?y=1", "/x#f", "/a\n", ["/"], "/" + "x" * 2048]
        with patch.object(cf, "_call") as call:
            for path in bad_paths:
                with self.assertRaises(ValueError, msg=str(path)):
                    cf.purge(store(), {"path": path, "expected_domain": DOMAIN, "confirm": True})
            for body in ({"path": "/", "expected_domain": DOMAIN, "confirm": 1}, {"files": ["/"]},
                         {"path": "/", "expected_domain": "https://evil.invalid", "confirm": True}):
                with self.assertRaises(ValueError):
                    cf.purge(store(), body)
        call.assert_not_called()

    def test_bad_upstream_and_redirects_refused(self):
        for payload, code, url in [(zone_payload(), 302, None), (zone_payload(), 200, "https://evil.invalid"),
                                   ({"success": False, "result": {}}, 200, None), ([], 200, None)]:
            opener = Mock()
            opener.open.return_value = provider(payload, code, url)
            with patch.object(cf.request, "build_opener", return_value=opener), self.assertRaises(cf.ProviderUnavailable):
                cf.inspect(store())
        self.assertIsNone(cf.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.invalid"))
        for code in (403, 429):
            opener.open.side_effect = cf.error.HTTPError("https://api.cloudflare.com", code, "private-provider-error", {}, None)
            with patch.object(cf.request, "build_opener", return_value=opener), self.assertRaises(cf.ProviderUnavailable):
                cf.inspect(store())
        opener.open.side_effect = None
        response = io.BytesIO(b"x" * 65537)
        response.getcode = lambda: 200
        response.geturl = lambda: "https://api.cloudflare.com/client/v4/zones/" + ZONE
        opener.open.return_value = response
        with patch.object(cf.request, "build_opener", return_value=opener), self.assertRaises(cf.ProviderUnavailable):
            cf.inspect(store())

    def test_zone_slot_validation_before_protection(self):
        vault = object.__new__(CredentialStore)
        with patch.object(vault, "_path"), patch("enterprise_portal.operations_store._protect") as protect:
            for invalid in ("abc", "z" * 32, "a" * 33, None):
                with self.assertRaises(ValueError):
                    vault.set("cloudflare_zone_id", invalid)
            protect.assert_not_called()


class RequestTests(unittest.TestCase):
    setUp = base_tests.OperationsTests.setUp
    request = base_tests.OperationsTests.request
    def test_cloudflare_permissions_and_csrf(self):
        with patch.object(operations, "vault", return_value=store()), patch.object(cf, "_call", return_value=zone_payload()["result"]) as call:
            self.assertEqual(operations_views.cloudflare(self.request({})).status_code, 403)
            self.user.has_perm.return_value = True
            self.assertEqual(operations_views.cloudflare(self.request({})).status_code, 403)
            call.assert_not_called()
            self.policy.is_enterprise_owner = lambda user: True
            body = {"path": "/", "expected_domain": DOMAIN, "confirm": True}
            self.assertEqual(operations_views.cloudflare(self.request(body, False)).status_code, 403)
            call.assert_not_called()
            response = operations_views.cloudflare(self.request(body))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response["Cache-Control"], "no-store")
            self.assertNotIn(TOKEN, response.content.decode())

    def test_read_tech_and_failure_shape(self):
        self.user.has_perm.return_value = True
        req = self.factory.get("/cloudflare/")
        req.user = self.user
        with patch.object(operations, "vault", return_value=store()), patch.object(cf, "_call", return_value=zone_payload()["result"]):
            result = json.loads(operations_views.cloudflare(req).content)
            self.assertFalse(result["can_purge"])
        with patch.object(operations, "vault", return_value=store()), patch.object(cf, "_call", side_effect=cf.ProviderUnavailable("raw-private")):
            response = operations_views.cloudflare(req)
            self.assertEqual(response.status_code, 502)
            self.assertNotIn("raw-private", response.content.decode())

    def test_model_only_selects_read(self):
        from . import operations_ai
        self.user.has_perm.return_value = True
        vault = store()
        vault._read_for_provider.side_effect = lambda slot: "synthetic-model-key" if slot == "deepseek_api_key" else {"cloudflare_zone_id": ZONE, "cloudflare_api_token": TOKEN}[slot]
        with patch.object(operations, "vault", return_value=vault), patch.object(operations_ai, "classify", return_value="cloudflare_status") as classify, patch.object(cf, "_call", return_value=zone_payload()["result"]) as call:
            self.assertEqual(operations_ai.route("检查 Cloudflare", self.user, consent=True)["effect"], "read")
            classify.assert_called_once_with("检查 Cloudflare", "synthetic-model-key")
            self.assertEqual(call.call_count, 1)
            self.assertEqual(len(call.call_args.args), 2)
        self.assertNotIn("cloudflare_purge", operations_ai.ACTIONS)
