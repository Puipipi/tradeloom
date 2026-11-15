from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping

from .catalog import CATALOG_SOURCE, CATALOG_VERSION, MaterialItem
from .resolver import Resolution, normalize_reference, resolve_reference


BLOCKING = "blocking"
CONFIRM = "confirm"
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?\Z")


@dataclass(frozen=True)
class MaterialIssue:
    issue_key: str
    item_ref: str
    question: str
    severity: str
    detail: dict[str, Any]
    options: tuple[dict[str, Any], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "issue_key": self.issue_key,
            "item_ref": self.item_ref,
            "question": self.question,
            "severity": self.severity,
            "detail": dict(self.detail),
            "options": [dict(option) for option in self.options],
        }


@dataclass(frozen=True)
class LineCheck:
    ref: str
    resolution: Resolution
    issues: tuple[MaterialIssue, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ref": self.ref,
            "resolution": self.resolution.to_dict(),
            "issues": [issue.to_dict() for issue in self.issues],
        }


def _issue(
    issue_key: str,
    item_ref: str,
    question: str,
    severity: str,
    detail: dict[str, Any],
    options: Iterable[MaterialItem] = (),
) -> MaterialIssue:
    return MaterialIssue(
        issue_key=issue_key,
        item_ref=item_ref,
        question=question,
        severity=severity,
        detail=detail,
        options=tuple(
            {"item_code": item.item_code, "item_name": item.item_name, "disabled": item.disabled}
            for item in options
        ),
    )


def _quantity_issues(quantity: Any, item_ref: str) -> list[MaterialIssue]:
    if quantity is None:
        return [_issue("missing_quantity", item_ref, "请补充物料数量。", CONFIRM, {"quantity": None})]
    if not isinstance(quantity, str) or not _DECIMAL.fullmatch(quantity):
        return [_issue("invalid_quantity", item_ref, "数量格式无效，请填写非负十进制数。", BLOCKING,
                       {"quantity": quantity if isinstance(quantity, str) else str(quantity)})]
    try:
        number = Decimal(quantity)
    except InvalidOperation:
        return [_issue("invalid_quantity", item_ref, "数量格式无效，请填写非负十进制数。", BLOCKING,
                       {"quantity": quantity})]
    if not number.is_finite() or number <= 0:
        return [_issue("quantity_not_positive", item_ref, "数量必须大于 0。", BLOCKING, {"quantity": quantity})]
    return []


def evaluate_line(
    *,
    ref: str,
    reference: Any,
    quantity: Any = None,
    unit: Any = None,
    items: Iterable[MaterialItem] | None = None,
) -> LineCheck:
    """核对单行物料引用；只返回问题，不修改任何数据。"""
    resolution = resolve_reference(reference, items=items)
    issues: list[MaterialIssue] = []

    if resolution.status == "resolved":
        item = resolution.item
        assert item is not None
        if item.disabled:
            issues.append(_issue(
                "disabled_item", ref, "该物料已停用，请确认是否改用其他物料。", BLOCKING,
                {"item_code": item.item_code, "item_name": item.item_name},
            ))
        if isinstance(unit, str) and unit.strip() and normalize_reference(unit) != normalize_reference(item.stock_uom):
            issues.append(_issue(
                "unit_mismatch", ref, "单位与物料主数据不一致，请确认换算关系。", CONFIRM,
                {"unit": unit, "stock_uom": item.stock_uom, "item_code": item.item_code},
            ))
    elif resolution.status == "ambiguous":
        issues.append(_issue(
            "ambiguous_item", ref, "物料引用命中多个物料，请人工指定唯一物料。", BLOCKING,
            {"query": resolution.query}, resolution.candidates,
        ))
    elif resolution.reason == "empty":
        issues.append(_issue(
            "missing_item", ref, "请填写物料引用（物料编码或名称）。", CONFIRM, {"query": resolution.query},
        ))
    elif resolution.reason in {"invalid_reference", "unsupported_doctype"}:
        issues.append(_issue(
            "invalid_item_reference", ref, "物料引用格式无效，需要 Item 类型的名称引用。", BLOCKING,
            {"query": resolution.query, "reason": resolution.reason},
        ))
    else:
        issues.append(_issue(
            "unknown_item", ref, "物料引用在物料主数据中不存在，请确认编码或补充主数据。", BLOCKING,
            {"query": resolution.query}, resolution.candidates,
        ))

    issues.extend(_quantity_issues(quantity, ref))
    return LineCheck(ref=ref, resolution=resolution, issues=tuple(issues))


def evaluate_lines(
    lines: Iterable[Mapping[str, Any]],
    *,
    prefix: str = "line",
    items: Iterable[MaterialItem] | None = None,
) -> list[LineCheck]:
    results = []
    for index, line in enumerate(lines, start=1):
        reference = line.get("item") if line.get("item") is not None else line.get("description")
        ref = line.get("ref") if isinstance(line.get("ref"), str) and line.get("ref").strip() else f"{prefix}:{index}"
        results.append(evaluate_line(
            ref=ref, reference=reference, quantity=line.get("quantity"), unit=line.get("unit"), items=items,
        ))
    return results


def check_requirement(
    fields: Mapping[str, Any],
    *,
    ref: str = "requirement",
    items: Iterable[MaterialItem] | None = None,
) -> LineCheck:
    """按生产要求字段核对 item_ref；字段结构见 workbench/requirements/schemas.py。"""
    return evaluate_line(
        ref=ref, reference=fields.get("item_ref"), quantity=fields.get("quantity"), unit=fields.get("unit"),
        items=items,
    )


def material_check(fields: Mapping[str, Any], *, ref: str = "requirement") -> dict[str, Any]:
    """把核对结果压成与 source_arithmetic_check 同级的只读状态。"""
    line = check_requirement(fields if isinstance(fields, dict) else {}, ref=ref)
    blocking = [issue for issue in line.issues if issue.severity == BLOCKING]
    if blocking:
        state = "blocked"
    elif line.issues:
        state = "needs_confirmation"
    else:
        state = "passed"
    return {
        "state": state,
        "source": CATALOG_SOURCE,
        "version": CATALOG_VERSION,
        "resolution": line.resolution.to_dict(),
        "issues": [issue.to_dict() for issue in line.issues],
    }

