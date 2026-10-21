"""Test-only process that exits at delivery generation commit boundaries."""

from __future__ import annotations

import os
import sys


def main() -> None:
    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    django.setup()

    from django.conf import settings
    from workbench.delivery import service
    from workbench.delivery.storage import publish_staging_directory as publish

    expected_name = os.environ.get(
        "EXPECTED_TEST_DATABASE", "tradeloom_test_generation_recovery"
    )
    configured_name = settings.DATABASES["default"]["NAME"]
    if (
        not expected_name.startswith("tradeloom_test_")
        or configured_name != expected_name
    ):
        raise SystemExit("generation recovery worker refused test database identity")

    workflow_id = os.environ["GENERATION_RECOVERY_WORKFLOW_ID"]
    idempotency_key = os.environ["GENERATION_RECOVERY_IDEMPOTENCY_KEY"]
    crash_at = os.environ["GENERATION_RECOVERY_CRASH_AT"]

    if crash_at == "claim_committed":
        service._load_product_images = lambda _source: os._exit(86)
    elif crash_at == "staging_partial":
        def exit_after_partial_write(staging, _data):
            (staging / "partial.marker").write_bytes(b"partial staging retained")
            (staging / "catalog.html").write_bytes(b"incomplete delivery file")
            os._exit(86)
        service.write_staging_files = exit_after_partial_write
    elif crash_at == "published_before_registration":
        def exit_after_publish(staging, final):
            publish(staging, final)
            os._exit(86)
        service.publish_staging_directory = exit_after_publish
    elif crash_at == "registered_before_response":
        service._generation_result = lambda *_args, **_kwargs: os._exit(86)
    else:
        raise SystemExit(f"unknown crash point: {crash_at}")

    service.generate_deliverables(workflow_id, idempotency_key)
    raise SystemExit("requested hard-exit point was not reached")


if __name__ == "__main__":
    main()
