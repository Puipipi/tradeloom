from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class InputRef:
    file_id: str
    kind: str
    name: str
    url: str | None = None


@dataclass(frozen=True)
class ArtifactRef:
    kind: str
    name: str
    url: str | None = None


@dataclass(frozen=True)
class PendingItem:
    product_id: str
    sku: str
    missing_fields: list[str]


@dataclass(frozen=True)
class AgentRequest:
    task_id: str
    capability_id: str
    input_refs: list[InputRef] = field(default_factory=list)
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentResult:
    status: str
    output: dict[str, Any] = field(default_factory=dict)
    pending_items: list[PendingItem] = field(default_factory=list)
    artifact_refs: list[ArtifactRef] = field(default_factory=list)


class AgentExecutor(Protocol):
    def execute(self, request: AgentRequest) -> AgentResult: ...


@dataclass(frozen=True)
class AgentCapability:
    id: str
    name: str
    description: str
    implemented: bool
