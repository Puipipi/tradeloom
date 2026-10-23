from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import subprocess
import urllib.error
import urllib.request
import uuid
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.parse import urlparse

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import LiveServerTestCase, override_settings
from django.test.client import encode_multipart
from openpyxl import Workbook

from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT
from workbench.models import (
    EvidenceRecord,
    ExecutionPlanRevision,
    IntakeCandidate,
    IntakeMappingRevision,
    IntakeOperationReceipt,
    IntakeSourceVersion,
    NarrativeSourceVersion,
    ProductionRequirementDraft,
    ProductionRequirementRevision,
    WorkbookSnapshot,
)
from workbench.requirements.schemas import REQUIREMENT_FIELDS


PRIVATE_HOST = "192.168.56.1:3088"
PRIVATE_ORIGIN = f"http://{PRIVATE_HOST}"


class ExecutionPlanHttpE2ETests(LiveServerTestCase):
    host = "127.0.0.1"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        expected = os.environ.get("TRADELOOM_EXPECTED_TEST_DB_NAME") or os.environ.get("TRADELOOM_DB_TEST_NAME")
        actual = connection.settings_dict["NAME"]
        if not isinstance(expected, str) or not expected.startswith("tradeloom_test_") or actual != expected:
            raise RuntimeError("execution-plan HTTP E2E requires its explicit isolated tradeloom_test_* database")
        for key in ("TRADELOOM_PHASE3_NODE_EXE", "TRADELOOM_DSH_TOOLS_LIBRARY", "TRADELOOM_PHASE3_PRODUCT_ROOT"):
            if not os.environ.get(key):
                raise RuntimeError(f"execution-plan HTTP E2E dependency is missing: {key}")
        cls.expected_test_database = expected

    def setUp(self):
        external_value = os.environ.get("TRADELOOM_PHASE3_HTTP_E2E_ROOT", "")
        if not external_value:
            raise RuntimeError("TRADELOOM_PHASE3_HTTP_E2E_ROOT is required; E2E will not be skipped")
        configured_base = Path(external_value).absolute()
        configured_base.mkdir(parents=True, exist_ok=True)
        self.assert_plain_path(configured_base)
        external_base = configured_base.resolve()
        repository_root = Path(settings.BASE_DIR).resolve()
        if external_base == repository_root or repository_root in external_base.parents or external_base in repository_root.parents:
            raise RuntimeError("HTTP E2E data root must be an external sibling directory, not inside or above the repository")
        self.external_root = external_base / f"run-{uuid.uuid4().hex}"
        self.external_root.mkdir(exist_ok=False)
        self.assert_plain_path(self.external_root)
        self.external_root = self.external_root.resolve()
        if self.external_root.parent != external_base or repository_root in self.external_root.parents:
            raise RuntimeError("HTTP E2E run directory escaped its validated external base")
        self.data_root = self.external_root / "data"
        self.intake_root = self.data_root / "private" / "intake"
        self.media_root = self.external_root / "media"
        self.artifact_root = self.external_root / "artifacts"
        for directory in (self.intake_root, self.media_root, self.artifact_root):
            directory.mkdir(parents=True, exist_ok=False)
        (self.intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        self._settings_override = override_settings(
            TRADELOOM_DATA_ROOT=self.data_root,
            TRADELOOM_INTAKE_ROOT=self.intake_root,
            MEDIA_ROOT=self.media_root,
            TRADELOOM_ARTIFACT_ROOT=self.artifact_root,
            ALLOWED_HOSTS=[PRIVATE_HOST.split(":", 1)[0]],
            CSRF_TRUSTED_ORIGINS=[PRIVATE_ORIGIN],
        )
        self._settings_override.enable()
        self.cookie_jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.cookie_jar)
        )
        self.base_url = self.live_server_url
        self.http("GET", "/agent-center")
        csrf_cookie = next((cookie.value for cookie in self.cookie_jar if cookie.name == "csrftoken"), None)
        if not csrf_cookie:
            raise AssertionError("loopback GET did not issue a CSRF cookie")
        self.csrf_token = csrf_cookie

    @staticmethod
    def assert_plain_path(target: Path):
        current = target
        while True:
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
                raise RuntimeError("HTTP E2E paths cannot contain symlinks or reparse points")
            if current.parent == current:
                break
            current = current.parent

    def tearDown(self):
        self._settings_override.disable()

    def http(self, method: str, path: str, *, body: bytes | None = None,
             content_type: str | None = None, csrf: bool = True, idempotency_key: str | None = None):
        headers = {"Host": PRIVATE_HOST, "Origin": PRIVATE_ORIGIN, "Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        if csrf and method in {"POST", "PUT", "PATCH", "DELETE"} and hasattr(self, "csrf_token"):
            headers["X-CSRFToken"] = self.csrf_token
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(f"{self.base_url}{path}", data=body, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            return error.code, error.read()
        with response:
            return response.status, response.read()

    def post_json(self, path: str, payload: dict, *, csrf: bool = True):
        return self.http("POST", path, body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                         content_type="application/json", csrf=csrf,
                         idempotency_key=f"phase3-{uuid.uuid4().hex}")

    def post_multipart(self, path: str, fields: dict, *, idempotency_key: str):
        boundary = f"phase3-{uuid.uuid4().hex}"
        body = encode_multipart(boundary, fields)
        return self.http("POST", path, body=body,
                         content_type=f"multipart/form-data; boundary={boundary}",
                         idempotency_key=idempotency_key)

    @staticmethod
    def json_body(response):
        return json.loads(response[1].decode("utf-8"))

    @staticmethod
    def synthetic_xlsx():
        workbook = Workbook()
        sheet = workbook.active
        sheet["A1"] = "Synthetic HTTP requirement description"
        sheet["A2"] = 12
        sheet["A3"] = 4
        sheet["A4"] = 3
        sheet["A5"] = "unit-x"
        sheet["A6"] = "pack-x"
        sheet["A7"] = "Synthetic HTTP operator requirement"
        output = io.BytesIO()
        workbook.save(output)
        workbook.close()
        return output.getvalue()

    def row_counts(self):
        return {
            "sources": IntakeSourceVersion.objects.count(),
            "snapshots": WorkbookSnapshot.objects.count(),
            "mappings": IntakeMappingRevision.objects.count(),
            "candidates": IntakeCandidate.objects.count(),
            "drafts": ProductionRequirementDraft.objects.count(),
            "requirements": ProductionRequirementRevision.objects.count(),
            "evidence": EvidenceRecord.objects.count(),
            "narratives": NarrativeSourceVersion.objects.count(),
            "plans": ExecutionPlanRevision.objects.count(),
            "receipts": IntakeOperationReceipt.objects.count(),
        }

    def test_synthetic_public_http_flow_and_registered_tool_handler(self):
        # CSRF rejection is checked over the same public loopback endpoint before the flow begins.
        before_rejected_post = self.row_counts()
        boundary = f"phase3-no-csrf-{uuid.uuid4().hex}"
        rejected_body = encode_multipart(boundary, {"file": SimpleUploadedFile("blocked.xlsx", b"synthetic")})
        no_csrf = self.http("POST", "/api/intake/sources", body=rejected_body,
                            content_type=f"multipart/form-data; boundary={boundary}", csrf=False)
        self.assertEqual(no_csrf[0], 403, no_csrf[1])
        self.assertEqual(self.row_counts(), before_rejected_post)

        source_response = self.post_multipart(
            "/api/intake/sources",
            {"file": SimpleUploadedFile("synthetic-http.xlsx", self.synthetic_xlsx(), "application/octet-stream")},
            idempotency_key=f"phase3-source-{uuid.uuid4().hex}",
        )
        self.assertEqual(source_response[0], 201, source_response[1])
        source = self.json_body(source_response)["source"]
        preview_response = self.post_json(f"/api/intake/sources/{source['id']}/previews", {})
        self.assertEqual(preview_response[0], 201, preview_response[1])
        preview = self.json_body(preview_response)["preview"]
        mapping = {
            "schema_version": 1,
            "candidate_type": "production_instruction",
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "fields": {
                "description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]},
                "quantity": {"cells": [{"sheet_index": 1, "coordinate": "A2"}]},
                "unit": {"cells": [{"sheet_index": 1, "coordinate": "A5"}]},
                "carton_count": {"cells": [{"sheet_index": 1, "coordinate": "A4"}]},
                "requirement_text": {"cells": [{"sheet_index": 1, "coordinate": "A7"}]},
                "pack_quantity": {"cells": [{"sheet_index": 1, "coordinate": "A3"}]},
                "pack_unit": {"cells": [{"sheet_index": 1, "coordinate": "A6"}]},
            },
        }
        mapping_response = self.post_json(f"/api/intake/previews/{preview['id']}/mappings", mapping)
        self.assertEqual(mapping_response[0], 201, mapping_response[1])
        mapped = self.json_body(mapping_response)["mapping"]
        candidate_response = self.post_json(f"/api/intake/mappings/{mapped['id']}/candidates", {})
        self.assertEqual(candidate_response[0], 201, candidate_response[1])
        candidate = self.json_body(candidate_response)["candidate"]
        self.assertEqual(candidate["candidate_type"], "production_instruction")

        draft_response = self.post_json(
            f"/api/intake/candidates/{candidate['id']}/requirement-drafts", {"record_kind": "new_demand"}
        )
        self.assertEqual(draft_response[0], 201, draft_response[1])
        draft = self.json_body(draft_response)["draft"]
        narrative_response = self.post_multipart(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("synthetic-operator.txt", b"Synthetic operator details.\n", "text/plain")},
            idempotency_key=f"phase3-narrative-{uuid.uuid4().hex}",
        )
        self.assertEqual(narrative_response[0], 201, narrative_response[1])
        narrative = self.json_body(narrative_response)["narrative"]
        unresolved = self.json_body(draft_response)["revision"]["unresolved_fields"]
        fields = {}
        field_sources = {}
        for field_key in unresolved:
            field_type = REQUIREMENT_FIELDS[field_key]
            if field_type == "text":
                fields[field_key] = f"Synthetic {field_key}"
            elif field_type == "decimal":
                fields[field_key] = "10"
            elif field_type == "date":
                fields[field_key] = "2026-10-25"
            else:
                fields[field_key] = None
            field_sources[field_key] = [{
                "kind": "operator_statement", "field_key": field_key,
                "narrative_source_id": narrative["id"], "line_start": 1, "line_end": 1,
            }]
        first_revision = self.json_body(draft_response)["revision"]
        all_fields = dict(first_revision["fields"])
        all_fields.update(fields)
        changed_response = self.post_json(
            f"/api/production-requirements/{draft['id']}/revisions",
            {"expected_revision": 1, "fields": fields, "field_sources": field_sources},
        )
        self.assertEqual(changed_response[0], 201, changed_response[1])
        confirm_response = self.post_json(
            f"/api/production-requirements/{draft['id']}/confirm",
            {"expected_revision": 2, "confirmed_unit_pair": {"unit": all_fields["unit"], "pack_unit": all_fields["pack_unit"]}},
        )
        self.assertEqual(confirm_response[0], 201, confirm_response[1])
        confirmed = self.json_body(confirm_response)["revision"]
        self.assertEqual(confirmed["status"], "confirmed")
        description_refs = confirmed["source_refs"]["description"]
        source_evidence = next(ref for ref in description_refs if ref["kind"] == "source_record")
        self.assertEqual((source_evidence["sheet_index"], source_evidence["coordinate"]), (1, "A1"))

        plan_request = {
            "requirement_revision_id": confirmed["id"],
            "expected_revision": 0,
            "requirement_refs": [{"field_key": "description", "evidence_ids": [source_evidence["id"]]}],
            "materials": [{"item_ref": None, "resolution": "unresolved",
                           "proposal": {"description": "Synthetic hand-entered material estimate", "quantity": "0",
                                        "unit": "unit-x", "expected_date": None},
                           "supporting_requirement_inputs": []}],
            "operations": [{"operation_ref": None, "resolution": "unresolved",
                            "proposal": {"description": "Synthetic hand-entered assembly step", "sequence": 1},
                            "supporting_requirement_inputs": []}],
        }
        plan_response = self.post_json(
            f"/api/production-requirements/{draft['id']}/execution-plan-revisions", plan_request
        )
        self.assertEqual(plan_response[0], 201, plan_response[1])
        plan = self.json_body(plan_response)["plan"]
        plan_id = plan["id"]
        self.assertEqual(plan["actual"], {"status": "missing"})
        detail_response = self.http("GET", f"/api/execution-plans/{plan_id}")
        self.assertEqual(detail_response[0], 200, detail_response[1])
        old_detail = self.json_body(detail_response)
        self.assertEqual(old_detail["requirement_revision"]["id"], confirmed["id"])
        self.assertEqual(old_detail["requirement_revision"]["source_refs"]["description"][0]["coordinate"], "A1")

        next_requirement_response = self.post_json(
            f"/api/production-requirements/{draft['id']}/revisions",
            {"expected_revision": 3, "fields": {"description": "Synthetic later revision"}, "field_sources": {}},
        )
        self.assertEqual(next_requirement_response[0], 201, next_requirement_response[1])
        newer = self.json_body(next_requirement_response)["revision"]
        self.assertNotEqual(newer["id"], confirmed["id"])
        reread_response = self.http("GET", f"/api/execution-plans/{plan_id}")
        self.assertEqual(reread_response[0], 200, reread_response[1])
        reread = self.json_body(reread_response)
        self.assertEqual(reread["plan"]["requirement_revision_id"], confirmed["id"])
        self.assertEqual(reread["requirement_revision"]["fields"]["description"], "Synthetic HTTP requirement description")
        self.assertEqual(reread["requirement_revision"]["source_refs"]["description"][0]["coordinate"], "A1")
        self.assertEqual(reread["plan"]["materials"][0]["proposal"]["quantity"], "0")
        self.assertEqual(reread["actual"], {"status": "missing"})
        self.assertEqual(reread["requirement_revision"]["source_refs"]["description"][0]["snapshot_id"], preview["id"])

        before_tools = self.row_counts()
        runner_env = os.environ.copy()
        parsed = urlparse(self.base_url)
        runner_env.update({
            "TRADELOOM_PHASE3_HTTP_PORT": str(parsed.port),
            "TRADELOOM_PHASE3_PRIVATE_HOST": PRIVATE_HOST,
            "TRADELOOM_PHASE3_PRIVATE_ORIGIN": PRIVATE_ORIGIN,
            "TRADELOOM_PHASE3_PLAN_ID": plan_id,
            "TRADELOOM_PHASE3_REQUIREMENT_ID": confirmed["id"],
            "TRADELOOM_PHASE3_DESCRIPTION": "Synthetic HTTP requirement description",
            "TRADELOOM_PHASE3_EVIDENCE_ID": source_evidence["id"],
            "TRADELOOM_PHASE3_SNAPSHOT_ID": preview["id"],
            "TRADELOOM_PHASE3_SHEET_INDEX": "1",
            "TRADELOOM_PHASE3_COORDINATE": "A1",
        })
        node_exe = runner_env["TRADELOOM_PHASE3_NODE_EXE"]
        probe = Path(settings.BASE_DIR) / "packages" / "tradeloom-shell" / "tests" / "fixtures" / "execution-plan-http-tool-probe.mjs"
        command = [node_exe, str(probe)]
        try:
            completed = subprocess.run(command, cwd=settings.BASE_DIR, env=runner_env,
                                       capture_output=True, text=True, timeout=60, check=False)
        except subprocess.TimeoutExpired as exc:
            self.fail(f"ToolRuntime HTTP probe timed out after 60 seconds; stderr={exc.stderr!r}")
        self.assertEqual(completed.returncode, 0, f"probe exit={completed.returncode}; stdout={completed.stdout}; stderr={completed.stderr}")
        proof = json.loads(completed.stdout)
        self.assertTrue(proof["center"]["ok"], proof)
        self.assertTrue(proof["delivery"]["ok"], proof)
        self.assertEqual(proof["product"]["errorCode"], "role_not_authorized")
        self.assertEqual(proof["product"]["requestCount"], 0)
        self.assertEqual(proof["invalidId"]["errorCode"], "invalid_arguments")
        self.assertEqual(proof["invalidId"]["requestCount"], 0)
        self.assertEqual(proof["requestCount"], 2)
        self.assertTrue(all(item == {"method": "GET", "path": f"/api/execution-plans/{plan_id}",
                                    "host": PRIVATE_HOST, "port": parsed.port} for item in proof["requests"]))
        self.assertTrue(proof["renderedEnvelope"])
        self.assertEqual(self.row_counts(), before_tools)

        # Machine-readable evidence contains only synthetic values and fixed observations.
        (self.external_root / "http-tool-proof.json").write_text(json.dumps({
            "planIdSynthetic": bool(plan_id), "requirementIdSynthetic": bool(confirmed["id"]),
            "csrfRejected": no_csrf[0] == 403, "registeredCenterDeliveryReads": proof["requestCount"],
            "productRoleRequests": proof["product"]["requestCount"], "rowCountsUnchangedDuringReads": True,
            "runtimeDependenciesSha256": {
                "node": hashlib.sha256(Path(node_exe).read_bytes()).hexdigest().upper(),
                "toolsLibrary": hashlib.sha256(Path(runner_env["TRADELOOM_DSH_TOOLS_LIBRARY"]).read_bytes()).hexdigest().upper(),
            },
        }, indent=2), encoding="utf-8")
