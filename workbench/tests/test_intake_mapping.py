from types import SimpleNamespace

from django.test import SimpleTestCase

from workbench.intake.mapping import _cell_value, build_mapping
from workbench.intake.schemas import FIELD_SCHEMAS, MappingError, SCHEMA_VERSION, validate_mapping_shape


class _Rows(list):
    def all(self):
        return self

    def filter(self, **criteria):
        return _Rows(item for item in self if all(getattr(item, key) == value for key, value in criteria.items()))

    def first(self):
        return self[0] if self else None

    def values_list(self, field, flat=False):
        values = [getattr(item, field) for item in self]
        return values if flat else [(value,) for value in values]


class IntakeMappingSchemaTests(SimpleTestCase):
    def test_cell_image_placeholder_is_unresolved_without_masking_formula_or_floating_content(self):
        sheet = SimpleNamespace(pk="sheet-1", sheet_index=1, title="Synthetic")
        image_cell = SimpleNamespace(
            coordinate="A1", raw_value={"xml_type": "e", "v_lexeme": "#VALUE!", "formula_present": False},
            error_code="", normalized_value="#VALUE!", cached_value=None, formula_status="not_formula",
        )
        formula_error_cell = SimpleNamespace(
            coordinate="B1", raw_value={"xml_type": "e", "v_lexeme": "#VALUE!", "formula_present": True},
            error_code="cached_formula_error", normalized_value=None, cached_value={"state": "present"},
            formula_status="unsupported",
        )
        floating_anchor_cell = SimpleNamespace(
            coordinate="C1", raw_value={"xml_type": "s", "v_lexeme": "0", "shared_string": "real text", "formula_present": False},
            error_code="", normalized_value="real text", cached_value=None, formula_status="not_formula",
        )
        sheet.cells = _Rows([image_cell, formula_error_cell, floating_anchor_cell])
        snapshot = SimpleNamespace(
            pk="snapshot-1", status="ready", source_id="source-1", source=SimpleNamespace(sha256="a" * 64),
            sheets=_Rows([sheet]),
            image_references=_Rows([
                SimpleNamespace(sheet=sheet, kind="rich_data", coordinate="A1"),
                SimpleNamespace(sheet=sheet, kind="drawing", coordinate="C1"),
            ]),
        )
        payload = {
            "schema_version": 1,
            "candidate_type": "product_identity",
            "source_sha256": "a" * 64,
            "expected_revision": 0,
            "fields": {"description": {"cells": [
                {"sheet_index": 1, "coordinate": "A1"},
                {"sheet_index": 1, "coordinate": "B1"},
                {"sheet_index": 1, "coordinate": "C1"},
            ]}},
        }

        candidate, provenance = build_mapping(snapshot, payload)

        self.assertEqual([item["state"] for item in candidate["fields"]["description"]], [
            "type_mismatch", "formula_error", "present",
        ])
        self.assertIsNone(candidate["fields"]["description"][0]["value"])
        self.assertEqual([item["coordinate"] for item in provenance["description"]], ["A1", "B1", "C1"])
        self.assertEqual(_cell_value(image_cell, "decimal", is_cell_image=True), {
            "state": "type_mismatch", "type": "decimal", "value": None,
        })
        self.assertEqual(_cell_value(image_cell, "date", is_cell_image=True), {
            "state": "type_mismatch", "type": "date", "value": None,
        })

    def test_text_decimal_formula_cache_and_formula_error_states_remain_distinct(self):
        text = SimpleNamespace(
            raw_value={"xml_type": "s", "v_lexeme": "0", "shared_string": "ordinary", "formula_present": False},
            error_code="", normalized_value="ordinary", cached_value=None,
        )
        decimal = SimpleNamespace(
            raw_value={"xml_type": "n", "v_lexeme": "0", "formula_present": False},
            error_code="", normalized_value=0, cached_value=None,
        )
        missing_cache = SimpleNamespace(
            raw_value={"xml_type": "", "formula_present": True}, error_code="",
            normalized_value=None, cached_value={"state": "missing"},
        )
        formula_error = SimpleNamespace(
            raw_value={"xml_type": "e", "formula_present": True}, error_code="cached_formula_error",
            normalized_value=None, cached_value={"state": "present", "value": "#VALUE!"},
        )

        self.assertEqual(_cell_value(text, "text")["state"], "present")
        self.assertEqual(_cell_value(decimal, "decimal"), {"state": "present", "type": "decimal", "value": "0"})
        self.assertEqual(_cell_value(missing_cache, "decimal")["state"], "formula_cache_missing")
        self.assertEqual(_cell_value(formula_error, "text")["state"], "formula_error")

    def test_candidate_schemas_are_closed_and_separate_unconfirmed_domains(self):
        self.assertEqual(SCHEMA_VERSION, 1)
        self.assertEqual(set(FIELD_SCHEMAS), {"product_identity", "commercial_source", "production_instruction", "labor_analysis", "material_master", "production_instruction_line", "purchase_plan_line", "stock_receipt_line", "shipment_payment_line"})
        self.assertIn("customer_item_code", FIELD_SCHEMAS["product_identity"])
        self.assertIn("party_text", FIELD_SCHEMAS["commercial_source"])
        self.assertNotIn("party_role", FIELD_SCHEMAS["commercial_source"])
        self.assertIn("source_order_reference", FIELD_SCHEMAS["production_instruction"])
        self.assertEqual(FIELD_SCHEMAS["production_instruction"]["requirement_text"], "text")
        self.assertEqual(FIELD_SCHEMAS["production_instruction"]["pack_quantity"], "decimal")
        self.assertEqual(FIELD_SCHEMAS["production_instruction"]["pack_unit"], "text")
        self.assertNotIn("employee_actual_hours", FIELD_SCHEMAS["labor_analysis"])
        self.assertEqual(FIELD_SCHEMAS["material_master"]["item_code"], "text")

    def test_mapping_schema_version_requires_json_integer_not_boolean(self):
        mapping = {
            "schema_version": True,
            "candidate_type": "product_identity",
            "source_sha256": "a" * 64,
            "expected_revision": 0,
            "fields": {"description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}},
        }
        with self.assertRaises(MappingError) as rejected:
            validate_mapping_shape(mapping)
        self.assertEqual(rejected.exception.code, "unsupported_schema")

    def test_mapping_candidate_type_requires_string_before_registry_lookup(self):
        mapping = {
            "schema_version": 1,
            "candidate_type": [],
            "source_sha256": "a" * 64,
            "expected_revision": 0,
            "fields": {"description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}},
        }
        with self.assertRaises(MappingError) as rejected:
            validate_mapping_shape(mapping)
        self.assertEqual(rejected.exception.code, "unsupported_candidate_type")

    def test_mapping_shape_rejects_unknown_and_duplicate_business_fields(self):
        mapping = {
            "schema_version": 1,
            "candidate_type": "labor_analysis",
            "source_sha256": "a" * 64,
            "expected_revision": 0,
            "fields": {"employee_actual_hours": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}},
        }
        with self.assertRaises(MappingError) as rejected:
            validate_mapping_shape(mapping)
        self.assertEqual(rejected.exception.code, "unknown_field")

    def test_mapping_shape_bounds_source_cells_and_rejects_extra_keys(self):
        mapping = {
            "schema_version": 1,
            "candidate_type": "product_identity",
            "source_sha256": "a" * 64,
            "expected_revision": 0,
            "extra": "ignored-by-no-one",
            "fields": {"description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}},
        }
        with self.assertRaises(MappingError) as rejected:
            validate_mapping_shape(mapping)
        self.assertEqual(rejected.exception.code, "invalid_mapping")
