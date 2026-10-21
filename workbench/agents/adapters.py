from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class ImageGenerationAdapter(Protocol):
    def generate(self, request: dict[str, Any]) -> dict[str, Any]: ...


class WebModelBridgeAdapter(Protocol):
    def complete(self, request: dict[str, Any]) -> dict[str, Any]: ...


@dataclass(frozen=True)
class AdapterCapability:
    id: str
    label: str
    status: str
    reason: str

    def public_dict(self) -> dict[str, str]:
        return {
            "id": self.id,
            "label": self.label,
            "status": self.status,
            "reason": self.reason,
        }


class AdapterRegistry:
    """In-process extension seam; adapters are injected, never discovered by I/O."""

    def __init__(
        self,
        *,
        image_generation: ImageGenerationAdapter | None = None,
        web_model_bridge: WebModelBridgeAdapter | None = None,
    ) -> None:
        self.image_generation = image_generation
        self.web_model_bridge = web_model_bridge

    def safe_capabilities(self) -> list[dict[str, str]]:
        return [
            AdapterCapability(
                "image_generation",
                "图像生成",
                "not_configured" if self.image_generation is None else "configured_unverified",
                "未配置外部服务" if self.image_generation is None else "适配器已注册，尚未核验",
            ).public_dict(),
            AdapterCapability(
                "web_model_bridge",
                "网页模型桥",
                "not_configured" if self.web_model_bridge is None else "configured_unverified",
                "未配置外部服务" if self.web_model_bridge is None else "适配器已注册，尚未核验",
            ).public_dict(),
        ]


DEFAULT_ADAPTER_REGISTRY = AdapterRegistry()


def safe_adapter_capabilities() -> list[dict[str, str]]:
    """Return capability metadata only; this default registry performs no I/O."""
    return DEFAULT_ADAPTER_REGISTRY.safe_capabilities()
