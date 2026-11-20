from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Iterable

from .catalog import MaterialItem, material_items


MAX_SUGGESTIONS = 5
_WHITESPACE = re.compile(r"\s+")
_MATCH_PRIORITY = {"item_code": 0, "alias": 1, "item_name": 2}


def normalize_reference(value: str) -> str:
    """NFKC + 去空白 + casefold：兼容全角字符、大小写与录入空格。"""
    return _WHITESPACE.sub("", unicodedata.normalize("NFKC", value)).casefold()


@dataclass(frozen=True)
class Resolution:
    query: str
    status: str  # resolved | ambiguous | unresolved
    match: str | None  # item_code | alias | item_name
    item: MaterialItem | None
    candidates: tuple[MaterialItem, ...]
    reason: str | None  # empty | invalid_reference | unsupported_doctype | not_found | ambiguous

    def to_dict(self) -> dict[str, Any]:
        return {
            "query": self.query,
            "status": self.status,
            "match": self.match,
            "item": _item_summary(self.item) if self.item else None,
            "candidates": [_item_summary(item) for item in self.candidates],
            "reason": self.reason,
        }


def _item_summary(item: MaterialItem) -> dict[str, Any]:
    return {
        "item_code": item.item_code,
        "item_name": item.item_name,
        "item_group": item.item_group,
        "stock_uom": item.stock_uom,
        "disabled": item.disabled,
    }


def _reference_text(value: Any) -> tuple[str, str | None]:
    """把录入值转成待解析文本；返回 (文本, 错误原因)。"""
    if value is None:
        return "", None
    if isinstance(value, dict):
        if value.get("doctype") != "Item":
            return "", "unsupported_doctype"
        name = value.get("name")
        return (name, None) if isinstance(name, str) else ("", "invalid_reference")
    if isinstance(value, str):
        return value, None
    return "", "invalid_reference"


def resolve_reference(value: Any, *, items: Iterable[MaterialItem] | None = None) -> Resolution:
    catalog = tuple(items) if items is not None else material_items()
    text, error = _reference_text(value)
    if error is not None:
        return Resolution("", "unresolved", None, None, (), error)
    key = normalize_reference(text)
    if not key:
        return Resolution(text, "unresolved", None, None, (), "empty")

    # 只接受完全匹配；前缀或包含匹配一律留给人工，避免把猜测当成已识别。
    hits: list[tuple[int, str, MaterialItem]] = []
    for item in catalog:
        kinds = []
        if normalize_reference(item.item_code) == key:
            kinds.append("item_code")
        if any(normalize_reference(alias) == key for alias in item.aliases):
            kinds.append("alias")
        if normalize_reference(item.item_name) == key:
            kinds.append("item_name")
        if kinds:
            best = min(kinds, key=lambda kind: _MATCH_PRIORITY[kind])
            hits.append((_MATCH_PRIORITY[best], item.item_code, item))
    hits.sort(key=lambda hit: (hit[0], hit[1]))
    if len(hits) == 1:
        kind = ("item_code", "alias", "item_name")[hits[0][0]]
        return Resolution(text, "resolved", kind, hits[0][2], (), None)
    if len(hits) > 1:
        return Resolution(text, "ambiguous", None, None, tuple(hit[2] for hit in hits), "ambiguous")

    suggestions = _suggestions(key, catalog)
    if len(suggestions) > 1:
        return Resolution(text, "ambiguous", None, None, suggestions, "ambiguous")
    return Resolution(text, "unresolved", None, None, suggestions, "not_found")


def _suggestions(key: str, catalog: tuple[MaterialItem, ...]) -> tuple[MaterialItem, ...]:
    matched = []
    for item in catalog:
        names = (item.item_name, *item.aliases)
        if any(key in normalize_reference(name) or normalize_reference(name) in key for name in names):
            matched.append(item)
    matched.sort(key=lambda item: item.item_code)
    return tuple(matched[:MAX_SUGGESTIONS])
