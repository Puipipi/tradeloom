import hashlib
from pathlib import Path
import tempfile
import uuid

from django.contrib.auth.models import Group, Permission, User
from django.test import TestCase, override_settings
from django.utils import timezone

from enterprise_portal.email_login import VERIFIED, fingerprint
from enterprise_portal.models import WebsiteNotice
from workbench.delivery.storage import DELIVERY_FILES
from workbench.models import Artifact, ArtifactVersion, Task, WorkflowTask


class DeliveryVersionPortalTests(TestCase):
    def setUp(self):
        WebsiteNotice.objects.get_or_create(pk=1)
        self.artifact_root = Path(tempfile.mkdtemp(prefix="portal-delivery-test-"))
        self.settings_override = override_settings(TRADELOOM_ARTIFACT_ROOT=self.artifact_root)
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)

        business = Permission.objects.get(
            content_type__app_label="enterprise_portal", codename="view_business_data"
        )
        records = Permission.objects.get(
            content_type__app_label="enterprise_portal", codename="view_all_enterpriseentry"
        )
        owner_group, _ = Group.objects.get_or_create(name="企业老板")
        owner_group.permissions.add(business, records)
        self.owner = self.make_user("delivery-owner", groups=[owner_group])
        self.workflow = self.make_workflow()

    def tearDown(self):
        for path in self.artifact_root.iterdir():
            if path.is_dir():
                import shutil
                shutil.rmtree(path)
            else:
                path.unlink()
        self.artifact_root.rmdir()

    def make_user(self, username, permissions=(), groups=()):
        user = User.objects.create_user(
            username=username, password="test-password", email=f"{username}@example.test"
        )
        if permissions:
            user.user_permissions.add(*permissions)
        if groups:
            user.groups.add(*groups)
        return user

    def log_in_verified(self, user):
        self.client.force_login(user)
        session = self.client.session
        session[VERIFIED] = fingerprint(user)
        session.save()

    def make_workflow(self):
        now = timezone.now()
        batch = Task.objects.create(
            title="合成交付批次",
            mode="test",
            status="completed",
            created_at=now,
            updated_at=now,
        )
        return WorkflowTask.objects.create(
            id=uuid.uuid4().hex,
            batch=batch,
            user_goal="仅用于隔离门户测试",
            task_type="delivery_test",
            status="completed",
        )

    def make_version(self, artifact_type, content, file_path=None):
        artifact = Artifact.objects.create(
            task=self.workflow,
            artifact_type=artifact_type,
            storage_key=f"synthetic-{uuid.uuid4().hex}",
            current_version=1,
            status="approved",
        )
        if file_path is None:
            step_id = uuid.uuid4().hex
            filename = DELIVERY_FILES[artifact_type]
            relative = f"{self.workflow.id}/{step_id}/{filename}"
            path = self.artifact_root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            file_path = relative
        return ArtifactVersion.objects.create(
            artifact=artifact,
            version=1,
            file_path=file_path,
            sha256=hashlib.sha256(content).hexdigest(),
            status="approved",
        )

    def test_owner_can_open_home_list_safe_preview_and_download(self):
        content = b"<html><script>document.title='should-not-run'</script><p>synthetic catalog</p></html>"
        version = self.make_version("catalog_html", content)
        json_version = self.make_version("quality_report_json", b'{"synthetic":true}')
        self.log_in_verified(self.owner)

        home = self.client.get("/enterprise/")
        self.assertEqual(home.status_code, 200)
        self.assertContains(home, 'href="/enterprise/deliveries/"')

        listing = self.client.get("/enterprise/deliveries/")
        self.assertEqual(listing.status_code, 200)
        self.assertIn("no-store", listing["Cache-Control"])
        self.assertContains(listing, "合成交付批次")
        self.assertContains(listing, "商品目录 HTML")
        self.assertContains(listing, "安全预览")
        self.assertContains(listing, "quality_report.json")
        self.assertNotContains(listing, 'href="/enterprise/deliveries/%s/%s/preview"' % (self.workflow.id, json_version.id))
        self.assertNotContains(listing, str(self.artifact_root))

        preview = self.client.get(
            f"/enterprise/deliveries/{self.workflow.id}/{version.id}/preview"
        )
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview["Content-Type"], "text/html; charset=utf-8")
        self.assertIn("sandbox", preview["Content-Security-Policy"])
        self.assertEqual(preview["X-Content-Type-Options"], "nosniff")
        self.assertIn(b"synthetic catalog", preview.content)

        download = self.client.get(
            f"/enterprise/deliveries/{self.workflow.id}/{version.id}/download"
        )
        self.assertEqual(download.status_code, 200)
        self.assertIn("attachment", download["Content-Disposition"])
        self.assertEqual(b"".join(download.streaming_content), content)

        unsupported_preview = self.client.get(
            f"/enterprise/deliveries/{self.workflow.id}/{json_version.id}/preview"
        )
        self.assertEqual(unsupported_preview.status_code, 409)

    def test_factory_member_and_permission_revocation_are_denied(self):
        business = Permission.objects.get(
            content_type__app_label="enterprise_portal", codename="view_business_data"
        )
        records = Permission.objects.get(
            content_type__app_label="enterprise_portal", codename="view_all_enterpriseentry"
        )
        factory, _ = Group.objects.get_or_create(name="工厂登记员")
        factory.permissions.add(business, records)
        worker = self.make_user("delivery-factory", groups=[factory])
        self.log_in_verified(worker)

        home = self.client.get("/enterprise/")
        self.assertNotContains(home, 'href="/enterprise/deliveries/"')
        self.assertEqual(self.client.get("/enterprise/deliveries/").status_code, 403)
        self.assertEqual(
            self.client.get(
                f"/enterprise/deliveries/{self.workflow.id}/{'f' * 32}/preview"
            ).status_code,
            403,
        )

        self.log_in_verified(self.owner)
        self.owner.groups.clear()
        self.assertEqual(self.client.get("/enterprise/deliveries/").status_code, 403)
        self.assertEqual(
            self.client.get(
                f"/enterprise/deliveries/{self.workflow.id}/{'e' * 32}/download"
            ).status_code,
            403,
        )

    def test_unverified_session_mismatched_ids_and_path_traversal_are_rejected(self):
        version = self.make_version("catalog_markdown", b"# synthetic")
        self.client.force_login(self.owner)
        response = self.client.get("/enterprise/deliveries/")
        self.assertEqual(response.status_code, 302)
        self.assertIn("/accounts/login/", response.url)

        self.log_in_verified(self.owner)
        other_workflow = uuid.uuid4().hex
        self.assertEqual(
            self.client.get(
                f"/enterprise/deliveries/{other_workflow}/{version.id}/preview"
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.get(
                f"/enterprise/deliveries/{self.workflow.id}/not-a-version/download"
            ).status_code,
            404,
        )

        outside = self.artifact_root.parent / "outside-delivery-test.txt"
        outside.write_bytes(b"outside")
        malicious = self.make_version("catalog_markdown", b"outside", "../outside-delivery-test.txt")
        listing = self.client.get("/enterprise/deliveries/")
        self.assertNotContains(listing, malicious.id)
        self.assertEqual(
            self.client.get(
                f"/enterprise/deliveries/{self.workflow.id}/{malicious.id}/preview"
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.get(
                f"/enterprise/deliveries/{self.workflow.id}/{malicious.id}/download"
            ).status_code,
            404,
        )
        outside.unlink()

    def test_corrupt_hash_is_rejected_when_content_is_read(self):
        version = self.make_version("catalog_markdown", b"# original")
        self.log_in_verified(self.owner)
        path = self.artifact_root / version.file_path
        path.write_bytes(b"# changed")

        listing = self.client.get("/enterprise/deliveries/")
        # The index is metadata-only; it reports a registered row without
        # claiming its bytes are intact. Content reads revalidate the digest.
        self.assertContains(listing, version.id)
        preview = self.client.get(
            f"/enterprise/deliveries/{self.workflow.id}/{version.id}/preview"
        )
        self.assertEqual(preview.status_code, 409)
        download = self.client.get(
            f"/enterprise/deliveries/{self.workflow.id}/{version.id}/download"
        )
        self.assertEqual(download.status_code, 409)
