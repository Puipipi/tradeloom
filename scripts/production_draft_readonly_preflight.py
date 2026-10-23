#!/usr/bin/env python3
"""Read-only production requirement source preflight. Never creates a draft."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import ipaddress
import io
import json
import logging
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


EXIT_REVIEW = 2
EXIT_FAILURE = 1
REASON_CODES = {
    "CONFIG_INVALID", "CONFIG_UNAVAILABLE", "DATA_ROOT_MARKER_MISMATCH",
    "DATABASE_CONNECT_FAILED", "DATABASE_READONLY_NOT_ENFORCED", "MAIN_DATABASE_IDENTITY_MISMATCH",
    "DATABASE_MIGRATION_MISMATCH", "API_BASE_NOT_LOOPBACK", "API_GET_FAILED",
    "API_RESPONSE_INVALID", "SOURCE_SELECTION_NOT_UNIQUE", "CANDIDATE_SELECTION_NOT_UNIQUE",
    "SOURCE_CHAIN_MISMATCH", "LOCATOR_INVALID", "SOURCE_HASH_MISMATCH", "DETAIL_MISMATCH",
    "PREFLIGHT_FAILED",
}
ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
SHA_PATTERN = re.compile(r"^[a-f0-9]{64}$")
MARKER_NAME = ".tradeloom-data-root-owned"
MARKER_CONTENT = "tradeloom-app-data-v1"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class PreflightFailure(Exception):
    def __init__(self, code: str):
        self.code = code if code in REASON_CODES else "PREFLIGHT_FAILED"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise PreflightFailure("CONFIG_INVALID") from None


def emit_result(status: str, *, reason: str = "", checks: dict | None = None,
                counts: dict | None = None, gates: dict | None = None) -> dict:
    """Construct the only public output shape; never include source values."""
    if status not in {"review_required", "failed"}:
        status = "failed"
    return {
        "status": status,
        "reason": reason if reason in REASON_CODES else "",
        "checks": checks or {},
        "counts": counts or {},
        "gates": gates or {},
    }


def review_gate(*, candidate_count: int, mapped: int, unresolved: int,
                draft_count: int,
                receipt_states: dict[str, int], candidate_unconfirmed: bool = True,
                mapped_locator_missing: int = 0) -> str:
    if candidate_count != 1:
        return "candidate_missing" if candidate_count == 0 else "candidate_ambiguous"
    if draft_count:
        return "existing_draft_review"
    if not candidate_unconfirmed:
        return "candidate_status_review_required"
    if mapped + unresolved == 0 or unresolved > 0 or mapped_locator_missing > 0:
        return "mapping_review_required"
    if receipt_states.get("reserved", 0):
        return "operation_in_flight_review"
    if any(receipt_states.get(state, 0) for state in ("succeeded", "failed")):
        return "receipt_review_required"
    return "record_kind_review_required"


def source_chain_matches(*, selected_source_id, candidate_type, mapping_type, candidate_mapping_id, mapping_id,
                         mapping_snapshot_id, snapshot_id, snapshot_source_id, source_id,
                         candidate_sha, mapping_sha, source_sha, mapping_payload_source_sha,
                         candidate_schema_version, mapping_schema_version, snapshot_status) -> bool:
    return (candidate_type == "production_instruction" and mapping_type == candidate_type
            and candidate_mapping_id == mapping_id and mapping_snapshot_id == snapshot_id
            and selected_source_id == source_id and snapshot_source_id == source_id and snapshot_status == "ready"
            and candidate_sha == mapping_sha == source_sha == mapping_payload_source_sha
            and candidate_schema_version == mapping_schema_version)


def locator_metadata_matches(locator: object, *, snapshot_id, source_id, source_sha) -> bool:
    return (isinstance(locator, dict) and locator.get("snapshot_id") == snapshot_id
            and locator.get("source_id") == source_id and locator.get("source_sha256") == source_sha
            and type(locator.get("sheet_index")) is int and isinstance(locator.get("coordinate"), str))


def locator_cell_matches(locator: object, *, snapshot_id, source_id, source_sha, cell_exists: bool) -> bool:
    return locator_metadata_matches(locator, snapshot_id=snapshot_id, source_id=source_id,
                                    source_sha=source_sha) and cell_exists is True


def missing_mapped_locator_count(mapped_fields: set[str], fields_with_valid_locators: set[str]) -> int:
    return len(mapped_fields - fields_with_valid_locators)


def readonly_is_enforced(value: object) -> bool:
    return str(value).lower() in {"on", "true", "1"}


def database_identity_matches(actual: tuple, expected: tuple, version_prefix: str) -> bool:
    try:
        address = ipaddress.ip_address(str(actual[2]))
    except ValueError:
        return False
    host_matches = address.is_loopback if expected[2] == "localhost" else str(actual[2]) == expected[2]
    return (actual[0] == expected[0] and actual[1] == expected[1] and host_matches
            and actual[3] == expected[3] and str(actual[4]).startswith(version_prefix))


def validate_config(config: object) -> dict:
    if not isinstance(config, dict):
        raise PreflightFailure("CONFIG_INVALID")
    required = {"data_root", "password_file", "database", "api_base", "api_host_header", "source_sha256", "migration"}
    if set(config) != required:
        raise PreflightFailure("CONFIG_INVALID")
    database = config.get("database")
    if (not isinstance(database, dict) or set(database) != {"name", "user", "host", "port", "server_version_prefix"}
            or not all(isinstance(database[k], (str, int)) for k in database)):
        raise PreflightFailure("CONFIG_INVALID")
    if (database["host"] not in {"127.0.0.1", "localhost"}
            or not isinstance(database["port"], int) or isinstance(database["port"], bool)
            or not 1 <= database["port"] <= 65535
            or not all(isinstance(database[key], str) and database[key]
                       for key in ("name", "user", "server_version_prefix"))):
        raise PreflightFailure("CONFIG_INVALID")
    if not all(isinstance(config.get(key), str) and config[key] for key in ("data_root", "password_file")):
        raise PreflightFailure("CONFIG_INVALID")
    if not SHA_PATTERN.fullmatch(str(config.get("source_sha256", ""))):
        raise PreflightFailure("CONFIG_INVALID")
    base = config.get("api_base")
    parsed = urlsplit(base if isinstance(base, str) else "")
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}):
        raise PreflightFailure("API_BASE_NOT_LOOPBACK")
    host_header = config.get("api_host_header")
    if (not isinstance(host_header, str) or not host_header or len(host_header) > 255
            or any(char in host_header for char in "\r\n/@\\")):
        raise PreflightFailure("CONFIG_INVALID")
    if not isinstance(config.get("migration"), str) or not config["migration"]:
        raise PreflightFailure("CONFIG_INVALID")
    return config


def _safe_json_response(opener, base: str, host_header: str, path: str, query: dict) -> dict:
    url = base.rstrip("/") + path + "?" + urlencode(query)
    request = Request(url, headers={"Accept": "application/json", "Host": host_header}, method="GET")
    try:
        with opener.open(request, timeout=15) as response:
            if response.status != 200:
                raise PreflightFailure("API_GET_FAILED")
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except PreflightFailure:
        raise
    except (HTTPError, URLError, TimeoutError, OSError):
        raise PreflightFailure("API_GET_FAILED") from None
    if len(payload) > MAX_RESPONSE_BYTES:
        raise PreflightFailure("API_RESPONSE_INVALID")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise PreflightFailure("API_RESPONSE_INVALID") from None
    if not isinstance(value, dict) or value.get("ok") is not True:
        raise PreflightFailure("API_RESPONSE_INVALID")
    return value


def _get_all_sources(opener, base: str, host_header: str) -> list[dict]:
    result, offset = [], 0
    while True:
        payload = _safe_json_response(opener, base, host_header, "/api/intake/sources", {"offset": offset, "limit": 100})
        batch = payload.get("sources")
        if not isinstance(batch, list) or any(not isinstance(item, dict) for item in batch):
            raise PreflightFailure("API_RESPONSE_INVALID")
        result.extend(batch)
        next_offset = payload.get("next_offset")
        if next_offset is None:
            return result
        if type(next_offset) is not int or next_offset <= offset:
            raise PreflightFailure("API_RESPONSE_INVALID")
        offset = next_offset


def _get_candidate_pages(opener, base: str, host_header: str, source_id: str) -> list[dict]:
    result, offset = [], 0
    while True:
        payload = _safe_json_response(opener, base, host_header, "/api/intake/candidates", {
            "candidate_type": "production_instruction", "source_id": source_id, "offset": offset, "limit": 100,
        })
        batch = payload.get("candidates")
        if not isinstance(batch, list) or any(not isinstance(item, dict) for item in batch):
            raise PreflightFailure("API_RESPONSE_INVALID")
        result.extend(batch)
        next_offset = payload.get("next_offset")
        if next_offset is None:
            return result
        if type(next_offset) is not int or next_offset <= offset:
            raise PreflightFailure("API_RESPONSE_INVALID")
        offset = next_offset


def _verify_locator_cells(candidate, mapping, snapshot) -> tuple[int, int, int, int]:
    from workbench.intake.schemas import FIELD_SCHEMAS
    from workbench.requirements.service import _valid_locator

    field_schema = FIELD_SCHEMAS["production_instruction"]
    mapping_fields = mapping.mapping.get("fields", {}) if isinstance(mapping.mapping, dict) else {}
    mapped_keys = {key for key in field_schema if isinstance(mapping_fields.get(key), dict)}
    provenance = candidate.provenance if isinstance(candidate.provenance, dict) else {}
    valid = 0
    locator_count = 0
    fields_with_valid_locators = set()
    for key in field_schema:
        locators = provenance.get(key)
        if not isinstance(locators, list):
            continue
        locator_count += len(locators)
        for locator in locators:
            valid_cell = _valid_locator(candidate, key, locator) is not None
            if locator_cell_matches(locator, snapshot_id=snapshot.pk, source_id=snapshot.source_id,
                                    source_sha=candidate.source_sha256, cell_exists=valid_cell):
                valid += 1
                fields_with_valid_locators.add(key)
    missing = missing_mapped_locator_count(mapped_keys, fields_with_valid_locators)
    return len(mapped_keys), locator_count, valid, missing


def _hash_open_source(source_id: str, expected_sha: str) -> bool:
    from workbench.intake.storage import open_source

    digest = hashlib.sha256()
    with open_source(source_id) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == expected_sha


def _run(config: dict) -> tuple[dict, int]:
    config = validate_config(config)
    data_root = Path(config["data_root"])
    marker = data_root / MARKER_NAME
    try:
        if marker.read_text(encoding="utf-8").strip() != MARKER_CONTENT:
            raise PreflightFailure("DATA_ROOT_MARKER_MISMATCH")
        password = Path(config["password_file"]).read_text(encoding="utf-8").rstrip("\r\n")
    except PreflightFailure:
        raise
    except OSError:
        raise PreflightFailure("CONFIG_UNAVAILABLE") from None
    if not password:
        raise PreflightFailure("CONFIG_UNAVAILABLE")

    # Do not inherit libpq selectors. Startup options make every Django
    # connection read-only before its first transaction or ORM statement.
    for key in ("PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE",
                "PGOPTIONS", "PGPASSWORD", "PGSSLMODE"):
        os.environ.pop(key, None)
    db = config["database"]
    os.environ.update({
        "DJANGO_SETTINGS_MODULE": "config.settings",
        "TRADELOOM_DATA_ROOT": str(data_root),
        "TRADELOOM_INTAKE_ROOT": str(data_root / "private" / "intake"),
        "TRADELOOM_DB_NAME": str(db["name"]), "TRADELOOM_DB_USER": str(db["user"]),
        "TRADELOOM_DB_HOST": str(db["host"]), "TRADELOOM_DB_PORT": str(db["port"]),
        "TRADELOOM_DB_PASSWORD": password,
        "PGOPTIONS": "-c default_transaction_read_only=on",
        "TRADELOOM_DEBUG": "0",
    })
    repo_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo_root))
    try:
        import django
        django.setup()
        from django.db import connection
        options = connection.settings_dict.setdefault("OPTIONS", {})
        options["options"] = "-c default_transaction_read_only=on"
        try:
            connection.ensure_connection()
        except Exception:
            raise PreflightFailure("DATABASE_CONNECT_FAILED") from None
        with connection.cursor() as cursor:
            cursor.execute("SHOW transaction_read_only")
            read_only = readonly_is_enforced(cursor.fetchone()[0])
            if not read_only:
                raise PreflightFailure("DATABASE_READONLY_NOT_ENFORCED")
            cursor.execute("SELECT current_database(), current_user, host(inet_server_addr()), inet_server_port(), current_setting('server_version_num')")
            identity = cursor.fetchone()
        expected = (str(db["name"]), str(db["user"]), str(db["host"]), int(db["port"]))
        actual = (str(identity[0]), str(identity[1]), str(identity[2]), int(identity[3]), str(identity[4]))
        if not database_identity_matches(actual, expected, str(db["server_version_prefix"])):
            raise PreflightFailure("MAIN_DATABASE_IDENTITY_MISMATCH")
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM django_migrations WHERE app='workbench' AND name=%s", [config["migration"]])
            migration_present = cursor.fetchone() is not None
        if not migration_present:
            raise PreflightFailure("DATABASE_MIGRATION_MISMATCH")

        from workbench.intake.schemas import FIELD_SCHEMAS
        from workbench.intake.mapping import fingerprint
        from workbench.models import (EvidenceRecord, ExecutionPlanRevision, IntakeCandidate,
                                      IntakeOperationReceipt, ProductionRequirementDraft,
                                      ProductionRequirementRevision)
        from workbench.requirements.service import requirement_result
        counts = {"candidate_count": 0, "mapped_fields": 0, "unresolved_fields": 0,
                  "locator_count": 0, "valid_locator_count": 0, "mapped_field_without_valid_locator": 0,
                  "draft_count": 0,
                  "revision_count": 0, "candidate_evidence_count": 0,
                  "requirement_evidence_count": 0, "execution_plan_revision_count": 0,
                  "receipt_reserved": 0, "receipt_succeeded": 0, "receipt_failed": 0}
        for record_kind in ("new_demand", "historical_reference"):
            for state in ("reserved", "succeeded", "failed"):
                counts[f"receipt_{record_kind}_{state}"] = 0
        checks = {"runner_db_readonly_enforced": True, "main_identity_match": True,
                  "migration_present": True, "api_get_only": True}
        gates = {"record_kind_selection": "not_selected", "record_kind_confirmation": "not_established",
                 "candidate_status": "unknown", "historical_or_reference": "unknown",
                 "mapping_review_required": False, "review_reason": "unknown", "review_required": True}
        base = config["api_base"].rstrip("/")
        opener = build_opener(ProxyHandler({}), NoRedirect())
        host_header = config["api_host_header"]
        sources = _get_all_sources(opener, base, host_header)
        matching_sources = [s for s in sources if s.get("sha256") == config["source_sha256"]]
        if len(matching_sources) != 1:
            raise PreflightFailure("SOURCE_SELECTION_NOT_UNIQUE")
        source_dto = matching_sources[0]
        source_id = source_dto.get("id")
        if not isinstance(source_id, str) or not ID_PATTERN.fullmatch(source_id):
            raise PreflightFailure("API_RESPONSE_INVALID")
        candidates = _get_candidate_pages(opener, base, host_header, source_id)
        counts["candidate_count"] = len(candidates)
        if len(candidates) != 1:
            result = emit_result("review_required", counts=counts, checks=checks,
                                 gates={**gates, "review_reason": "candidate_missing" if not candidates else "candidate_ambiguous"})
            return result, EXIT_REVIEW
        dto = candidates[0]
        candidate_id = dto.get("id")
        if not isinstance(candidate_id, str) or not ID_PATTERN.fullmatch(candidate_id):
            raise PreflightFailure("API_RESPONSE_INVALID")
        candidate = IntakeCandidate.objects.select_related("mapping_revision__snapshot__source").get(pk=candidate_id)
        mapping, snapshot, source = candidate.mapping_revision, candidate.mapping_revision.snapshot, candidate.mapping_revision.snapshot.source
        chain_match = source_chain_matches(
            selected_source_id=source_id,
            candidate_type=candidate.candidate_type, mapping_type=mapping.candidate_type,
            candidate_mapping_id=candidate.mapping_revision_id, mapping_id=mapping.pk,
            mapping_snapshot_id=mapping.snapshot_id, snapshot_id=snapshot.pk,
            snapshot_source_id=snapshot.source_id, source_id=source.pk,
            candidate_sha=candidate.source_sha256, mapping_sha=mapping.source_sha256,
            source_sha=source.sha256,
            mapping_payload_source_sha=mapping.mapping.get("source_sha256") if isinstance(mapping.mapping, dict) else None,
            candidate_schema_version=candidate.schema_version, mapping_schema_version=mapping.schema_version,
            snapshot_status=snapshot.status,
        )
        if not chain_match:
            raise PreflightFailure("SOURCE_CHAIN_MISMATCH")
        checks["mapping_content_sha_match"] = fingerprint(mapping.mapping) == mapping.mapping_sha256
        if not checks["mapping_content_sha_match"]:
            raise PreflightFailure("SOURCE_CHAIN_MISMATCH")
        (counts["mapped_fields"], counts["locator_count"], counts["valid_locator_count"],
         counts["mapped_field_without_valid_locator"]) = _verify_locator_cells(candidate, mapping, snapshot)
        counts["unresolved_fields"] = max(0, len(FIELD_SCHEMAS["production_instruction"]) - counts["mapped_fields"])
        checks.update({"source_chain_match": True, "locator_cells_valid": counts["valid_locator_count"] == counts["locator_count"],
                       "mapped_fields_have_valid_locators": counts["mapped_field_without_valid_locator"] == 0,
                       "source_dto_id_match": source_dto.get("id") == source.pk,
                       "source_dto_sha_match": source_dto.get("sha256") == source.sha256,
                       "source_dto_size_match": source_dto.get("byte_size") == source.byte_size,
                       "open_source_sha_match": _hash_open_source(source.pk, source.sha256)})
        if not all(checks[k] for k in ("source_chain_match", "locator_cells_valid", "mapped_fields_have_valid_locators", "source_dto_id_match",
                                       "source_dto_sha_match", "source_dto_size_match", "open_source_sha_match")):
            if not checks["locator_cells_valid"]:
                raise PreflightFailure("LOCATOR_INVALID")
            if not checks["mapped_fields_have_valid_locators"]:
                raise PreflightFailure("LOCATOR_INVALID")
            raise PreflightFailure("SOURCE_HASH_MISMATCH")
        detail = _safe_json_response(opener, base, host_header, f"/api/intake/candidates/{candidate_id}", {})
        detail_candidate = detail.get("candidate")
        checks["detail_matches_orm"] = isinstance(detail_candidate, dict) and all(
            detail_candidate.get(key) == dto.get(key) == expected_value for key, expected_value in {
                "id": candidate.pk, "mapping_id": mapping.pk, "source_sha256": candidate.source_sha256,
                "candidate_type": candidate.candidate_type, "schema_version": candidate.schema_version,
                "status": candidate.status, "fields": candidate.typed_payload.get("fields"),
                "semantics": candidate.typed_payload.get("semantics"), "provenance": candidate.provenance,
            }.items())
        if not checks["detail_matches_orm"]:
            raise PreflightFailure("DETAIL_MISMATCH")
        draft = ProductionRequirementDraft.objects.filter(source_candidate=candidate).first()
        counts["draft_count"] = ProductionRequirementDraft.objects.filter(source_candidate=candidate).count()
        counts["revision_count"] = ProductionRequirementRevision.objects.filter(draft__source_candidate=candidate).count()
        counts["candidate_evidence_count"] = EvidenceRecord.objects.filter(candidate=candidate).count()
        counts["requirement_evidence_count"] = EvidenceRecord.objects.filter(requirement_revision__draft__source_candidate=candidate).count()
        counts["execution_plan_revision_count"] = ExecutionPlanRevision.objects.filter(requirement_revision__draft__source_candidate=candidate).count()
        draft_get = _safe_json_response(opener, base, host_header,
                                        f"/api/intake/candidates/{candidate_id}/requirement-drafts", {})
        if draft is None:
            checks["draft_get_matches_orm"] = draft_get.get("requirement") is None
        else:
            current_revision = draft.revisions.filter(revision=draft.current_revision).first()
            checks["draft_get_matches_orm"] = (current_revision is not None and
                                                 draft_get.get("requirement") == requirement_result(draft, current_revision))
        if not checks["draft_get_matches_orm"]:
            raise PreflightFailure("DETAIL_MISMATCH")
        from workbench.intake.mapping import fingerprint
        from workbench.models import ProductionRequirementDraft as DraftModel
        fingerprints = {}
        for record_kind in DraftModel.RecordKind.values:
            expected_fingerprint = fingerprint({"action": "requirement_draft", "candidate_id": candidate.pk,
                                                 "record_kind": record_kind, "source_sha256": candidate.source_sha256})
            fingerprints[record_kind] = expected_fingerprint
            for state in ("reserved", "succeeded", "failed"):
                counts[f"receipt_{record_kind}_{state}"] = IntakeOperationReceipt.objects.filter(
                    action="requirement_draft", fingerprint=expected_fingerprint, state=state
                ).count()
        for state in ("reserved", "succeeded", "failed"):
            counts[f"receipt_{state}"] = sum(counts[f"receipt_{kind}_{state}"] for kind in fingerprints)
        if draft is not None and draft.record_kind in DraftModel.RecordKind.values:
            gates["record_kind_selection"] = draft.record_kind
            gates["record_kind_confirmation"] = "unverified_existing_selection"
        gates["candidate_status"] = (candidate.status if candidate.status in {"unconfirmed"} else "unknown")
        semantics = candidate.typed_payload.get("semantics", {})
        historical_state = semantics.get("historical_or_reference") if isinstance(semantics, dict) else None
        gates["historical_or_reference"] = (historical_state if historical_state in {"unconfirmed", "historical_reference", "new_demand"}
                                             else "unknown")
        gates["mapping_review_required"] = (counts["unresolved_fields"] > 0
                                             or counts["mapped_field_without_valid_locator"] > 0)
        gates["review_reason"] = review_gate(
            candidate_count=counts["candidate_count"], mapped=counts["mapped_fields"],
            unresolved=counts["unresolved_fields"],
            draft_count=counts["draft_count"],
            receipt_states={state: counts[f"receipt_{state}"] for state in ("reserved", "succeeded", "failed")},
            candidate_unconfirmed=candidate.status == "unconfirmed",
            mapped_locator_missing=counts["mapped_field_without_valid_locator"],
        )
        gates["review_required"] = True
        return emit_result("review_required", checks=checks, counts=counts, gates=gates), EXIT_REVIEW
    except PreflightFailure:
        raise
    except Exception:
        raise PreflightFailure("PREFLIGHT_FAILED") from None


def main(argv: list[str] | None = None) -> int:
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Path to the private local preflight JSON config")
    try:
        args = parser.parse_args(argv)
    except PreflightFailure as exc:
        print(json.dumps(emit_result("failed", reason=exc.code), separators=(",", ":"), sort_keys=True))
        return EXIT_FAILURE
    except SystemExit as exc:
        return int(exc.code)
    output = io.StringIO()
    try:
        # Suppress Django/library logs and any accidental diagnostic output.
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            logging.disable(logging.CRITICAL)
            config_path = Path(args.config)
            try:
                config_text = config_path.read_text(encoding="utf-8")
            except OSError:
                raise PreflightFailure("CONFIG_UNAVAILABLE") from None
            try:
                config = json.loads(config_text)
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise PreflightFailure("CONFIG_INVALID") from None
            result, exit_code = _run(config)
    except PreflightFailure as exc:
        result, exit_code = emit_result("failed", reason=exc.code), EXIT_FAILURE
    except Exception:
        result, exit_code = emit_result("failed", reason="PREFLIGHT_FAILED"), EXIT_FAILURE
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
