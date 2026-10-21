from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import urllib.error
import urllib.request
import uuid
from http.cookiejar import CookieJar
from html.parser import HTMLParser
from pathlib import Path

from django.conf import settings
from django.db import connection
from django.test import LiveServerTestCase, override_settings
from django.test.client import encode_multipart
from django.core.files.uploadedfile import SimpleUploadedFile

from workbench.models import (
    ArtifactVersion,
    EventLog,
    HumanReview,
    ProductRevision,
    SubTask,
    TaskFile,
    WorkflowStep,
    WorkflowTask,
)


class WorkflowFormParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.forms = []
        self.current = None
        self.current_select = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.current = {"attrs": attrs, "inputs": {}, "options": {}}
        elif self.current is not None and tag == "input" and attrs.get("name"):
            self.current["inputs"].setdefault(attrs["name"], []).append(attrs.get("value", ""))
        elif self.current is not None and tag == "select":
            self.current_select = attrs.get("name", "")
            self.current["options"].setdefault(self.current_select, [])
        elif self.current is not None and tag == "option" and self.current_select:
            value = attrs.get("value")
            if value:
                self.current["options"][self.current_select].append(value)

    def handle_endtag(self, tag):
        if tag == "select":
            self.current_select = None
        elif tag == "form" and self.current is not None:
            self.forms.append(self.current)
            self.current = None


