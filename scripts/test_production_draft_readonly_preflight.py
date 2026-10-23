from __future__ import annotations

import importlib.util
import contextlib
import io
import json
import unittest
from pathlib import Path
from urllib.error import HTTPError


SCRIPT = Path(__file__).with_name("production_draft_readonly_preflight.py")
SPEC = importlib.util.spec_from_file_location("production_draft_readonly_preflight", SCRIPT)
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class ReadonlyPreflightTests(unittest.TestCase):
    def valid_config(self):
        return {
            "data_root": "private-data-root-reference",
            "password_file": "private-password-file-reference",
            "database": {"name": "db", "user": "user", "host": "127.0.0.1", "port": 1234,
                         "server_version_prefix": "17"},
            "api_base": "http://127.0.0.1:3090",
            "api_host_header": "configured-local-host",
            "source_sha256": "a" * 64,
            "migration": "migration-name",
        }

    def test_public_output_is_fixed_shape_and_does_not_accept_secret_fields(self):
        secret = "customer-name-and-secret"
        result = preflight.emit_result("review_required", reason=secret,
                                       checks={"ok": True}, counts={"count": 3},
                                       gates={"gate": "review"})
        encoded = json.dumps(result)
        self.assertNotIn(secret, encoded)
        self.assertEqual(set(result), {"status", "reason", "checks", "counts", "gates"})
        self.assertEqual(result["reason"], "")

    def test_config_requires_loopback_api_and_a_source_selector(self):
        self.assertEqual(preflight.validate_config(self.valid_config())["source_sha256"], "a" * 64)
        config = self.valid_config()
        config["api_base"] = "http://127.0.0.1.attacker.invalid:3090"
        with self.assertRaises(preflight.PreflightFailure) as error:
            preflight.validate_config(config)
        self.assertEqual(error.exception.code, "API_BASE_NOT_LOOPBACK")
        config = self.valid_config()
        config["source_sha256"] = "secret"
        with self.assertRaises(preflight.PreflightFailure) as error:
            preflight.validate_config(config)
        self.assertEqual(error.exception.code, "CONFIG_INVALID")
        config = self.valid_config()
        config["database"]["host"] = "database.example.invalid"
        with self.assertRaises(preflight.PreflightFailure) as error:
            preflight.validate_config(config)
        self.assertEqual(error.exception.code, "CONFIG_INVALID")

    def test_review_gate_never_treats_unknown_record_kind_as_ready(self):
        self.assertEqual(preflight.review_gate(candidate_count=1, mapped=13, unresolved=0,
                                               draft_count=0,
                                               receipt_states={}), "record_kind_review_required")
        self.assertEqual(preflight.review_gate(candidate_count=1, mapped=1, unresolved=12,
                                               draft_count=0,
                                               receipt_states={}), "mapping_review_required")
        self.assertEqual(preflight.review_gate(candidate_count=1, mapped=13, unresolved=0,
                                               draft_count=0,
                                               receipt_states={}, mapped_locator_missing=1),
                         "mapping_review_required")
        self.assertEqual(preflight.review_gate(candidate_count=2, mapped=13, unresolved=0,
                                               draft_count=0,
                                               receipt_states={}), "candidate_ambiguous")
        self.assertEqual(preflight.review_gate(candidate_count=1, mapped=13, unresolved=0,
                                               draft_count=0,
                                               receipt_states={}, candidate_unconfirmed=False),
                         "candidate_status_review_required")

    def test_broken_source_chain_and_locator_or_cell_mismatch_fail_closed(self):
        chain = dict(selected_source_id="c", candidate_type="production_instruction", mapping_type="production_instruction",
                     candidate_mapping_id="a", mapping_id="a", mapping_snapshot_id="b", snapshot_id="b",
                     snapshot_source_id="c", source_id="c", candidate_sha="d", mapping_sha="d",
                     source_sha="d", mapping_payload_source_sha="d", candidate_schema_version=1,
                     mapping_schema_version=1, snapshot_status="ready")
        self.assertTrue(preflight.source_chain_matches(**chain))
        self.assertFalse(preflight.source_chain_matches(**{**chain, "mapping_sha": "different"}))
        self.assertFalse(preflight.source_chain_matches(**{**chain, "selected_source_id": "another-source"}))
        self.assertFalse(preflight.source_chain_matches(**{**chain, "mapping_schema_version": 2}))
        locator = {"snapshot_id": "b", "source_id": "c", "source_sha256": "d",
                   "sheet_index": 0, "coordinate": "A1"}
        self.assertTrue(preflight.locator_cell_matches(locator, snapshot_id="b", source_id="c",
                                                       source_sha="d", cell_exists=True))
        self.assertFalse(preflight.locator_cell_matches(locator, snapshot_id="b", source_id="c",
                                                        source_sha="d", cell_exists=False))
        self.assertFalse(preflight.locator_cell_matches(locator, snapshot_id="other", source_id="c",
                                                        source_sha="d", cell_exists=True))

    def test_every_mapped_field_requires_a_valid_source_locator(self):
        self.assertEqual(preflight.missing_mapped_locator_count({"description", "quantity"}, {"description"}), 1)
        self.assertEqual(preflight.missing_mapped_locator_count({"description"}, {"description"}), 0)

    def test_readonly_off_is_a_failure_reason_not_raw_database_text(self):
        self.assertFalse(preflight.readonly_is_enforced("off"))
        self.assertTrue(preflight.readonly_is_enforced("on"))
        expected = ("db", "user", "127.0.0.1", 1234)
        self.assertTrue(preflight.database_identity_matches((*expected, "170000"), expected, "17"))
        self.assertFalse(preflight.database_identity_matches(("other", *expected[1:], "170000"), expected, "17"))
        loopback_expected = ("db", "user", "localhost", 1234)
        self.assertTrue(preflight.database_identity_matches(("db", "user", "::1", 1234, "170000"),
                                                            loopback_expected, "17"))
        result = preflight.emit_result("failed", reason="DATABASE_READONLY_NOT_ENFORCED")
        self.assertEqual(result["reason"], "DATABASE_READONLY_NOT_ENFORCED")
        self.assertNotIn("password", json.dumps(result).lower())

    def test_http_request_is_get_and_redirect_is_rejected(self):
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit): return b'{"ok":true,"sources":[],"next_offset":null}'

        class Opener:
            def __init__(self): self.request = None
            def open(self, request, timeout):
                self.request = request
                return Response()

        opener = Opener()
        preflight._safe_json_response(opener, "http://127.0.0.1:3090", "configured-local-host",
                                      "/api/intake/sources", {"offset": 0})
        self.assertEqual(opener.request.get_method(), "GET")
        handler = preflight.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "Found", {}, "http://elsewhere"))

    def test_non_loopback_and_redirect_errors_are_sanitized(self):
        class RedirectingOpener:
            def open(self, request, timeout):
                raise HTTPError(request.full_url, 302, "sensitive-location", {}, None)

        with self.assertRaises(preflight.PreflightFailure) as error:
            preflight._safe_json_response(RedirectingOpener(), "http://127.0.0.1:3090", "configured-local-host",
                                          "/api/intake/sources", {})
        self.assertEqual(error.exception.code, "API_GET_FAILED")
        self.assertNotIn("sensitive-location", str(error.exception))

    def test_cli_argument_errors_are_json_and_do_not_echo_unknown_values(self):
        secret = "synthetic-secret-should-not-echo"
        for args in ([], ["--unexpected", secret]):
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = preflight.main(args)
            self.assertEqual(code, preflight.EXIT_FAILURE)
            self.assertNotIn(secret, stdout.getvalue() + stderr.getvalue())
            report = json.loads(stdout.getvalue())
            self.assertEqual(report["status"], "failed")
            self.assertEqual(report["reason"], "CONFIG_INVALID")
            self.assertEqual(stderr.getvalue(), "")

if __name__ == "__main__":
    unittest.main()
