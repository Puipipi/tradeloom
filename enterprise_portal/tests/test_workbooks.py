from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID

from django.contrib.auth.models import Group, Permission, User
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import RequestFactory, override_settings
from django.urls import reverse
from openpyxl import Workbook

from enterprise_portal.models import WorkbookImport
from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.intake.api import source_collection
from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT, initialize_source_root, open_source, store_source
from workbench.models import IntakeSourceVersion, WorkbookSnapshot


def workbook_bytes(label):
    book = Workbook()
    sheet = book.active
    sheet.title = "进货记录"
    sheet["A1"] = label
    sheet["B1"] = "<script>literal_text</script>"
    sheet["C1"] = "=1+2"
    sheet["M1"] = "UNSHOWN_COLUMN"
    sheet["A21"] = "UNSHOWN_ROW"
    book.create_sheet("复核")["A1"] = "第二张表"
    buffer = BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def uploaded(name, data):
    return SimpleUploadedFile(name, data, content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


def initialize_test_store(data):
    root = data / "private" / "intake"
    root.mkdir(parents=True)
    (root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8", newline="\n")
    return root


class EnterpriseWorkbookTests(EmailVerifiedTestCase):
    def setUp(self):
        super().setUp()
        owners = Group.objects.create(name="企业老板")
        owners.permissions.add(*Permission.objects.filter(
            content_type__app_label="enterprise_portal", codename__in=("view_business_data", "view_all_enterpriseentry")
        ))
        self.owner, self.peer, self.factory = [
            User.objects.create_user(username=f"workbook-{role}") for role in ("owner", "peer", "factory")
        ]
        for user in (self.owner, self.peer, self.factory):
            user.groups.add(owners)
        self.factory.groups.add(Group.objects.create(name="工厂登记员"))
        self.url = reverse("enterprise-workbooks")
        self.client.force_login(self.owner)

    @override_settings(TRADELOOM_INTAKE_ROOT=None, TRADELOOM_DATA_ROOT=None)
    def test_missing_storage_has_no_public_fallback(self):
        self.assertContains(self.client.get(self.url), "私有工作簿存储不可用")
        self.assertEqual(self.client.post(self.url, {"workbook": uploaded("x.xlsx", b"fake")}).status_code, 503)
        self.assertEqual(IntakeSourceVersion.objects.count(), 0)

    def test_owner_receipts_reuse_real_desktop_data_and_verify_download(self):
        with TemporaryDirectory() as directory:
            data = Path(directory).resolve()
            root = initialize_test_store(data)
            with override_settings(TRADELOOM_DATA_ROOT=data, TRADELOOM_INTAKE_ROOT=root,
                                   MEDIA_ROOT=data / "media", STATIC_ROOT=data / "static"):
                self.check_owner_receipts(root)

    def test_startup_initializes_a_clean_store_and_keeps_existing_files(self):
        with TemporaryDirectory() as directory:
            data = Path(directory).resolve()
            root = data / "private" / "intake"
            root.mkdir(parents=True)
            unknown = root / "existing-file.xlsx"
            unknown.write_bytes(b"existing data")
            with override_settings(TRADELOOM_DATA_ROOT=data, TRADELOOM_INTAKE_ROOT=root,
                                   MEDIA_ROOT=data / "media", STATIC_ROOT=data / "static"):
                with self.assertRaises(ValidationError):
                    initialize_source_root()
                self.assertEqual(unknown.read_bytes(), b"existing data")
                self.assertFalse((root / INTAKE_MARKER).exists())
                unknown.unlink()
                self.assertEqual(initialize_source_root(), root)
                unknown.write_bytes(b"owned data")
                self.assertEqual(initialize_source_root(), root)
                self.assertEqual(unknown.read_bytes(), b"owned data")

    def check_owner_receipts(self, root):
        legacy, _ = store_source(uploaded("OLD-DESKTOP-NAME.xlsx", workbook_bytes("旧全局资料")))
        self.assertNotContains(self.client.get(self.url), "OLD-DESKTOP-NAME")
        self.assertEqual(self.client.get(reverse("enterprise-workbook-detail", args=[UUID(legacy.pk)])).status_code, 404)

        data = workbook_bytes("合成原件")

        def upload(name):
            return self.client.post(self.url, {"workbook": uploaded(name, data)})

        first = upload("手机来源.xlsx")
        self.assertEqual(first.status_code, 302)
        url = first["Location"]
        self.assertEqual(upload("重试.xlsx")["Location"], url)
        record = WorkbookImport.objects.get(owner=self.owner)
        self.assertEqual(WorkbookImport.objects.count(), 1)
        self.assertEqual(IntakeSourceVersion.objects.count(), 2)
        self.assertTrue(WorkbookSnapshot.objects.filter(source_id=record.source_id, status="ready").exists())
        desk = source_collection(RequestFactory().get("/api/intake/sources"))
        self.assertIn(record.source_id.encode("ascii"), desk.content)
        with open_source(record.source_id) as handle:
            self.assertEqual(handle.read(), data)

        page = self.client.get(url)
        self.assertContains(page, "合成原件")
        self.assertContains(page, "&lt;script&gt;literal_text&lt;/script&gt;")
        self.assertContains(page, "公式")
        for marker in ("UNSHOWN_", "=1+2", record.source.storage_key, "<script>literal_text</script>"):
            self.assertNotContains(page, marker)
        self.assertContains(self.client.get(url + "?sheet=2"), "第二张表")
        download = self.client.get(url + "download/")
        self.assertTrue(download["Content-Disposition"].startswith("attachment"))
        self.assertEqual(b"".join(download.streaming_content), data)
        self.assertEqual(self.client.post(self.url, {"workbook": uploaded("坏文件.xlsx", b"bad")}).status_code, 400)
        self.assertEqual(IntakeSourceVersion.objects.count(), 2)

        self.client.force_login(self.peer)
        self.assertNotContains(self.client.get(self.url), "手机来源.xlsx")
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.get(url + "download/").status_code, 404)
        peer = upload("本人同件.xlsx")
        self.assertNotEqual(peer["Location"], url)
        self.assertEqual(WorkbookImport.objects.get(owner=self.peer).source_id, record.source_id)
        self.assertNotContains(self.client.get(peer["Location"]), "手机来源.xlsx")
        self.client.force_login(self.factory)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.assertEqual(upload("工厂尝试.xlsx").status_code, 403)
        self.client.force_login(self.owner)
        path = root / "objects" / record.source.storage_key
        path.write_bytes(b"x" * len(data))
        self.assertEqual(self.client.get(url).status_code, 503)
        self.assertEqual(self.client.get(url + "download/").status_code, 503)
