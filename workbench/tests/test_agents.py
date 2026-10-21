from django.test import SimpleTestCase

from workbench.agents.contracts import AgentRequest
from workbench.agents.registry import (
    CapabilityUnavailableError,
    build_default_registry,
)


class RegistryTests(SimpleTestCase):
    def test_capabilities_and_unavailable_dispatch(self):
        registry = build_default_registry()
        self.assertEqual(
            [item.id for item in registry.capabilities()],
            ["product_profile", "quotation", "catalog_package"],
        )
        with self.assertRaisesRegex(CapabilityUnavailableError, "尚未接入"):
            registry.dispatch(
                AgentRequest(
                    task_id="task",
                    capability_id="catalog_package",
                )
            )
