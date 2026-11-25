"""机型主数据的读写与校验；行核对通过 load_variants() 拿纯快照，保持无 DB 依赖的规则层。"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from django.db import IntegrityError, transaction

from workbench.models import ProductVariant as ProductVariantRow
from workbench.models import VariantComponent as VariantComponentRow

from .store import ITEM_CODE, MaterialStoreError

VARIANT_CODE = ITEM_CODE
MAX_COMPONENTS = 50
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?\Z")
_ROLES = {"main", "optional"}


class VariantStoreError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422) -> None:
        self.code = code
        self.status = status
        super().__init__(message)


@dataclass(frozen=True)
class VariantComponentRecord:
    position: int
    item_ref: str
    quantity: str
    role: str


@dataclass(frozen=True)
class VariantRecord:
    variant_code: str
    name: str
    disabled: bool
    components: tuple[VariantComponentRecord, ...]


def _clean_components(components: Any) -> list[dict[str, Any]]:
    if not isinstance(components, list) or len(components) > MAX_COMPONENTS:
        raise VariantStoreError("invalid_components", f"components 必须是 ≤{MAX_COMPONENTS} 个的列表")
    normalized = []
    for index, component in enumerate(components):
        if not isinstance(component, dict) or set(component) - {"item_ref", "quantity", "role"} or \
                not {"item_ref", "quantity"}.issubset(component):
            raise VariantStoreError("invalid_components", "组件行只接受 item_ref/quantity/role")
        item_ref = component.get("item_ref")
        quantity = component.get("quantity")
        role = component.get("role", "main")
        if not isinstance(item_ref, str) or not ITEM_CODE.fullmatch(item_ref.strip()):
            raise VariantStoreError("invalid_components", f"第 {index + 1} 行组件 item_ref 格式无效")
        if not isinstance(quantity, str) or not _DECIMAL.fullmatch(quantity) or float(quantity) <= 0:
            raise VariantStoreError("invalid_components", f"第 {index + 1} 行组件数量必须为正数")
        if role not in _ROLES:
            raise VariantStoreError("invalid_components", f"第 {index + 1} 行组件角色只能是 main/optional")
        normalized.append({
            "position": index + 1, "item_ref": item_ref.strip(), "quantity": quantity, "role": role,
        })
    return normalized


def _row_summary(row: ProductVariantRow) -> dict[str, Any]:
    return {
        "variant_code": row.variant_code,
        "name": row.name,
        "disabled": row.disabled,
        "source": row.source,
        "components": [
            {"position": component.position, "item_ref": component.item_ref,
             "quantity": component.quantity, "role": component.role}
            for component in row.components.all()
        ],
    }


def load_variants() -> tuple[VariantRecord, ...]:
    """读取机型主数据为纯快照（含组件），供行核对使用。"""
    records = []
    for row in ProductVariantRow.objects.prefetch_related("components").all():
        records.append(VariantRecord(
            variant_code=row.variant_code,
            name=row.name,
            disabled=row.disabled,
            components=tuple(
                VariantComponentRecord(
                    position=component.position, item_ref=component.item_ref,
                    quantity=component.quantity, role=component.role,
                )
                for component in row.components.all()
            ),
        ))
    return tuple(records)


def resolve_variant(code: Any, variants: tuple[VariantRecord, ...] | None = None) -> VariantRecord | None:
    """按 variant_code 完全匹配解析机型；保守策略，不做前缀/包含匹配。"""
    if not isinstance(code, str):
        return None
    key = " ".join(code.split()).casefold()
    if not key:
        return None
    catalog = tuple(variants) if variants is not None else load_variants()
    for variant in catalog:
        if " ".join(variant.variant_code.split()).casefold() == key:
            return variant
    return None


@transaction.atomic
def create_variant(*, variant_code: str, name: str, components: Any,
                   source: str = "manual") -> ProductVariantRow:
    if not isinstance(variant_code, str) or not VARIANT_CODE.fullmatch(variant_code.strip()):
        raise VariantStoreError("invalid_variant_code", "variant_code 格式无效")
    variant_code = variant_code.strip()
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
        raise VariantStoreError("invalid_variant_fields", "name 必填且长度受限")
    clean_components = _clean_components(components)
    try:
        variant = ProductVariantRow.objects.create(
            variant_code=variant_code, name=name.strip(), source=source,
        )
    except IntegrityError:
        raise VariantStoreError("variant_exists", "variant_code 已存在", status=409) from None
    VariantComponentRow.objects.bulk_create([
        VariantComponentRow(variant=variant, **component) for component in clean_components
    ])
    return variant


@transaction.atomic
def update_variant(variant_code: str, *, patch: dict[str, Any]) -> ProductVariantRow:
    row = ProductVariantRow.objects.select_for_update().filter(variant_code=variant_code).first()
    if row is None:
        raise VariantStoreError("variant_not_found", "机型不存在", status=404)
    if set(patch) - {"name", "disabled", "components"}:
        raise VariantStoreError("invalid_variant_fields", "包含不支持的字段")
    if "name" in patch:
        value = patch["name"]
        if not isinstance(value, str) or not value.strip() or len(value) > 200:
            raise VariantStoreError("invalid_variant_fields", "name 必填且长度受限")
        row.name = value.strip()
    if "disabled" in patch:
        if not isinstance(patch["disabled"], bool):
            raise VariantStoreError("invalid_variant_fields", "disabled 必须是布尔值")
        row.disabled = patch["disabled"]
    row.save(update_fields=["name", "disabled", "updated_at"])
    if "components" in patch:
        clean_components = _clean_components(patch["components"])
        VariantComponentRow.objects.filter(variant=row).delete()
        VariantComponentRow.objects.bulk_create([
            VariantComponentRow(variant=row, **component) for component in clean_components
        ])
    return row


__all__ = [
    "VariantComponentRecord", "VariantRecord", "VariantStoreError",
    "create_variant", "load_variants", "resolve_variant", "update_variant",
]