class Phase7WorkflowHttpE2ETests(LiveServerTestCase):
    host = "127.0.0.1"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        expected = os.environ.get("TRADELOOM_EXPECTED_TEST_DB_NAME") or (
            os.environ.get("TRADELOOM_DB_TEST_NAME")
            or settings.DATABASES["default"].get("TEST", {}).get("NAME")
        )
        actual = connection.settings_dict["NAME"]
        if (
            not isinstance(expected, str)
            or not expected.startswith("tradeloom_test_")
            or expected == os.environ.get("TRADELOOM_DB_NAME")
            or actual != expected
        ):
            raise RuntimeError(
                "HTTP E2E requires an explicitly named tradeloom_test_* database; "
                f"active database {actual!r} does not match expected test database {expected!r}."
            )
        cls.expected_test_database = expected

    def setUp(self):
        configured_root = os.environ.get("TRADELOOM_PHASE7_HTTP_E2E_ROOT", "")
        if not configured_root:
            raise RuntimeError("TRADELOOM_PHASE7_HTTP_E2E_ROOT must point outside the repository")
        external_base = Path(configured_root).resolve()
        repository_root = Path(settings.BASE_DIR).resolve()
        if external_base == repository_root or repository_root in external_base.parents:
            raise RuntimeError("HTTP E2E media and artifacts must remain outside the repository")
        external_base.mkdir(parents=True, exist_ok=True)
        self.external_root = external_base / f"run-{uuid.uuid4().hex}"
        self.external_root.mkdir(exist_ok=False)
        self.external_root = self.external_root.resolve()
        if self.external_root.parent != external_base or repository_root in self.external_root.parents:
            raise RuntimeError("HTTP E2E run directory escaped its validated external base")
        media_root = self.external_root / "runtime" / "media"
        artifact_root = self.external_root / "runtime" / "artifacts"
        media_root.mkdir(parents=True, exist_ok=True)
        artifact_root.mkdir(parents=True, exist_ok=True)
        self._settings_override = override_settings(
            MEDIA_ROOT=media_root,
            TRADELOOM_ARTIFACT_ROOT=artifact_root,
        )
        self._settings_override.enable()
        self.cookie_jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(self.cookie_jar),
        )
        self.base_url = self.live_server_url
        self.http("GET", "/agent-center")
        csrf_cookie = next((cookie.value for cookie in self.cookie_jar if cookie.name == "csrftoken"), None)
        if not csrf_cookie:
            raise AssertionError("GET /agent-center did not issue a CSRF cookie")
        self.csrf_token = csrf_cookie

    def tearDown(self):
        self._settings_override.disable()

    def http(self, method: str, path: str, *, body: bytes | None = None, content_type: str | None = None):
        headers = {}
        if content_type:
            headers["Content-Type"] = content_type
        if method in {"POST", "PUT", "PATCH", "DELETE"} and hasattr(self, "csrf_token"):
            headers["X-CSRFToken"] = self.csrf_token
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=body, headers=headers, method=method
        )
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()
        with response:
            return response.status, response.headers, response.read()

    def post_json(self, path: str, payload: dict, *, csrf: bool = True):
        headers = {"Content-Type": "application/json"}
        if csrf:
            headers["X-CSRFToken"] = self.csrf_token
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()
        with response:
            return response.status, response.headers, response.read()

    def multipart(self, path: str, fields: dict):
        boundary = f"phase7-{uuid.uuid4().hex}"
        body = encode_multipart(boundary, fields)
        return self.http(
            "POST", path, body=body, content_type=f"multipart/form-data; boundary={boundary}"
        )

    def json_body(self, response):
        return json.loads(response[2].decode("utf-8"))

    def workflow_page(self, workflow_id: str):
        response = self.http("GET", f"/workflow-tasks/{workflow_id}")
        self.assertEqual(response[0], 200, response[2])
        html = response[2].decode("utf-8")
        parser = WorkflowFormParser()
        parser.feed(html)
        parser.html = html
        return parser

    def form(self, page: WorkflowFormParser, class_name: str):
        found = [
            item
            for item in page.forms
            if class_name in item["attrs"].get("class", "").split()
        ]
        self.assertEqual(len(found), 1, f"expected one {class_name} form; found {len(found)}")
        return found[0]

    def test_complete_workflow_over_real_loopback_http(self):
        # Keep the product facts and image bytes in the external owned workspace.
        csv_file = io.StringIO(newline="")
        writer = csv.writer(csv_file, lineterminator="\n")
        writer.writerow(("sku", "name", "category", "material", "size", "color", "image_filename"))
        writer.writerow(("DEMO-HTTP-01", "演示缎带", "丝带", "涤纶（测试演示）", "25mm × 50m", "酒红", ""))
        csv_bytes = ("\ufeff" + csv_file.getvalue()).encode("utf-8")
        (self.external_root / "products.csv").write_bytes(csv_bytes)
        image_a = b'<svg xmlns="http://www.w3.org/2000/svg"><title>demo image A</title><rect width="4" height="4" fill="red"/></svg>'
        image_b = b'<svg xmlns="http://www.w3.org/2000/svg"><title>demo image B</title><rect width="4" height="4" fill="blue"/></svg>'
        uploaded = self.multipart(
            "/api/tasks",
            {
                "title": "Phase 7 HTTP 演示批次",
                "products_csv": SimpleUploadedFile("phase7-demo.csv", csv_bytes, content_type="text/csv"),
                "images": [
                    SimpleUploadedFile("DEMO-HTTP-01.svg", image_a, content_type="image/svg+xml"),
                    SimpleUploadedFile("DEMO-HTTP-01.svg", image_b, content_type="image/svg+xml"),
                ],
            },
        )
        self.assertEqual(uploaded[0], 200, uploaded[2])
        batch_id = self.json_body(uploaded)["id"]
        confirmed = self.http("POST", f"/api/tasks/{batch_id}/confirm")
        self.assertEqual(confirmed[0], 200, confirmed[2])
        uploaded_images = list(TaskFile.objects.filter(task_id=batch_id, kind="image"))
        self.assertEqual(len(uploaded_images), 2)
        self.assertEqual(
            {
                hashlib.sha256((self.external_root / "runtime" / "media" / item.stored_name).read_bytes()).hexdigest()
                for item in uploaded_images
            },
            {hashlib.sha256(image_a).hexdigest(), hashlib.sha256(image_b).hexdigest()},
        )

        before_preview = (WorkflowTask.objects.count(), WorkflowStep.objects.count())
        csrf_rejected = self.post_json(
            "/api/workflow-intent/preview",
            {"batch_id": batch_id, "user_goal": "整理产品资料"},
            csrf=False,
        )
        self.assertEqual(csrf_rejected[0], 403, csrf_rejected[2])
        self.assertEqual(before_preview, (WorkflowTask.objects.count(), WorkflowStep.objects.count()))
        preview = self.post_json(
            "/api/workflow-intent/preview",
            {"batch_id": batch_id, "user_goal": "整理本批演示产品资料并生成英文目录和样品核对清单"},
        )
        self.assertEqual(preview[0], 200, preview[2])
        preview_data = self.json_body(preview)
        self.assertEqual(preview_data["status"], "ready")
        self.assertTrue(preview_data["confirmation_token"])
        self.assertEqual(before_preview, (WorkflowTask.objects.count(), WorkflowStep.objects.count()))
        create_payload = {
            "batch_id": batch_id,
            "user_goal": "整理本批演示产品资料并生成英文目录和样品核对清单",
            "task_type": preview_data["action"]["task_type"],
            "confirmation_token": preview_data["confirmation_token"],
            "idempotency_key": "phase7-http-create-01",
        }
        created = self.post_json("/api/workflow-tasks", create_payload)
        self.assertEqual(created[0], 201, created[2])
        workflow_data = self.json_body(created)
        workflow_id = workflow_data["id"]
        workflow_url = f"/api/workflow-tasks/{workflow_id}"
        first_steps = list(WorkflowStep.objects.filter(task_id=workflow_id).values_list("id", "step_key"))
        first_subtasks = list(SubTask.objects.filter(task_id=workflow_id).values_list("id", "agent_role"))
        replayed = self.post_json("/api/workflow-tasks", create_payload)
        self.assertEqual(replayed[0], 201, replayed[2])
        self.assertEqual(self.json_body(replayed), workflow_data)
        self.assertEqual(first_steps, list(WorkflowStep.objects.filter(task_id=workflow_id).values_list("id", "step_key")))
        self.assertEqual(first_subtasks, list(SubTask.objects.filter(task_id=workflow_id).values_list("id", "agent_role")))

        state = self.json_body(self.http("GET", workflow_url))
        roles = {item["agent_role"]: item["id"] for item in state["subtasks"]}
        self.assertEqual(set(roles), {"product_profile", "delivery_quality"})
        before_early_delivery = (
            WorkflowStep.objects.filter(task_id=workflow_id).count(),
            EventLog.objects.filter(task_id=workflow_id).count(),
        )
        early_delivery = self.post_json(
            f"/api/workflow-tasks/{workflow_id}/subtasks/{roles['delivery_quality']}/dispatch",
            {"idempotency_key": "phase7-http-premature-delivery-dispatch"},
        )
        self.assertEqual(early_delivery[0], 409, early_delivery[2])
        self.assertEqual(
            before_early_delivery,
            (
                WorkflowStep.objects.filter(task_id=workflow_id).count(),
                EventLog.objects.filter(task_id=workflow_id).count(),
            ),
        )
        premature_generation = self.post_json(
            f"/api/workflow-tasks/{workflow_id}/deliverables",
            {"idempotency_key": "phase7-http-premature-generation"},
        )
        self.assertEqual(premature_generation[0], 409, premature_generation[2])
        workflow_before = WorkflowTask.objects.get(pk=workflow_id)
        self.assertEqual(workflow_before.status, "queued")
        self.assertFalse(WorkflowStep.objects.filter(task_id=workflow_id, step_key="generate_deliverables").exists())

        # Missing english_name and two image candidates are produced by the real role execution.
        initial_page = self.workflow_page(workflow_id)
        self.assertIn("英文名称待补充", initial_page.html)
        self.assertIn("DEMO-HTTP-01", initial_page.html)
        self.assertIn('href="#reviews-heading"', initial_page.html)
        initial_dispatch = self.form(initial_page, "workflow-dispatch-form")
        self.assertEqual(initial_dispatch["inputs"]["subtask_id"][0], roles["product_profile"])
        product_dispatch = self.post_json(
            initial_dispatch["attrs"]["data-dispatch-url"],
            {"idempotency_key": initial_dispatch["inputs"]["idempotency_key"][0]},
        )
        self.assertEqual(product_dispatch[0], 200, product_dispatch[2])
        waiting = WorkflowTask.objects.get(pk=workflow_id)
        self.assertEqual(waiting.status, "waiting_human")
        pending_page = self.workflow_page(workflow_id)
        self.assertIn("英文名称待补充", pending_page.html)
        review_forms = [
            form
            for form in pending_page.forms
            if form["attrs"].get("data-submit-url")
        ]
        self.assertTrue(review_forms)
        typed_types = {form["attrs"].get("data-answer-type") for form in review_forms}
        self.assertIn("set_literal_field", typed_types)
        self.assertIn("select_image_candidate", typed_types)
        image_form = next(form for form in review_forms if form["attrs"].get("data-answer-type") == "select_image_candidate")
        candidate_ids = image_form["options"].get("task_file_id", [])
        self.assertEqual(len(candidate_ids), 2)
        pre_complete = self.post_json(f"/api/workflow-tasks/{workflow_id}/complete", {})
        self.assertEqual(pre_complete[0], 409, pre_complete[2])
        self.assertEqual(WorkflowTask.objects.get(pk=workflow_id).status, "waiting_human")

        review_ids = []
        for form in review_forms:
            attrs = form["attrs"]
            submit_url = attrs["data-submit-url"]
            review_id = submit_url.split("/reviews/", 1)[1].split("/submit", 1)[0]
            review_ids.append(review_id)
            answer_type = attrs.get("data-answer-type")
            if answer_type == "select_image_candidate":
                answer = {"type": answer_type, "task_file_id": candidate_ids[0]}
            elif answer_type == "set_literal_field":
                answer = {"type": answer_type, "field": attrs["data-field"], "value": "Demo Ribbon 25mm Burgundy"}
            elif answer_type == "confirm_current_revision":
                answer = {"type": answer_type, "revision_id": attrs["data-revision-id"]}
            else:
                answer = {"note": "人工核对演示资料"}
            submitted = self.post_json(
                submit_url,
                {"review_key": attrs["data-review-key"], "answer": answer, "reviewer": "phase7-http-demo-operator"},
            )
            self.assertEqual(submitted[0], 200, submitted[2])
            saved = HumanReview.objects.get(pk=review_id)
            self.assertEqual(saved.status, "submitted")
            if answer_type == "set_literal_field":
                self.assertEqual(saved.answer["response"], answer)
            if answer_type == "select_image_candidate":
                self.assertEqual(saved.answer["response"], answer)
            self.assertEqual(WorkflowTask.objects.get(pk=workflow_id).status, "waiting_human")
        self.assertEqual(ProductRevision.objects.filter(product__task_id=batch_id).count(), 1)
        self.assertFalse(WorkflowStep.objects.filter(task_id=workflow_id, step_key="apply_review_cycle").exists())

        apply_page = self.workflow_page(workflow_id)
        self.assertIn("英文名称待补充", apply_page.html)
        self.assertIn("提交答案后还需显式应用", apply_page.html)
        apply_form = self.form(apply_page, "review-cycle-apply-form")
        submitted_ids = apply_form["inputs"].get("review_id", [])
        self.assertEqual(set(submitted_ids), set(review_ids))
        applied = self.post_json(
            apply_form["attrs"]["data-apply-url"],
            {"review_ids": submitted_ids, "idempotency_key": apply_form["attrs"]["data-idempotency-key"], "decision": "apply_and_confirm", "reviewer": "phase7-http-demo-operator"},
        )
        self.assertEqual(applied[0], 200, applied[2])
        self.assertEqual(WorkflowTask.objects.get(pk=workflow_id).status, "running")
        current_revision = ProductRevision.objects.filter(product__task_id=batch_id).order_by("-version").first()
        self.assertEqual(current_revision.status, "confirmed")
        self.assertEqual(current_revision.snapshot["english_name"], "Demo Ribbon 25mm Burgundy")
        applied_page = self.workflow_page(workflow_id)
        self.assertNotIn("英文名称待补充", applied_page.html)
        self.assertEqual(
            current_revision.source_refs["human_image_selection"]["task_file_id"],
            candidate_ids[0],
        )
        for role in ("product_profile", "delivery_quality"):
            state = self.json_body(self.http("GET", workflow_url))
            subtasks = {item["agent_role"]: item["id"] for item in state["subtasks"]}
            page = self.workflow_page(workflow_id)
            dispatch_form = self.form(page, "workflow-dispatch-form")
            subtask_id = dispatch_form["inputs"]["subtask_id"][0]
            self.assertEqual(subtask_id, subtasks[role])
            dispatched = self.post_json(
                dispatch_form["attrs"]["data-dispatch-url"],
                {"idempotency_key": dispatch_form["inputs"]["idempotency_key"][0]},
            )
            self.assertEqual(dispatched[0], 200, dispatched[2])
        role_rows = {item.agent_role: item for item in SubTask.objects.filter(task_id=workflow_id)}
        self.assertEqual({key for key, value in role_rows.items() if value.status == "completed"}, {"product_profile", "delivery_quality"})

        generation_page = self.workflow_page(workflow_id)
        generation_form = self.form(generation_page, "delivery-generate-form")
        generation_payload = {"idempotency_key": generation_form["attrs"]["data-key"]}
        generated = self.post_json(generation_form["attrs"]["data-url"], generation_payload)
        if generated[0] != 200:
            failed_step = WorkflowStep.objects.filter(
                task_id=workflow_id,
                idempotency_key=generation_payload["idempotency_key"],
            ).first()
            diagnostic = {
                "workflow_status": WorkflowTask.objects.get(pk=workflow_id).status,
                "current_step": WorkflowTask.objects.get(pk=workflow_id).current_step,
                "step_status": failed_step.status if failed_step else None,
                "error_summary": failed_step.error_summary if failed_step else None,
                "failure_code": (failed_step.output_refs.get("failure_code") if failed_step else None),
            }
            self.fail(f"generation returned HTTP {generated[0]}; saved failure={diagnostic!r}")
        self.assertEqual(generated[0], 200, generated[2])
        generated_data = self.json_body(generated)
        self.assertEqual(generated_data["status"], "completed")
        self.assertEqual(generated_data["quality_status"], "passed")
        versions_before = list(
            ArtifactVersion.objects.filter(artifact__task_id=workflow_id)
            .order_by("artifact__artifact_type", "version")
            .values_list("id", "sha256")
        )
        self.assertEqual(len(versions_before), 5)
        replayed_generation = self.post_json(generation_form["attrs"]["data-url"], generation_payload)
        self.assertEqual(replayed_generation[0], 200, replayed_generation[2])
        self.assertEqual(
            versions_before,
            list(ArtifactVersion.objects.filter(artifact__task_id=workflow_id).order_by("artifact__artifact_type", "version").values_list("id", "sha256")),
        )

        listing = self.json_body(self.http("GET", f"/api/workflow-tasks/{workflow_id}/deliverables"))
        artifacts = listing["artifacts"]
        self.assertEqual(len(artifacts), 5)
        types = {artifact["artifact_type"] for artifact in artifacts}
        self.assertEqual(types, {"catalog_html", "catalog_markdown", "sample_checklist_csv", "sample_checklist_json", "quality_report_json"})
        downloaded_bytes = {}
        for artifact in artifacts:
            version = artifact["versions"][0]
            if artifact["artifact_type"] in {"catalog_html", "catalog_markdown"}:
                preview = self.http("GET", version["preview_url"])
                self.assertEqual(preview[0], 200, preview[2])
                self.assertGreater(len(preview[2]), 100)
                self.assertIn(b"Demo Ribbon 25mm Burgundy", preview[2])
            elif artifact["artifact_type"] == "sample_checklist_csv":
                preview = self.http("GET", version["preview_url"])
                self.assertEqual(preview[0], 200, preview[2])
                self.assertIn(b"DEMO-HTTP-01", preview[2])
            downloaded = self.http("GET", version["download_url"])
            self.assertEqual(downloaded[0], 200, downloaded[2])
            self.assertIn("attachment;", downloaded[1].get("Content-Disposition", ""))
            self.assertEqual(hashlib.sha256(downloaded[2]).hexdigest(), version["sha256"])
            downloaded_bytes[artifact["artifact_type"]] = downloaded[2]
        csv_rows = list(csv.DictReader(io.StringIO(downloaded_bytes["sample_checklist_csv"].decode("utf-8-sig"), newline="")))
        checklist_row = next(row for row in csv_rows if row["sku"] == "DEMO-HTTP-01")
        self.assertEqual(checklist_row["english_name"], "Demo Ribbon 25mm Burgundy")
        self.assertEqual(checklist_row["image_task_file_id"], candidate_ids[0])
        generation_step = WorkflowStep.objects.get(task_id=workflow_id, step_key="generate_deliverables", status="completed")
        bound_sources = generation_step.output_refs["source_product_versions"]
        self.assertEqual(generation_step.output_refs["quality_status"], "passed")
        for version in ArtifactVersion.objects.filter(artifact__task_id=workflow_id):
            stored = (self.external_root / "runtime" / "artifacts" / version.file_path).resolve()
            self.assertTrue(stored.is_file())
            self.assertEqual(hashlib.sha256(stored.read_bytes()).hexdigest(), version.sha256)
            self.assertTrue(version.source_product_versions)
            self.assertEqual(version.source_product_versions, bound_sources)
            source_ids = {row["revision_id"] for row in version.source_product_versions}
            self.assertTrue(set(ProductRevision.objects.filter(product__task_id=batch_id).values_list("id", flat=True)) >= source_ids)
        csv_version = next(
            item["versions"][0]
            for item in artifacts
            if item["artifact_type"] == "sample_checklist_csv"
        )
        public_source_ids = {row["revision_id"] for row in csv_version["source_product_versions"]}
        self.assertIn(checklist_row["revision_id"], public_source_ids)
        self.assertIn(checklist_row["revision_id"], set(bound_sources_item["revision_id"] for bound_sources_item in bound_sources))
        self.assertTrue(
            ProductRevision.objects.filter(
                pk=checklist_row["revision_id"],
                status="confirmed",
                snapshot__english_name="Demo Ribbon 25mm Burgundy",
            ).exists()
        )

        before_approval_complete = (
            WorkflowTask.objects.get(pk=workflow_id).status,
            list(ArtifactVersion.objects.filter(artifact__task_id=workflow_id).order_by("id").values_list("id", "status")),
            EventLog.objects.filter(task_id=workflow_id).count(),
        )
        early_complete = self.post_json(f"/api/workflow-tasks/{workflow_id}/complete", {})
        self.assertEqual(early_complete[0], 409, early_complete[2])
        self.assertEqual(
            before_approval_complete,
            (
                WorkflowTask.objects.get(pk=workflow_id).status,
                list(ArtifactVersion.objects.filter(artifact__task_id=workflow_id).order_by("id").values_list("id", "status")),
                EventLog.objects.filter(task_id=workflow_id).count(),
            ),
        )
        review_page = self.workflow_page(workflow_id)
        review_form = self.form(review_page, "delivery-review-form")
        approved = self.post_json(
            review_form["attrs"]["data-url"],
            {"decision": "approve", "reviewer": "phase7-http-demo-operator", "note": "演示文件逐项检查"},
        )
        self.assertEqual(approved[0], 200, approved[2])
        self.assertTrue(all(item.status == "approved" for item in ArtifactVersion.objects.filter(artifact__task_id=workflow_id)))
        completion_page = self.workflow_page(workflow_id)
        completion_form = self.form(completion_page, "delivery-complete-form")
        completed = self.post_json(completion_form["attrs"]["data-url"], {})
        self.assertEqual(completed[0], 200, completed[2])

        # A fresh HTTP connection and cookie jar observes the persisted completed state.
        fresh = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        request = urllib.request.Request(f"{self.base_url}{workflow_url}", method="GET")
        with fresh.open(request, timeout=30) as response:
            persisted = json.loads(response.read().decode("utf-8"))
        self.assertEqual(persisted["status"], "completed")
        self.assertEqual(WorkflowTask.objects.get(pk=workflow_id).status, "completed")
