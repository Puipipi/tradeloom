from __future__ import annotations

import re
from typing import Any

from django.db import IntegrityError, transaction

from workbench.materials.catalog import MaterialItem
from workbench.models import MaterialItem as MaterialItemRow


ITEM_CODE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.\-/]{0,139}\Z")
MAX_ALIASES = 10
MAX_ALIAS_CHARS = 80


class MaterialStoreError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422) -> None:
        self.code = code
        self.status = status
        super().__init__(message)


def _clean_aliases(aliases: Any) -> list[str]:
    if aliases is None:
        return []
    if (not isinstance(aliases, list) or len(aliases) > MAX_ALIASES or
            any(not isinstance(a, str) or not a.strip() or len(a) > MAX_ALIAS_CHARS for a in aliases)):
        raise MaterialStoreError("invalid_aliases", "aliases 必须是 ≤10 个非空短字符串")
    normalized = [a.strip() for a in aliases]
    if len(set(normalized)) != len(normalized):
        raise MaterialStoreError("invalid_aliases", "aliases 不能重复")
    return normalized


def load_items() -> tuple[MaterialItem, ...]:
    """读取物料主数据为纯目录快照；解析与规则层保持无 DB 依赖。"""
    return tuple(
        MaterialItem(
            item_code=row.item_code,
            item_name=row.item_name,
            item_group=row.item_group,
            stock_uom=row.stock_uom,
            aliases=tuple(row.aliases or ()),
            disabled=row.disabled,
        )
        for row in MaterialItemRow.objects.all()
    )


def item_summary(row: MaterialItemRow) -> dict[str, Any]:
    return {
        "item_code": row.item_code,
        "item_name": row.item_name,
        "item_group": row.item_group,
        "stock_uom": row.stock_uom,
        "aliases": list(row.aliases or ()),
        "disabled": row.disabled,
        "source": row.source,
    }


@transaction.atomic
def create_item(*, item_code: str, item_name: str, item_group: str, stock_uom: str,
                aliases: Any = None, source: str = "manual") -> MaterialItemRow:
    if not isinstance(item_code, str) or not ITEM_CODE.fullmatch(item_code.strip()):
        raise MaterialStoreError("invalid_item_code", "item_code 格式无效")
    item_code = item_code.strip()
    if (not isinstance(item_name, str) or not item_name.strip() or len(item_name) > 200 or
            not isinstance(item_group, str) or not item_group.strip() or len(item_group) > 120 or
            not isinstance(stock_uom, str) or not stock_uom.strip() or len(stock_uom) > 64):
        raise MaterialStoreError("invalid_item_fields", "item_name/item_group/stock_uom 必填且长度受限")
    clean_aliases = _clean_aliases(aliases)
    try:
        return MaterialItemRow.objects.create(
            item_code=item_code, item_name=item_name.strip(), item_group=item_group.strip(),
            stock_uom=stock_uom.strip(), aliases=clean_aliases, source=source,
        )
    except IntegrityError:
        raise MaterialStoreError("item_exists", "item_code 已存在", status=409) from None


@transaction.atomic
def update_item(item_code: str, *, patch: dict[str, Any]) -> MaterialItemRow:
    row = MaterialItemRow.objects.select_for_update().filter(item_code=item_code).first()
    if row is None:
        raise MaterialStoreError("item_not_found", "物料不存在", status=404)
    if set(patch) - {"item_name", "item_group", "stock_uom", "aliases", "disabled"}:
        raise MaterialStoreError("invalid_item_fields", "包含不支持的字段")
    if "item_name" in patch:
        value = patch["item_name"]
        if not isinstance(value, str) or not value.strip() or len(value) > 200:
            raise MaterialStoreError("invalid_item_fields", "item_name 必填且长度受限")
        row.item_name = value.strip()
    if "item_group" in patch:
        value = patch["item_group"]
        if not isinstance(value, str) or not value.strip() or len(value) > 120:
            raise MaterialStoreError("invalid_item_fields", "item_group 必填且长度受限")
        row.item_group = value.strip()
    if "stock_uom" in patch:
        value = patch["stock_uom"]
        if not isinstance(value, str) or not value.strip() or len(value) > 64:
            raise MaterialStoreError("invalid_item_fields", "stock_uom 必填且长度受限")
        row.stock_uom = value.strip()
    if "aliases" in patch:
        row.aliases = _clean_aliases(patch["aliases"])
    if "disabled" in patch:
        if not isinstance(patch["disabled"], bool):
            raise MaterialStoreError("invalid_item_fields", "disabled 必须是布尔值")
        row.disabled = patch["disabled"]
    row.save()
    return row
