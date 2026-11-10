"""Read-only adapter for a configured ERPNext instance."""

from .client import ErpNextClient, ErpNextConfig, ErpNextError
from .dto import ErpNextPage, ErpNextRecord
from .service import SUPPORTED_DOCTYPES

__all__ = [
    "ErpNextClient",
    "ErpNextConfig",
    "ErpNextError",
    "ErpNextPage",
    "ErpNextRecord",
    "SUPPORTED_DOCTYPES",
]
