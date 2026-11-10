from __future__ import annotations

from dataclasses import dataclass

from .contracts import (
    AgentCapability,
    AgentExecutor,
    AgentRequest,
    AgentResult,
)
from .local import LocalProductProfileExecutor
from .center import CenterAgent
from .delivery_agent import DeliveryQualityAgent
from .placeholders import MarketCustomerPlaceholder, QuotationPlaceholder
from .product_agent import ProductAgent
from .workflow_contracts import UnknownWorkflowRole


class CapabilityUnavailableError(Exception):
    def __init__(self, capability: AgentCapability) -> None:
        super().__init__(
            f"能力「{capability.name}」尚未接入，当前只保留接口与能力描述。"
        )
        self.capability = capability


class UnknownCapabilityError(Exception):
    pass


@dataclass
class _Registration:
    capability: AgentCapability
    executor: AgentExecutor | None = None


class AgentRegistry:
    def __init__(self) -> None:
        self._items: dict[str, _Registration] = {}

    def register(
        self,
        capability: AgentCapability,
        executor: AgentExecutor | None = None,
    ) -> None:
        self._items[capability.id] = _Registration(capability, executor)

    def capabilities(self) -> list[AgentCapability]:
        return [item.capability for item in self._items.values()]

    def dispatch(self, request: AgentRequest) -> AgentResult:
        registration = self._items.get(request.capability_id)
        if registration is None:
            raise UnknownCapabilityError(request.capability_id)
        if registration.executor is None:
            raise CapabilityUnavailableError(registration.capability)
        return registration.executor.execute(request)


def build_default_registry() -> AgentRegistry:
    registry = AgentRegistry()
    registry.register(
        AgentCapability(
            id="product_profile",
            name="产品资料整理",
            description="归一产品资料，按文件名与货号精确匹配图片，并列出待确认项。",
            implemented=True,
        ),
        LocalProductProfileExecutor(),
    )
    registry.register(
        AgentCapability(
            id="quotation",
            name="询报价",
            description="未来接入报价依据与区间整理；当前没有真实数据和执行器。",
            implemented=False,
        )
    )
    registry.register(
        AgentCapability(
            id="catalog_package",
            name="目录备样",
            description="未来接入目录与备样文件生成；当前没有印刷执行器。",
            implemented=False,
        )
    )
    return registry


class WorkflowRoleRegistry:
    """Closed registry for workflow roles; separate from legacy capabilities."""

    def __init__(self) -> None:
        self._items: dict[str, object] = {}

    def register(self, role: object) -> None:
        self._items[role.role_id] = role

    def get(self, role_id: str) -> object:
        role = self._items.get(role_id)
        if role is None:
            raise UnknownWorkflowRole(
                f"未知工作流角色：{role_id}",
                role_id=role_id,
            )
        return role

    def role_ids(self) -> list[str]:
        return list(self._items)


def build_workflow_role_registry() -> WorkflowRoleRegistry:
    registry = WorkflowRoleRegistry()
    for role in (
        CenterAgent(),
        ProductAgent(),
        DeliveryQualityAgent(),
        MarketCustomerPlaceholder(),
        QuotationPlaceholder(),
    ):
        registry.register(role)
    return registry
