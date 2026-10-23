from __future__ import annotations

from unittest.mock import Mock, patch

from django.test import SimpleTestCase, override_settings

from workbench.erpnext.client import ErpNextError
from workbench.erpnext.dto import ErpNextPage, ErpNextRecord


class ErpNextApiTests(SimpleTestCase):
    @override_settings(
        TRADELOOM_ERPNEXT_BASE_URL="",
        TRADELOOM_ERPNEXT_INSTANCE_ID="",
        TRADELOOM_ERPNEXT_API_KEY="",
        TRADELOOM_ERPNEXT_API_SECRET="",
    )
    def test_status_reports_unconfigured_without_constructing_or_calling_client(self):
        response = self.client.get("/api/erpnext/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "configured": False,
            "connected": False,
            "status": "not_configured",
            "error_code": "",
            "site_url": "",
        })

    def test_status_checks_configured_connection_and_returns_only_the_safe_site_link(self):
        fake_client = Mock()
        fake_client.check_connection.return_value = True
        fake_client.site_url = "https://erp.example.test"
        with patch("workbench.erpnext.api._client_from_settings", return_value=fake_client):
            response = self.client.get("/api/erpnext/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "configured": True,
            "connected": True,
            "status": "connected",
            "error_code": "",
            "site_url": "https://erp.example.test",
        })
        fake_client.check_connection.assert_called_once_with()

    def test_status_keeps_a_false_connection_check_unavailable(self):
        fake_client = Mock()
        fake_client.check_connection.return_value = False
        fake_client.site_url = "http://127.0.0.1:18080"
        with patch("workbench.erpnext.api._client_from_settings", return_value=fake_client):
            response = self.client.get("/api/erpnext/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "configured": True,
            "connected": False,
            "status": "unavailable",
            "error_code": "unavailable",
            "site_url": "http://127.0.0.1:18080",
        })

    def test_list_uses_fixed_query_dto_and_returns_external_reference(self):
        record = ErpNextRecord(
            doctype="Item",
            data={"name": "ITEM-1", "item_code": "ITEM-1"},
            external_ref={
                "system": "erpnext", "instance_id": "local", "doctype": "Item",
                "name": "ITEM-1", "modified": None,
            },
        )
        fake_client = Mock()
        fake_client.list_records.return_value = ErpNextPage("Item", (record,), None)
        with patch("workbench.erpnext.api._client_from_settings", return_value=fake_client):
            response = self.client.get(
                "/api/erpnext/records",
                {
                    "doctype": "Item",
                    "fields": "item_code",
                    "filters": '{"item_group":"Ribbon"}',
                    "limit": "10",
                    "offset": "20",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "doctype": "Item",
            "records": [{
                "doctype": "Item", "data": {"name": "ITEM-1", "item_code": "ITEM-1"},
                "external_ref": record.external_ref,
            }],
            "next_offset": None,
        })
        fake_client.list_records.assert_called_once_with(
            "Item", fields=["item_code"], filters={"item_group": "Ribbon"}, limit=10, offset=20,
        )

    def test_list_rejects_unknown_doctype_query_fields_and_bad_json_before_client_call(self):
        fake_client = Mock()
        cases = (
            ("/api/erpnext/records?doctype=User", 422),
            ("/api/erpnext/records?doctype=Item&url=https%3A%2F%2Fexample.test", 422),
            ("/api/erpnext/records?doctype=Item&filters=%5B%5D", 422),
            ("/api/erpnext/records?doctype=Item&limit=1&limit=2", 422),
        )
        with patch("workbench.erpnext.api._client_from_settings", return_value=fake_client):
            for url, status in cases:
                with self.subTest(url=url):
                    response = self.client.get(url)
                    self.assertEqual(response.status_code, status)
        fake_client.list_records.assert_not_called()

    def test_detail_uses_query_name_without_interpreting_slashes_as_route_segments(self):
        record = ErpNextRecord(
            "Purchase Order", {"name": "PO/2026 001", "docstatus": 0},
            {"system": "erpnext", "instance_id": "local", "doctype": "Purchase Order",
             "name": "PO/2026 001", "modified": None},
        )
        fake_client = Mock()
        fake_client.get_record.return_value = record
        with patch("workbench.erpnext.api._client_from_settings", return_value=fake_client):
            response = self.client.get("/api/erpnext/record?doctype=Purchase%20Order&name=PO%2F2026%20001")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "doctype": "Purchase Order", "data": record.data, "external_ref": record.external_ref,
        })
        fake_client.get_record.assert_called_once_with("Purchase Order", "PO/2026 001")

    def test_remote_errors_are_fixed_and_never_return_secrets_or_remote_text(self):
        fake_client = Mock()
        fake_client.get_record.side_effect = ErpNextError("unauthorized", "ERPNext 拒绝了认证信息")
        with patch("workbench.erpnext.api._client_from_settings", return_value=fake_client):
            response = self.client.get("/api/erpnext/record?doctype=Item&name=ITEM-1")

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {
            "ok": False, "error_code": "unauthorized", "detail": "ERPNext 拒绝了认证信息",
        })
        self.assertNotIn("API_SECRET", response.content.decode())
        self.assertNotIn("raw remote body", response.content.decode())

    def test_endpoints_are_get_only(self):
        self.assertEqual(self.client.post("/api/erpnext/status").status_code, 405)
        self.assertEqual(self.client.post("/api/erpnext/records").status_code, 405)
        self.assertEqual(self.client.post("/api/erpnext/record").status_code, 405)
