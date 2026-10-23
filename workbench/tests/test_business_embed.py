from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from django.http import HttpResponse
from django.test import Client, RequestFactory, SimpleTestCase, override_settings
from django.template.loader import get_template, render_to_string
from django.urls import path
from django.views.decorators.csrf import ensure_csrf_cookie

from config.business_embed import EmbedFramePolicyMiddleware
from workbench.business_urls import public_business_url
from workbench.api import preview_artifact
from workbench.services import WorkbenchService
from workbench.views import _page_context


@ensure_csrf_cookie
def csrf_probe(request):
    return HttpResponse("ok")


urlpatterns = [path("csrf-probe", csrf_probe)]


class BusinessEmbedTests(SimpleTestCase):
    def test_media_urls_in_service_dtos_use_embed_alias_without_changing_stored_values(self):
        class Relation:
            def __init__(self, items):
                self.items = items

            def all(self):
                return self.items

        product = type("ProductDTO", (), {
            "id": 7, "task_id": 3, "sku": "SKU-7", "name": "纽扣", "category": "辅料",
            "material": "树脂", "size": "10mm", "color": "白色", "image_filename": "SKU-7.png",
            "image_stored_name": "products/SKU-7.png", "missing_fields": [],
            "updated_at": datetime(2026, 10, 19, tzinfo=timezone.utc),
        })()
        image_file = type("TaskFileDTO", (), {
            "id": 9, "kind": "image", "original_name": "SKU-7.png", "stored_name": "tasks/task-3/SKU-7.png",
        })()
        task = type("TaskDTO", (), {
            "id": 3, "title": "样品任务", "mode": "demo", "status": "draft",
            "created_at": datetime(2026, 10, 19, tzinfo=timezone.utc),
            "updated_at": datetime(2026, 10, 19, tzinfo=timezone.utc),
            "products": Relation([product]), "files": Relation([image_file]),
        })()
        service = WorkbenchService()

        with self.settings(TRADELOOM_DSH_EMBED=True, MEDIA_URL="/uploads/"):
            detail = service._task_detail(task)
            product_dto = service._product_dict(product)
        self.assertEqual(detail["files"][0]["url"], "/business-media/tasks/task-3/SKU-7.png")
        self.assertEqual(product_dto["image_url"], "/business-media/products/SKU-7.png")
        self.assertEqual(image_file.stored_name, "tasks/task-3/SKU-7.png")

        with self.settings(TRADELOOM_DSH_EMBED=False, MEDIA_URL="/uploads/"):
            self.assertEqual(service._product_dict(product)["image_url"], "/uploads/products/SKU-7.png")

    def test_url_bearing_templates_compile(self):
        for template in (
            "workbench/base.html",
            "workbench/home.html",
            "workbench/products.html",
            "workbench/agent_center.html",
            "workbench/artifacts.html",
            "workbench/runs.html",
            "workbench/task_list.html",
            "workbench/task_detail.html",
            "workbench/new_task.html",
            "workbench/workflow_detail.html",
            "workbench/workflow_review_image_uploads.html",
            "workbench/sample_checklist_preview.html",
        ):
            with self.subTest(template=template):
                get_template(template)

    def test_public_url_keeps_default_paths_and_maps_embed_aliases_without_changing_query(self):
        url = "/api/workflow-tasks/wf%2F1?next=%2Fproducts&name=%E4%B8%AD#review-3"
        self.assertEqual(public_business_url(url, embedded=False), url)
        self.assertEqual(
            public_business_url(url, embedded=True),
            "/business-api/workflow-tasks/wf%2F1?next=%2Fproducts&name=%E4%B8%AD#review-3",
        )
        self.assertEqual(public_business_url("/static/workbench/app.js?v=2", embedded=True), "/business-static/workbench/app.js?v=2")
        self.assertEqual(public_business_url("/uploads/private/a.png", embedded=True), "/business-media/private/a.png")
        self.assertEqual(public_business_url("/workflow-tasks/wf-1", embedded=True), "/business/workflow-tasks/wf-1")
        self.assertEqual(public_business_url("https://example.com/api/tasks", embedded=True), "https://example.com/api/tasks")

    @override_settings(TRADELOOM_DSH_EMBED=True)
    def test_embed_base_hides_duplicate_navigation_and_maps_static_assets(self):
        request = RequestFactory().get("/business/home")
        html = render_to_string("workbench/base.html", _page_context("home"), request=request)
        self.assertIn('data-business-embed="true"', html)
        self.assertIn('href="/business-static/workbench/styles.css?v=iframe-density3"', html)
        self.assertIn('src="/business-static/workbench/app.js?v=iframe-density3"', html)
        self.assertNotIn('aria-label="主导航"', html)

    @override_settings(TRADELOOM_DSH_EMBED=True)
    def test_artifact_preview_links_stay_in_the_current_embedded_window(self):
        preview_url = "/api/workflow-tasks/workflow-1/artifact-versions/version-1/preview"
        download_url = "/api/workflow-tasks/workflow-1/artifact-versions/version-1/download"
        version = SimpleNamespace(
            version=1,
            status="approved",
            sha256="fixture-sha256",
            source_product_versions=[],
            preview_url=preview_url,
            download_url=download_url,
            artifact_type_label="英文目录 HTML",
        )
        artifact = SimpleNamespace(
            id="artifact-1",
            artifact_type="catalog_html",
            artifact_type_label="英文目录 HTML",
            current_version=1,
            status="approved",
            status_label="已批准",
            task_id="workflow-1",
            task=SimpleNamespace(batch=SimpleNamespace(title="DEMO ONLY")),
            updated_at=datetime(2026, 10, 20, tzinfo=timezone.utc),
            version_rows=[version],
            versions=[version],
        )
        request = RequestFactory().get("/business/workflow-tasks/workflow-1")
        artifacts_page = render_to_string(
            "workbench/artifacts.html",
            _page_context("artifacts", artifacts=[artifact], artifact_count=1, version_count=1),
            request=request,
        )
        workflow = SimpleNamespace(
            id="workflow-1", batch_id="batch-1", user_goal="DEMO ONLY",
            execution_mode="local_mock", planning_mode="local_mock", agentarts="未配置",
            pending_review_count=0, unresolved_review_count=0, current_step="complete",
            plan=SimpleNamespace(subtasks=[], source_summary={}), steps=[], subtasks=[], reviews=[],
        )
        workflow_page = render_to_string(
            "workbench/workflow_detail.html",
            _page_context(
                "workflow_detail", workflow=workflow, batch=SimpleNamespace(title="DEMO ONLY"),
                task_type_label="演示", status_label="已完成",
                deliverables=SimpleNamespace(workflow_status="completed", artifacts=[artifact], quality_report=None, quality_checks=[]),
                classification_summary="DEMO ONLY", dispatch_blocked_reason="",
            ),
            request=request,
        )

        expected_url = "/business-api/workflow-tasks/workflow-1/artifact-versions/version-1/preview"
        for page in (artifacts_page, workflow_page):
            with self.subTest(page="embedded preview"):
                self.assertIn(f'href="{expected_url}"', page)
                self.assertNotIn('target="_blank"', page)

    @override_settings(TRADELOOM_DSH_EMBED=True)
    def test_csv_artifact_preview_keeps_the_embedded_shell_layout(self):
        import hashlib
        import re
        from pathlib import Path

        from django.contrib.staticfiles import finders
        from workbench.delivery.checklist import CHECKLIST_FIELDS

        csv_bytes = (",".join(CHECKLIST_FIELDS) + "\n" + ",".join(["demo"] * len(CHECKLIST_FIELDS)) + "\n").encode("utf-8")
        version = SimpleNamespace(
            id="version-1",
            version=1,
            status="approved",
            sha256="fixture-sha256",
            source_product_versions=[],
            artifact=SimpleNamespace(artifact_type="sample_checklist_csv"),
        )
        request = RequestFactory().get(
            "/business-api/workflow-tasks/workflow-1/artifact-versions/version-1/preview"
        )

        with patch("workbench.api.get_artifact_preview", return_value=(version, csv_bytes, "text/csv")):
            response = preview_artifact(request, "workflow-1", "version-1")

        html = response.content.decode("utf-8")
        self.assertEqual(response.status_code, 200)
        self.assertIn('data-business-embed="true"', html)
        self.assertNotIn('aria-label="主导航"', html)
        self.assertIn('data-testid="sample-checklist-preview"', html)
        stylesheet_path = finders.find("workbench/styles.css")
        self.assertIsNotNone(stylesheet_path)
        expected_stylesheet = Path(stylesheet_path).read_text(encoding="utf-8").strip()
        inline_stylesheets = [value.strip() for value in re.findall(r"<style>(.*?)</style>", html, re.DOTALL)]
        self.assertEqual(len(inline_stylesheets), 1, "CSV preview must inline one app-owned stylesheet")
        self.assertEqual(
            hashlib.sha256(inline_stylesheets[0].encode("utf-8")).digest(),
            hashlib.sha256(expected_stylesheet.encode("utf-8")).digest(),
        )
        self.assertEqual(
            response["Content-Security-Policy"],
            "sandbox allow-downloads; default-src 'none'; style-src 'self' 'unsafe-inline'",
        )
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")
        self.assertIn('href="/business-api/workflow-tasks/workflow-1/artifact-versions/version-1/download"', html)

    @override_settings(TRADELOOM_DSH_EMBED=False)
    def test_default_base_keeps_navigation_and_static_paths(self):
        request = RequestFactory().get("/home")
        html = render_to_string("workbench/base.html", _page_context("home"), request=request)
        self.assertIn('data-business-embed="false"', html)
        self.assertIn('href="/static/workbench/styles.css?v=iframe-density3"', html)
        self.assertIn('src="/static/workbench/app.js?v=iframe-density3"', html)
        self.assertIn('aria-label="主导航"', html)

    def test_embed_frame_header_preserves_existing_csp_directives(self):
        middleware = EmbedFramePolicyMiddleware(lambda _request: HttpResponse("ok", headers={"Content-Security-Policy": "sandbox allow-downloads; default-src 'none'"}))
        response = middleware(RequestFactory().get("/business-api/artifact"))
        self.assertEqual(response["Content-Security-Policy"], "sandbox allow-downloads; default-src 'none'; frame-src 'self'")

    @override_settings(
        ROOT_URLCONF="workbench.tests.test_business_embed",
        ALLOWED_HOSTS=["127.0.0.1"],
        CSRF_TRUSTED_ORIGINS=[],
    )
    def test_same_origin_embed_post_keeps_csrf_and_rejects_foreign_origin(self):
        client = Client(enforce_csrf_checks=True)
        page = client.get("/csrf-probe", HTTP_HOST="127.0.0.1:3088")
        self.assertEqual(page.status_code, 200)
        token = client.cookies["csrftoken"].value
        accepted = client.post(
            "/csrf-probe",
            data="value=1",
            content_type="application/x-www-form-urlencoded",
            HTTP_HOST="127.0.0.1:3088",
            HTTP_ORIGIN="http://127.0.0.1:3088",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(accepted.status_code, 200)
        rejected = client.post(
            "/csrf-probe",
            data="value=1",
            content_type="application/x-www-form-urlencoded",
            HTTP_HOST="127.0.0.1:3088",
            HTTP_ORIGIN="http://attacker.example",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(rejected.status_code, 403)
