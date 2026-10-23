from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from workbench.erpnext.client import ErpNextClient, ErpNextConfig, ErpNextError, _urlopen_transport


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url, headers, body, timeout))
        return self.responses.pop(0)


def response(payload, status=200):
    return status, {"Content-Type": "application/json"}, json.dumps(payload).encode()


def client(transport):
    return ErpNextClient(
        ErpNextConfig(
            base_url="https://erp.example.test",
            instance_id="demo-instance",
            api_key="TEST_KEY_DO_NOT_LEAK",
            api_secret="TEST_SECRET_DO_NOT_LEAK",
        ),
        transport=transport,
    )


class ErpNextAdapterTests(unittest.TestCase):
    def test_site_url_is_validated_and_credential_free(self):
        configured = ErpNextConfig(
            base_url="https://erp.example.test/tenant/",
            instance_id="demo-instance",
            api_key="TEST_KEY_DO_NOT_LEAK",
            api_secret="TEST_SECRET_DO_NOT_LEAK",
        )
        self.assertEqual(ErpNextClient(configured).site_url, "https://erp.example.test/tenant")
        self.assertNotIn("TEST_", ErpNextClient(configured).site_url)

    def test_list_uses_endpoint_doctype_allowlists_and_safe_external_reference(self):
        transport = FakeTransport([response({"data": [{
            "name": "ITEM-1",
            "item_code": "ITEM-1",
            "item_name": "Demo item",
            "modified": "2026-10-20 12:00:00",
            "secret_field": "must not escape",
        }]})])

        page = client(transport).list_records(
            "Item", fields=["item_code", "item_name"], filters={"item_code": "ITEM-1"}
        )

        method, url, headers, body, timeout = transport.calls[0]
        query = parse_qs(urlsplit(url).query)
        self.assertEqual(method, "GET")
        self.assertEqual(urlsplit(url).path, "/api/resource/Item")
        self.assertEqual(json.loads(query["fields"][0]), ["name", "modified", "item_code", "item_name"])
        self.assertEqual(json.loads(query["filters"][0]), [["item_code", "=", "ITEM-1"]])
        self.assertNotIn("doctype", query)
        self.assertEqual(body, None)
        self.assertGreater(timeout, 0)
        self.assertEqual(headers["Authorization"], "token TEST_KEY_DO_NOT_LEAK:TEST_SECRET_DO_NOT_LEAK")
        self.assertEqual(page.records[0].data, {
            "name": "ITEM-1", "item_code": "ITEM-1", "item_name": "Demo item",
            "modified": "2026-10-20 12:00:00",
        })
        self.assertEqual(page.records[0].external_ref, {
            "system": "erpnext", "instance_id": "demo-instance", "doctype": "Item",
            "name": "ITEM-1", "modified": "2026-10-20 12:00:00",
        })
        self.assertNotIn("secret_field", page.records[0].data)
        self.assertNotIn("TEST_SECRET_DO_NOT_LEAK", repr(page))

    def test_list_paginates_without_claiming_a_total(self):
        transport = FakeTransport([response({"data": [
            {"name": "B1", "item_code": "B1", "modified": "m1"},
            {"name": "B2", "item_code": "B2", "modified": "m2"},
        ]})])

        page = client(transport).list_records("Bin", limit=2, offset=4)

        query = parse_qs(urlsplit(transport.calls[0][1]).query)
        self.assertEqual(query["limit_start"], ["4"])
        self.assertEqual(query["limit_page_length"], ["2"])
        self.assertEqual(page.next_offset, 6)
        self.assertFalse(hasattr(page, "total"))

        for rows in ([{"name": "B1", "item_code": "B1"}], []):
            with self.subTest(row_count=len(rows)):
                last_page = client(FakeTransport([response({"data": rows})])).list_records(
                    "Bin", limit=2, offset=6
                )
                self.assertIsNone(last_page.next_offset)

    def test_item_detail_preserves_only_whitelisted_barcode_child_fields(self):
        transport = FakeTransport([response({"data": {
            "name": "ITEM-1", "item_code": "ITEM-1", "item_name": "Demo item",
            "modified": "m1", "barcodes": [
                {"barcode": "0001", "barcode_type": "EAN", "uom": "Nos", "private": "drop"},
            ],
            "private": "drop",
        }})])

        record = client(transport).get_record("Item", "ITEM-1")

        self.assertEqual(record.data["barcodes"], [{
            "barcode": "0001", "barcode_type": "EAN", "uom": "Nos",
        }])
        self.assertNotIn("barcode", record.data)
        self.assertNotIn("private", record.data)

    def test_order_detail_projects_whitelisted_items_child_fields(self):
        for doctype, name_field, child_field, child_value in (
            ("Sales Order", "customer", "delivery_date", "2026-10-22"),
            ("Purchase Order", "supplier", "schedule_date", "2026-10-23"),
        ):
            with self.subTest(doctype=doctype):
                transport = FakeTransport([response({"data": {
                    "name": "ORDER-1", name_field: "PARTY-1", "modified": "m1",
                    "currency": "USD", "grand_total": 42.5, "docstatus": 1,
                    "items": [{"item_code": "ITEM-1", "qty": 2, child_field: child_value,
                               "private": "drop"}],
                    "private": "drop",
                }})])
                record = client(transport).get_record(doctype, "ORDER-1")
                self.assertEqual(record.data["items"], [{
                    "item_code": "ITEM-1", "qty": 2, child_field: child_value,
                }])
                self.assertEqual(record.data["currency"], "USD")
                self.assertEqual(record.data["grand_total"], 42.5)
                self.assertEqual(record.data["docstatus"], 1)
                self.assertNotIn("private", record.data)

    def test_order_default_lists_include_currency_with_total(self):
        for doctype, party_field in (
            ("Sales Order", "customer"),
            ("Purchase Order", "supplier"),
        ):
            with self.subTest(doctype=doctype):
                transport = FakeTransport([response({"data": []})])
                client(transport).list_records(doctype)
                query = parse_qs(urlsplit(transport.calls[0][1]).query)
                fields = json.loads(query["fields"][0])
                self.assertIn("grand_total", fields)
                self.assertIn("currency", fields)
                self.assertIn(party_field, fields)

    def test_rejects_invalid_system_docstatus_in_detail_response(self):
        for docstatus in (True, -1, 3, "Submitted"):
            with self.subTest(docstatus=docstatus):
                transport = FakeTransport([response({"data": {
                    "name": "ORDER-1", "customer": "PARTY-1", "modified": "m1",
                    "currency": "USD", "grand_total": 42.5, "docstatus": docstatus,
                }})])
                with self.assertRaises(ErpNextError) as raised:
                    client(transport).get_record("Sales Order", "ORDER-1")
                self.assertEqual(raised.exception.code, "invalid_response")

    def test_detail_preserves_supported_docstatus_values(self):
        for docstatus in (0, 1, 2):
            with self.subTest(docstatus=docstatus):
                transport = FakeTransport([response({"data": {
                    "name": "ORDER-1", "customer": "PARTY-1", "modified": "m1",
                    "docstatus": docstatus,
                }})])
                record = client(transport).get_record("Sales Order", "ORDER-1")
                self.assertEqual(record.data["docstatus"], docstatus)

    def test_rejects_unlisted_doctype_fields_filters_and_invalid_pagination_before_io(self):
        transport = FakeTransport([])
        erp = client(transport)
        for call in (
            lambda: erp.list_records("User"),
            lambda: erp.list_records("Item", fields=["owner"]),
            lambda: erp.list_records("Item", filters={"description": "x"}),
            lambda: erp.list_records("Item", limit=101),
            lambda: erp.list_records("Item", offset=-1),
        ):
            with self.subTest(call=call), self.assertRaises(ValueError):
                call()
        self.assertEqual(transport.calls, [])

    def test_detail_name_is_encoded_as_one_path_segment(self):
        transport = FakeTransport([response({"data": {
            "name": "PO/2026 001", "supplier": "S-1", "modified": "m1",
        }})])

        client(transport).get_record("Purchase Order", "PO/2026 001")

        self.assertTrue(transport.calls[0][1].endswith("/Purchase%20Order/PO%2F2026%20001"))

    def test_unconfigured_client_does_not_call_transport_and_credentials_are_redacted(self):
        transport = FakeTransport([])
        unconfigured = ErpNextClient(None, transport=transport)
        with self.assertRaises(ErpNextError) as raised:
            unconfigured.list_records("Item")
        self.assertEqual(raised.exception.code, "not_configured")
        self.assertEqual(transport.calls, [])

        configured = client(transport)
        self.assertNotIn("TEST_KEY_DO_NOT_LEAK", repr(configured))
        self.assertNotIn("TEST_SECRET_DO_NOT_LEAK", repr(configured))

    def test_connection_check_returns_only_reachability_not_remote_identity(self):
        transport = FakeTransport([response({"message": "private@example.test"})])

        connected = client(transport).check_connection()

        method, url, headers, body, _timeout = transport.calls[0]
        self.assertTrue(connected)
        self.assertEqual(method, "GET")
        self.assertEqual(urlsplit(url).path, "/api/method/frappe.auth.get_logged_user")
        self.assertIn("Authorization", headers)
        self.assertIsNone(body)

    def test_local_loopback_http_is_allowed_but_remote_http_and_userinfo_are_rejected(self):
        config = ErpNextConfig(
            base_url="http://127.0.0.1:18080",
            instance_id="local-demo",
            api_key="key",
            api_secret="secret",
        )
        self.assertEqual(urlsplit(config.base_url).hostname, "127.0.0.1")
        for base_url in (
            "http://erp.example.test",
            "http://user@127.0.0.1:18080",
            "https://user:password@erp.example.test",
        ):
            with self.subTest(base_url=urlsplit(base_url).hostname), self.assertRaises(ValueError):
                ErpNextConfig(base_url=base_url, instance_id="local-demo", api_key="key", api_secret="secret")

    def test_real_http_transport_does_not_forward_authorization_across_redirect(self):
        captured_authorizations = []

        class CaptureHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                captured_authorizations.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"data":[]}')

            def log_message(self, format, *args):
                pass

        capture_server = ThreadingHTTPServer(("127.0.0.1", 0), CaptureHandler)
        capture_thread = threading.Thread(target=capture_server.serve_forever, daemon=True)
        capture_thread.start()
        capture_url = f"http://127.0.0.1:{capture_server.server_port}/capture"

        class RedirectHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", capture_url)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, format, *args):
                pass

        redirect_server = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        redirect_thread = threading.Thread(target=redirect_server.serve_forever, daemon=True)
        redirect_thread.start()
        try:
            status, _headers, _body = _urlopen_transport(
                "GET",
                f"http://127.0.0.1:{redirect_server.server_port}/resource",
                {"Authorization": "token test-key:test-secret"},
                None,
                2.0,
            )
            self.assertEqual(status, 302)
            self.assertEqual(captured_authorizations, [])
        finally:
            redirect_server.shutdown()
            redirect_server.server_close()
            capture_server.shutdown()
            capture_server.server_close()
            redirect_thread.join(timeout=2)
            capture_thread.join(timeout=2)

    def test_remote_error_and_invalid_json_are_mapped_without_remote_text(self):
        secret = "TEST_SECRET_DO_NOT_LEAK"
        transport = FakeTransport([
            (401, {"Content-Type": "application/json"}, json.dumps({"message": secret}).encode()),
            (200, {"Content-Type": "application/json"}, secret.encode()),
        ])
        erp = client(transport)

        for expected_code in ("unauthorized", "invalid_response"):
            with self.subTest(code=expected_code), self.assertRaises(ErpNextError) as raised:
                erp.list_records("Item")
            self.assertEqual(raised.exception.code, expected_code)
            self.assertNotIn(secret, str(raised.exception))
            self.assertNotIn(secret, repr(raised.exception))


if __name__ == "__main__":
    unittest.main()
