from __future__ import annotations

import re
from copy import deepcopy
from django.db import IntegrityError, transaction
from django.utils import timezone

from workbench.models import (
    IntakeCandidate,
    IntakeOperationReceipt,
    Product,
    ProductRevision,
    Task,
)
from workbench.services import FIELD_LABELS

from .mapping import fingerprint
from .schemas import SCHEMA_VERSION


PRODUCT_FIELDS = {"sku", "name", "category", "material", "size", "color"}
FIELD_LIMITS = {
    "sku": 120,
    "name": 200,
    "category": 120,
    "material": 200,
    "size": 120,
    "color": 120,
}
ACTOR = "local_workbench"
OPAQUE_ID = re.compile(r"[a-f0-9]{32}\Z")


class ProductApplicationError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _validate_request(candidate_id: str, body: object) -> tuple[dict, str]:
    if not isinstance(body, dict) or set(body) != {
        "source_sha256", "mapping_id", "mapping_revision", "target", "fields"
    }:
        raise ProductApplicationError("invalid_application")
    target = body["target"]
    fields = body["fields"]
    if (not isinstance(target, dict) or set(target) != {
            "task_id", "product_id", "expected_revision_id"} or
            not isinstance(fields, dict) or not fields or set(fields) - PRODUCT_FIELDS):
        raise ProductApplicationError("invalid_application")
    if (not isinstance(body["source_sha256"], str) or len(body["source_sha256"]) != 64 or
            any(character not in "0123456789abcdef" for character in body["source_sha256"]) or
            not isinstance(body["mapping_id"], str) or not OPAQUE_ID.fullmatch(body["mapping_id"]) or
            isinstance(body["mapping_revision"], bool) or not isinstance(body["mapping_revision"], int) or
            body["mapping_revision"] < 1 or not isinstance(target["task_id"], str) or
            not OPAQUE_ID.fullmatch(target["task_id"])):
        raise ProductApplicationError("invalid_application")
    if target["product_id"] is not None and (
        not isinstance(target["product_id"], str) or not OPAQUE_ID.fullmatch(target["product_id"])
    ):
        raise ProductApplicationError("invalid_application")
    if target["expected_revision_id"] is not None and (
        not isinstance(target["expected_revision_id"], str) or not OPAQUE_ID.fullmatch(target["expected_revision_id"])
    ):
        raise ProductApplicationError("invalid_application")
    if target["product_id"] is None and target["expected_revision_id"] is not None:
        raise ProductApplicationError("invalid_application")

    for name, item in fields.items():
        if (not isinstance(item, dict) or set(item) != {"value", "source_fields", "note"} or
                not isinstance(item["value"], str) or len(item["value"]) > FIELD_LIMITS[name] or
                not isinstance(item["note"], str) or len(item["note"]) > 1000 or
                not isinstance(item["source_fields"], list) or
                len(item["source_fields"]) > 20 or
                any(not isinstance(value, str) for value in item["source_fields"]) or
                len(set(item["source_fields"])) != len(item["source_fields"])):
            raise ProductApplicationError("invalid_application")
        if not item["source_fields"] and not item["note"].strip():
            raise ProductApplicationError("invalid_application")

    if target["product_id"] is None and any(
        field not in fields or not fields[field]["value"].strip() for field in ("sku", "name")
    ):
        raise ProductApplicationError("required_identity_fields")
    canonical = {
        "action": "product_application", "candidate_id": candidate_id, "request": body,
    }
    return body, fingerprint(canonical)


def _validate_sources(candidate: IntakeCandidate, fields: dict) -> dict:
    if candidate.candidate_type != "product_identity":
        raise ProductApplicationError("unsupported_candidate_type")
    candidate_fields = candidate.typed_payload.get("fields", {})
    provenance = candidate.provenance or {}
    selected_refs = {}
    for product_field, item in fields.items():
        names = item["source_fields"]
        if not names:
            continue
        if any(name not in candidate_fields for name in names):
            raise ProductApplicationError("invalid_application_source")
        if "width" in names and "width_unit" not in names:
            raise ProductApplicationError("incomplete_source_unit")
        if "width_unit" in names and "width" not in names:
            raise ProductApplicationError("incomplete_source_unit")
        if "roll_length" in names and "roll_length_unit" not in names:
            raise ProductApplicationError("incomplete_source_unit")
        if "roll_length_unit" in names and "roll_length" not in names:
            raise ProductApplicationError("incomplete_source_unit")
        refs = []
        for name in names:
            values = candidate_fields.get(name)
            source_refs = provenance.get(name)
            if not isinstance(values, list) or not values or not isinstance(source_refs, list) or len(values) != len(source_refs):
                raise ProductApplicationError("invalid_application_source")
            for value, source_ref in zip(values, source_refs):
                if (not isinstance(value, dict) or value.get("state") != "present" or
                        value.get("value") is None or
                        (isinstance(value.get("value"), str) and not value["value"].strip()) or
                        not isinstance(source_ref, dict)):
                    raise ProductApplicationError("unresolved_application_source")
                refs.append({"field": name, **source_ref, "value": value["value"],
                             "formula_status": source_ref.get("formula_status", ""),
                             "error_code": source_ref.get("error_code", "")})
        selected_refs[product_field] = refs
    for pair in (("width", "width_unit"), ("roll_length", "roll_length_unit")):
        names = set(name for item in fields.values() for name in item["source_fields"])
        if names.intersection(pair) and not set(pair).issubset(names):
            raise ProductApplicationError("incomplete_source_unit")
        if set(pair).issubset(names):
            for name in pair:
                values = candidate_fields.get(name, [])
                if not values or any(
                    entry.get("state") != "present" or not str(entry.get("value", "")).strip()
                    for entry in values if isinstance(entry, dict)
                ):
                    raise ProductApplicationError("unresolved_application_source")
    return selected_refs


