from __future__ import annotations

import math
from typing import Any


# These are the bounded scalar fields used by the current read-only adapter.
# They were checked against the local ERPNext v16.51.1 DocType definitions.
SCALAR_FIELDS: dict[str, frozenset[str]] = {
    "Item": frozenset({
        "item_code", "item_name", "item_group", "stock_uom", "disabled",
        "description", "brand", "image", "is_stock_item", "has_variants",
    }),
    "Customer": frozenset({
        "customer_name", "alias", "customer_type", "customer_group", "territory",
        "tax_id", "disabled", "default_currency", "website", "email_id", "mobile_no",
    }),
    "Supplier": frozenset({
        "supplier_name", "alias", "supplier_type", "supplier_group", "country",
        "tax_id", "disabled", "default_currency", "website", "email_id", "mobile_no",
    }),
    "Warehouse": frozenset({
        "warehouse_name", "is_group", "company", "disabled", "parent_warehouse",
        "warehouse_type", "email_id", "phone_no", "mobile_no", "city", "state",
    }),
    "Bin": frozenset({
        "item_code", "warehouse", "actual_qty", "reserved_qty", "ordered_qty",
        "indented_qty", "planned_qty", "projected_qty", "stock_uom", "company",
    }),
    "Sales Order": frozenset({
        "customer", "customer_name", "company", "transaction_date", "delivery_date",
        "status", "delivery_status", "billing_status", "total_qty", "grand_total", "currency",
    }),
    "Purchase Order": frozenset({
        "supplier", "supplier_name", "company", "transaction_date", "schedule_date",
        "status", "total_qty", "grand_total", "currency",
    }),
}

DEFAULT_LIST_FIELDS: dict[str, tuple[str, ...]] = {
    "Item": ("item_code", "item_name", "item_group", "stock_uom", "disabled"),
    "Customer": ("customer_name", "customer_type", "customer_group", "territory", "disabled"),
    "Supplier": ("supplier_name", "supplier_type", "supplier_group", "country", "disabled"),
    "Warehouse": ("warehouse_name", "company", "parent_warehouse", "disabled"),
    "Bin": ("item_code", "warehouse", "actual_qty", "reserved_qty", "projected_qty", "stock_uom"),
    "Sales Order": ("customer", "customer_name", "company", "transaction_date", "status", "grand_total", "currency"),
    "Purchase Order": ("supplier", "supplier_name", "company", "transaction_date", "status", "grand_total", "currency"),
}

CHILD_FIELDS: dict[str, dict[str, frozenset[str]]] = {
    "Item": {"barcodes": frozenset({"barcode", "barcode_type", "uom"})},
    "Sales Order": {"items": frozenset({"item_code", "item_name", "qty", "uom", "delivery_date", "rate", "amount"})},
    "Purchase Order": {"items": frozenset({"item_code", "item_name", "qty", "uom", "schedule_date", "rate", "amount"})},
}

SYSTEM_FIELDS = frozenset({"name", "modified"})
SYSTEM_FIELD_ORDER = ("name", "modified")
FILTER_FIELDS: dict[str, frozenset[str]] = {
    "Item": frozenset({"item_code", "item_name", "item_group", "stock_uom", "disabled"}),
    "Customer": frozenset({"customer_name", "customer_type", "customer_group", "territory", "tax_id", "disabled"}),
    "Supplier": frozenset({"supplier_name", "supplier_type", "supplier_group", "country", "tax_id", "disabled"}),
    "Warehouse": frozenset({"warehouse_name", "company", "parent_warehouse", "disabled"}),
    "Bin": frozenset({"item_code", "warehouse", "company", "stock_uom"}),
    "Sales Order": frozenset({"customer", "company", "transaction_date", "status", "delivery_status", "billing_status"}),
    "Purchase Order": frozenset({"supplier", "company", "transaction_date", "status"}),
}
SUPPORTED_DOCTYPES = tuple(SCALAR_FIELDS)
MAX_PAGE_SIZE = 100


class UnsupportedErpNextRequest(ValueError):
    """A fixed, safe validation error for requests outside the adapter contract."""


def validate_doctype(doctype: str) -> None:
    if not isinstance(doctype, str) or doctype not in SCALAR_FIELDS:
        raise ValueError("不支持的 ERPNext DocType")


def normalize_fields(doctype: str, fields: Any = None) -> tuple[str, ...]:
    validate_doctype(doctype)
    if fields is None:
        requested = DEFAULT_LIST_FIELDS[doctype]
    else:
        if isinstance(fields, (str, bytes)):
            raise ValueError("ERPNext fields 格式无效")
        try:
            requested = tuple(fields)
        except TypeError:
            raise ValueError("ERPNext fields 格式无效") from None
        if any(not isinstance(field, str) for field in requested):
            raise ValueError("ERPNext fields 格式无效")
        if any(field not in SCALAR_FIELDS[doctype] for field in requested):
            raise ValueError("ERPNext fields 包含未允许的字段")
    return tuple(dict.fromkeys((*SYSTEM_FIELD_ORDER, *requested)))


def normalize_filters(doctype: str, filters: Any) -> list[list[Any]]:
    validate_doctype(doctype)
    if filters is None:
        return []
    if not isinstance(filters, dict):
        raise ValueError("ERPNext filters 格式无效")
    result: list[list[Any]] = []
    for field, value in filters.items():
        if not isinstance(field, str) or field not in FILTER_FIELDS[doctype] | SYSTEM_FIELDS:
            raise ValueError("ERPNext filters 包含未允许的字段")
        if not (value is None or isinstance(value, (str, int, float, bool))):
            raise ValueError("ERPNext filters 值格式无效")
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("ERPNext filters 值格式无效")
        result.append([field, "=", value])
    return result


def normalize_record_data(
    doctype: str,
    payload: Any,
    *,
    fields: frozenset[str] | set[str] | None = None,
) -> dict[str, Any]:
    validate_doctype(doctype)
    if not isinstance(payload, dict):
        raise ValueError("ERPNext 记录格式无效")
    allowed_scalars = SCALAR_FIELDS[doctype] | SYSTEM_FIELDS
    if fields is not None:
        allowed_scalars = allowed_scalars & fields
    allowed_children = CHILD_FIELDS.get(doctype, {})
    result: dict[str, Any] = {}
    for key, value in payload.items():
        if key == "docstatus" and fields is None:
            if type(value) is not int or value not in (0, 1, 2):
                raise ValueError("ERPNext 记录格式无效")
            result[key] = value
            continue
        if key in allowed_scalars and (value is None or isinstance(value, (str, int, float, bool))):
            if not isinstance(value, float) or math.isfinite(value):
                result[key] = value
            continue
        child_fields = allowed_children.get(key)
        if child_fields is not None and isinstance(value, list):
            result[key] = [
                {child_key: child_value for child_key, child_value in row.items()
                 if child_key in child_fields and (
                     child_value is None or isinstance(child_value, (str, int, float, bool))
                 ) and (not isinstance(child_value, float) or math.isfinite(child_value))}
                for row in value if isinstance(row, dict)
            ]
    if not isinstance(result.get("name"), str) or not result["name"]:
        raise ValueError("ERPNext 记录缺少 name")
    return result


def external_reference(instance_id: str, doctype: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "system": "erpnext",
        "instance_id": instance_id,
        "doctype": doctype,
        "name": data["name"],
        "modified": data.get("modified"),
    }
