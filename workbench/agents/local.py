from __future__ import annotations

from .contracts import AgentRequest, AgentResult, PendingItem


class LocalProductProfileExecutor:
    def execute(self, request: AgentRequest) -> AgentResult:
        products = request.payload.get("products", [])
        pending = [
            PendingItem(
                product_id=str(product.get("id", "")),
                sku=str(product.get("sku", "")),
                missing_fields=[
                    str(item) for item in product.get("missing_fields", [])
                ],
            )
            for product in products
            if product.get("missing_fields")
        ]
        return AgentResult(
            status="needs_confirmation" if pending else "succeeded",
            output={
                "product_count": len(products),
                "pending_count": len(pending),
                "execution_mode": "local_demo",
            },
            pending_items=pending,
        )