def _claim_receipt(key: str, request_fingerprint: str) -> tuple[IntakeOperationReceipt, bool]:
    try:
        with transaction.atomic():
            receipt = IntakeOperationReceipt.objects.create(
                idempotency_key=key, action="product_application",
                fingerprint=request_fingerprint, actor=ACTOR,
            )
        return receipt, True
    except IntegrityError:
        receipt = IntakeOperationReceipt.objects.select_for_update().filter(idempotency_key=key).first()
        if receipt is None or receipt.action != "product_application" or receipt.fingerprint != request_fingerprint:
            raise ProductApplicationError("idempotency_conflict") from None
        return receipt, False


def _frozen_application(revision: ProductRevision) -> dict:
    value = (revision.source_refs or {}).get("intake_application")
    if not isinstance(value, dict):
        raise ProductApplicationError("application_unavailable")
    return value


def apply_candidate(candidate_id: str, body: dict, key: str) -> tuple[dict, bool]:
    body, request_fingerprint = _validate_request(candidate_id, body)
    target = body["target"]
    product_id = target["product_id"]

    # Read only enough to acquire locks in the shared Task -> Product -> Candidate order.
    task_id = target["task_id"]
    if product_id:
        task_id_for_product = Product.objects.filter(pk=product_id).values_list("task_id", flat=True).first()
        if task_id_for_product is None:
            raise ProductApplicationError("product_not_found")
        if task_id_for_product != task_id:
            raise ProductApplicationError("target_mismatch")

    with transaction.atomic():
        task = Task.objects.select_for_update().filter(pk=task_id).first()
        if task is None:
            raise ProductApplicationError("task_not_found")
        product = None
        if product_id:
            product = Product.objects.select_for_update().filter(pk=product_id, task=task).first()
            if product is None:
                raise ProductApplicationError("product_not_found")
        candidate = IntakeCandidate.objects.select_for_update().select_related(
            "mapping_revision__snapshot__source"
        ).filter(pk=candidate_id).first()
        if candidate is None:
            raise ProductApplicationError("candidate_not_found")

        typed_payload = candidate.typed_payload if isinstance(candidate.typed_payload, dict) else {}
        if (candidate.schema_version != SCHEMA_VERSION or
                candidate.mapping_revision.schema_version != SCHEMA_VERSION or
                typed_payload.get("schema_version") != SCHEMA_VERSION or
                typed_payload.get("candidate_type") != candidate.candidate_type):
            raise ProductApplicationError("unsupported_schema")

        if (candidate.source_sha256 != body["source_sha256"] or
                candidate.mapping_revision_id != body["mapping_id"] or
                candidate.mapping_revision.revision != body["mapping_revision"] or
                candidate.mapping_revision.candidate_type != candidate.candidate_type or
                candidate.mapping_revision.schema_version != candidate.schema_version or
                candidate.mapping_revision.snapshot.status != "ready" or
                candidate.mapping_revision.source_sha256 != candidate.source_sha256 or
                candidate.mapping_revision.snapshot.source.sha256 != candidate.source_sha256):
            raise ProductApplicationError("stale_mapping")
        selected_refs = _validate_sources(candidate, body["fields"])

        receipt, created = _claim_receipt(key, request_fingerprint)
        if not created:
            if receipt.state == IntakeOperationReceipt.State.FAILED:
                raise ProductApplicationError(receipt.error_code or "invalid_application")
            if receipt.state != IntakeOperationReceipt.State.SUCCEEDED:
                return {"status": "pending", "operation_id": receipt.pk}, True
            revision = ProductRevision.objects.filter(pk=receipt.result_id).first()
            if revision is None:
                raise ProductApplicationError("application_unavailable")
            return _frozen_application(revision), False

        identical = ProductRevision.objects.filter(
            source_refs__intake_candidate_id=candidate.pk,
            source_refs__intake_application_fingerprint=request_fingerprint,
        ).order_by("-version").first()
        if identical is not None:
            frozen = _frozen_application(identical)
            receipt.state = IntakeOperationReceipt.State.SUCCEEDED
            receipt.result_type = "product_application"
            receipt.result_id = identical.pk
            receipt.save(update_fields=["state", "result_type", "result_id", "updated_at"])
            return frozen, False

        if product is not None:
            latest = ProductRevision.objects.select_for_update().filter(product=product).order_by("-version").first()
            if (latest.pk if latest else None) != target["expected_revision_id"]:
                raise ProductApplicationError("stale_product")
            previous_snapshot = dict(latest.snapshot) if latest else {
                "sku": product.sku, "name": product.name, "category": product.category,
                "material": product.material, "size": product.size, "color": product.color,
                "image_filename": product.image_filename,
            }
            snapshot = dict(previous_snapshot)
            for name in ("sku", "name", "category", "material", "size", "color", "image_filename"):
                snapshot.setdefault(name, getattr(product, name, ""))
            field_sources = dict(latest.field_sources) if latest else {
                name: "legacy_product" for name in snapshot
            }
            source_refs = dict(latest.source_refs) if latest else {}
            source_refs.pop("intake_application", None)
            version = latest.version + 1 if latest else 1
        else:
            latest = None
            snapshot = {name: "" for name in (
                "sku", "name", "category", "material", "size", "color", "image_filename"
            )}
            field_sources = {}
            source_refs = {"source": "intake", "actor": ACTOR}
            version = 1

        for name, item in body["fields"].items():
            snapshot[name] = item["value"]
            field_sources[name] = (
                f"human_review:intake_candidate:{candidate.pk}"
                if item["source_fields"] else f"human_entry:{ACTOR}"
            )
        if not str(snapshot.get("sku", "")).strip() or not str(snapshot.get("name", "")).strip():
            raise ProductApplicationError("required_identity_fields")

        now = timezone.now()
        if product is None:
            product = Product.objects.create(
                task=task,
                position=(Product.objects.filter(task=task).order_by("-position").values_list("position", flat=True).first() or 0) + 1,
                sku=snapshot["sku"], name=snapshot["name"], category=snapshot["category"],
                material=snapshot["material"], size=snapshot["size"], color=snapshot["color"],
                image_filename="", image_stored_name="", missing_fields=[],
                created_at=now, updated_at=now,
            )
        else:
            for name in body["fields"]:
                setattr(product, name, snapshot[name])
            product.updated_at = now
        product.missing_fields = [label for field, label in FIELD_LABELS.items()
                                  if not str(snapshot.get(field, "")).strip()]
        if not product.image_stored_name:
            product.missing_fields.append("图片")
        product.save()

        for field_name, item in body["fields"].items():
            source_refs.setdefault("intake_fields", {})[field_name] = {
                "kind": "candidate_reference" if item["source_fields"] else "manual_entry",
                "candidate_id": candidate.pk,
                "source_fields": item["source_fields"],
                "sources": selected_refs.get(field_name, []),
                "confirmed_value": item["value"], "note": item["note"], "actor": ACTOR,
                "mapping_id": candidate.mapping_revision_id,
                "mapping_revision": candidate.mapping_revision.revision,
                "snapshot_id": candidate.mapping_revision.snapshot_id,
                "source_sha256": candidate.source_sha256,
            }
        source_refs.update({
            "source": "intake",
            "prior_source": latest.source_refs.get("source") if latest else None,
            "prior_revision_id": latest.pk if latest else None,
            "intake_candidate_id": candidate.pk,
            "intake_mapping_id": candidate.mapping_revision_id,
            "intake_mapping_revision": candidate.mapping_revision.revision,
            "intake_snapshot_id": candidate.mapping_revision.snapshot_id,
            "intake_source_sha256": candidate.source_sha256,
            "intake_application_fingerprint": request_fingerprint,
            "actor": ACTOR,
        })
        revision = ProductRevision.objects.create(
            product=product, version=version, snapshot=snapshot,
            field_sources=field_sources, status="needs_review", source_refs=source_refs,
            reviewer="",
        )
        application = {
            "candidate_id": candidate.pk, "product_id": product.pk,
            "revision_id": revision.pk, "version": revision.version,
            "status": revision.status, "missing_fields": list(product.missing_fields),
            "source_refs": {"intake_fields": deepcopy({
                field_name: source_refs["intake_fields"][field_name]
                for field_name in body["fields"]
            })},
        }
        source_refs["intake_application"] = application
        revision.source_refs = source_refs
        revision.save(update_fields=["source_refs", "updated_at"])

        if task.status == "confirmed":
            task.status = "awaiting_confirmation"
            task.updated_at = now
            task.save(update_fields=["status", "updated_at"])
        receipt.state = IntakeOperationReceipt.State.SUCCEEDED
        receipt.result_type = "product_application"
        receipt.result_id = revision.pk
        receipt.error_code = ""
        receipt.save(update_fields=["state", "result_type", "result_id", "error_code", "updated_at"])
        return application, True
