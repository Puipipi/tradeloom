from __future__ import annotations

from decimal import Decimal, InvalidOperation


def _decimal(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        return None
    return parsed if parsed.is_finite() else None


def source_arithmetic_check(fields: dict) -> dict:
    """Show Q/P whole packages and remainder without inferring unit conversion."""
    quantity = _decimal(fields.get("quantity"))
    per_package = _decimal(fields.get("pack_quantity"))
    carton_count = _decimal(fields.get("carton_count"))
    carton_text = format(carton_count, "f") if carton_count is not None else None
    if quantity is None or per_package is None or quantity < 0 or per_package <= 0:
        return {"state": "not_calculated", "whole_packages": None, "remainder": None,
                "source_carton_count": carton_text}
    whole = quantity // per_package
    remainder = quantity % per_package
    return {"state": "calculated", "whole_packages": format(whole, "f"),
            "remainder": format(remainder, "f"), "source_carton_count": carton_text}


def packaging_check(revision) -> str:
    fields = revision.fields if isinstance(revision.fields, dict) else {}
    if revision.status != "confirmed":
        return "needs_confirmation"
    confirmed_pair = revision.confirmed_unit_pair
    if not isinstance(confirmed_pair, dict) or set(confirmed_pair) != {"unit", "pack_unit"}:
        return "needs_confirmation"
    if (not fields.get("unit") or not fields.get("pack_unit") or
            confirmed_pair != {"unit": fields.get("unit"), "pack_unit": fields.get("pack_unit")}):
        return "needs_confirmation"
    if revision.unresolved_fields:
        return "needs_confirmation"
    result = source_arithmetic_check(fields)
    if result["state"] != "calculated" or result["source_carton_count"] is None:
        return "needs_confirmation"
    if (_decimal(result["remainder"]) != Decimal(0) or
            _decimal(result["whole_packages"]) != _decimal(result["source_carton_count"])):
        return "needs_confirmation"
    return "passed"
