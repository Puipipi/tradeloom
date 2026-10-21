from __future__ import annotations

import json
from typing import Any

from jsonschema import Draft202012Validator


def validate_json_contract(value: Any, schema: dict[str, Any]) -> None:
    """Validate strict JSON data against a Draft 2020-12 schema."""
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if json.loads(encoded) != value:
        raise ValueError
    Draft202012Validator.check_schema(schema)
    if not Draft202012Validator(schema).is_valid(value):
        raise ValueError
