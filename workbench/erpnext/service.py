from __future__ import annotations

import math
import re
from datetime import date
from decimal import Decimal, InvalidOperation
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
MAX_QUOTATION_ITEMS = 100
_QUOTATION_DECIMAL = re.compile(r"-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?\Z")
_QUOTATION_TEXT = re.compile(r"[^\x00-\x1f\x7f]{1,140}\Z")


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


def normalize_quotation_payload(payload: Any) -> dict[str, Any]:
    """Validate the narrow local draft-create contract; never accept ERPNext actions."""
    if not isinstance(payload, dict):
        raise ValueError("报价内容格式无效")
    allowed = {"company", "party_name", "transaction_date", "valid_till", "currency", "items"}
    if set(payload) - allowed or not allowed - {"valid_till"} <= set(payload):
        raise ValueError("报价内容字段无效")

    result: dict[str, Any] = {}
    for field in ("company", "party_name"):
        value = payload.get(field)
        if not isinstance(value, str) or not _QUOTATION_TEXT.fullmatch(value) or value != value.strip():
            raise ValueError("报价引用格式无效")
        try:
            value.encode("utf-8", "strict")
        except UnicodeEncodeError:
            raise ValueError("报价引用格式无效") from None
        result[field] = value

    for field in ("transaction_date", "valid_till"):
        value = payload.get(field)
        if field == "valid_till" and value is None:
            continue
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
            raise ValueError("报价日期格式无效")
        try:
            date.fromisoformat(value)
        except ValueError:
            raise ValueError("报价日期格式无效") from None
        result[field] = value

    currency = payload.get("currency")
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValueError("币种代码格式无效")
    result["currency"] = currency

    items = payload.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_QUOTATION_ITEMS:
        raise ValueError("报价明细数量无效")
    normalized_items: list[dict[str, Any]] = []
    item_fields = {"item_code", "qty", "rate", "uom"}
    for item in items:
        if not isinstance(item, dict) or set(item) != item_fields:
            raise ValueError("报价明细字段无效")
        normalized: dict[str, Any] = {}
        for field in ("item_code", "uom"):
            value = item.get(field)
            if not isinstance(value, str) or not _QUOTATION_TEXT.fullmatch(value) or value != value.strip():
                raise ValueError("报价明细引用格式无效")
            try:
                value.encode("utf-8", "strict")
            except UnicodeEncodeError:
                raise ValueError("报价明细引用格式无效") from None
            normalized[field] = value
        for field in ("qty", "rate"):
            value = item.get(field)
            if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
                raise ValueError("报价数量或价格格式无效")
            raw = str(value)
            if not _QUOTATION_DECIMAL.fullmatch(raw):
                raise ValueError("报价数量或价格格式无效")
            try:
                number = Decimal(raw)
            except InvalidOperation:
                raise ValueError("报价数量或价格格式无效") from None
            if not number.is_finite() or (field == "qty" and number <= 0) or (field == "rate" and number < 0):
                raise ValueError("报价数量或价格范围无效")
            normalized[field] = format(number.normalize(), "f")
        normalized_items.append(normalized)
    result["items"] = normalized_items
    return result


_QUOTATION_RECORD_FIELDS = frozenset({
    "name", "modified", "docstatus", "company", "quotation_to", "party_name",
    "transaction_date", "valid_till", "currency", "total_qty", "total", "grand_total",
})
_QUOTATION_ITEM_FIELDS = frozenset({
    "item_code", "item_name", "qty", "uom", "rate", "amount", "description",
})


def normalize_quotation_record(payload: Any, instance_id: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("ERPNext 报价响应格式无效")
    if payload.get("doctype") not in (None, "Quotation"):
        raise ValueError("ERPNext 报价响应格式无效")
    source = payload.get("data", payload)
    if not isinstance(source, dict):
        raise ValueError("ERPNext 报价响应格式无效")
    data: dict[str, Any] = {}
    for key in _QUOTATION_RECORD_FIELDS:
        value = source.get(key)
        if key == "docstatus":
            if type(value) is not int or value not in (0, 1, 2):
                raise ValueError("ERPNext 报价状态格式无效")
            data[key] = value
        elif key in {"name", "modified"}:
            if not isinstance(value, str) or not value or len(value) > 255 or any(ord(ch) < 32 for ch in value):
                raise ValueError("ERPNext 报价标识格式无效")
            data[key] = value
        elif value is not None and isinstance(value, (str, int, float, bool)):
            if isinstance(value, str) and len(value) > 4096:
                raise ValueError("ERPNext 报价响应字段过长")
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError("ERPNext 报价响应格式无效")
            data[key] = value
    if data.get("quotation_to") != "Customer" or not all(data.get(key) for key in ("name", "modified", "company", "party_name", "transaction_date", "currency")):
        raise ValueError("ERPNext 报价响应格式无效")
    children = source.get("items", [])
    if not isinstance(children, list):
        raise ValueError("ERPNext 报价明细响应格式无效")
    data_items = []
    for row in children[:MAX_QUOTATION_ITEMS]:
        if not isinstance(row, dict):
            raise ValueError("ERPNext 报价明细响应格式无效")
        clean_row: dict[str, Any] = {}
        for key, value in row.items():
            if key in _QUOTATION_ITEM_FIELDS and (value is None or isinstance(value, (str, int, float, bool))):
                if isinstance(value, str) and len(value) > 4096:
                    raise ValueError("ERPNext 报价明细字段过长")
                if not isinstance(value, float) or math.isfinite(value):
                    clean_row[key] = value
        data_items.append(clean_row)
    data["items"] = data_items
    result = {
        "doctype": "Quotation",
        "data": data,
        "external_ref": external_reference(instance_id, "Quotation", data),
        "truncated_children": ["items"] if len(children) > MAX_QUOTATION_ITEMS else [],
    }
    return result
