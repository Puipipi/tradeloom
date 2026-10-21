from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ErpNextRecord:
    doctype: str
    data: dict[str, Any]
    external_ref: dict[str, Any]


@dataclass(frozen=True)
class ErpNextPage:
    doctype: str
    records: tuple[ErpNextRecord, ...]
    next_offset: int | None
