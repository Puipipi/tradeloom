import json

from django.contrib.auth.models import Group, Permission, User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse

from enterprise_portal.models import PortableCanvas
from enterprise_portal.testing import EmailVerifiedTestCase


def desktop_document():
    return {
        "id": "synthetic-local-id",
        "version": 1,
        "title": "合成工作流",
        "source": "manual",
        "confirmed": True,
        "description": "C:/sensitive/path",
        "updatedAt": "2026-11-25T00:00:00.000Z",
        "nodes": [
            {"id": "local-input", "kind": "input", "title": "准备资料", "position": {"x": 40, "y": 60}},
            {"id": "local-agent", "kind": "agent", "title": "核对样品", "agent": "product",
             "model": {"provider": "synthetic-model", "model": "do-not-copy"},
             "instruction": "C:/sensitive/instruction"},
            {"id": "local-output", "kind": "output", "title": "完成报告"},
        ],
        "edges": [{"from": "local-input", "to": "local-agent"}, {"from": "local-agent", "to": "local-output"}],
    }


class PortableCanvasTests(EmailVerifiedTestCase):
    def setUp(self):
        self.url = reverse("enterprise-portable-canvas")
        group = Group.objects.create(name="企业老板")
        group.permissions.add(*Permission.objects.filter(
            content_type__app_label="enterprise_portal", codename__in=("view_business_data", "view_all_enterpriseentry")
        ))
        self.owner = User.objects.create_user(username="canvas-owner", email="canvas-owner@example.test")
        self.peer = User.objects.create_user(username="canvas-peer", email="canvas-peer@example.test")
        self.owner.groups.add(group)
        self.peer.groups.add(group)
        self.factory = User.objects.create_user(username="canvas-factory", email="canvas-factory@example.test")
        self.factory.groups.add(group, Group.objects.create(name="工厂登记员"))

    def authenticate(self, user):
        self.client.force_login(user)

    def upload(self, document):
        upload = SimpleUploadedFile("desktop.json", json.dumps(document).encode(), content_type="application/json")
        return self.client.post(self.url, {"definition": upload})

    def test_import_is_inert_and_private_and_edit_refuses_stale_revision(self):
        self.assertRedirects(self.client.get(self.url), f"/accounts/login/?next={self.url}", fetch_redirect_response=False)
        self.authenticate(self.owner)
        self.assertContains(self.client.get(reverse("enterprise-workflows")), self.url)
        imported = self.upload(desktop_document())
        self.assertEqual(imported.status_code, 302)
        canvas = PortableCanvas.objects.get()
        self.assertEqual(canvas.owner, self.owner)
        self.assertEqual(canvas.graph["edges"], [[0, 1], [1, 2]])
        self.assertEqual(canvas.graph["nodes"][0]["y"], 60)
        self.assertEqual(set(canvas.graph["nodes"][1]), {"kind", "title", "x", "y"})
        detail = imported["Location"]
        response = self.client.get(detail)
        self.assertContains(response, "准备资料")
        for forbidden in ("sensitive", "synthetic-model", "local-input", "synthetic-local-id"):
            self.assertNotContains(response, forbidden)
        edit = {"revision": "1", "title": "重新审阅", "node_0": "整理", "node_1": "核对", "node_2": "输出"}
        self.assertRedirects(self.client.post(detail, edit), detail)
        self.assertEqual(self.client.post(detail, edit).status_code, 409)
        self.assertContains(self.client.get(detail), "重新审阅")
        canvas.refresh_from_db()
        self.assertEqual(canvas.revision, 2)
        self.assertEqual(canvas.graph["nodes"][1]["title"], "核对")
        self.authenticate(self.peer)
        self.assertNotContains(self.client.get(self.url), "重新审阅")
        self.assertEqual(self.client.get(detail).status_code, 404)
        self.assertEqual(self.client.post(detail, edit).status_code, 404)
        self.authenticate(self.factory)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.assertEqual(self.client.get(detail).status_code, 403)
        self.assertEqual(self.upload(desktop_document()).status_code, 403)

    def test_titles_keep_desktop_punctuation_and_render_as_plain_text(self):
        self.authenticate(self.owner)
        document = desktop_document()
        document["title"] = "\ufeffSample v1.2 / Review: R&D 🚚\xa0"
        document["nodes"][0]["title"] = "</script><b>example</b>"
        imported = self.upload(document)
        self.assertEqual(imported.status_code, 302)
        canvas = PortableCanvas.objects.get()
        self.assertEqual(canvas.title, "Sample v1.2 / Review: R&D 🚚")
        self.assertEqual(canvas.graph["nodes"][0]["title"], "</script><b>example</b>")
        response = self.client.get(imported["Location"])
        self.assertContains(response, "Sample v1.2 / Review: R&amp;D 🚚")
        self.assertContains(response, "&lt;/script&gt;&lt;b&gt;example&lt;/b&gt;")
        self.assertContains(response, r"\u003C/script\u003E\u003Cb\u003Eexample\u003C/b\u003E")
        self.assertNotContains(response, "</script><b>example</b>")

    def test_rejects_cycles_and_unusable_titles(self):
        self.authenticate(self.owner)
        broken = desktop_document()
        broken["edges"].append({"from": "local-output", "to": "local-input"})
        self.assertEqual(self.upload(broken).status_code, 400)
        for title in ("\ufeff\xa0", "path\x00control", "two\nlines", "🚚" * 40 + " ", "\ud800"):
            with self.subTest(title=title):
                broken = desktop_document()
                broken["nodes"][0]["title"] = title
                self.assertEqual(self.upload(broken).status_code, 400)
        self.assertFalse(PortableCanvas.objects.exists())
        valid = desktop_document()
        valid["title"] = "🚚" * 50
        valid["nodes"][0]["title"] = "🚚" * 40
        self.assertEqual(self.upload(valid).status_code, 302)

    def test_structural_updates_cas_and_export_scope(self):
        self.authenticate(self.owner)
        doc = desktop_document()
        doc["nodes"][1] = {"id": "local-agent", "kind": "review", "title": "检查"}
        imported = self.upload(doc)
        detail = imported["Location"]
        canvas = PortableCanvas.objects.get()
        export = reverse("enterprise-portable-canvas-export", args=[canvas.pk])

        def post(operation, **fields):
            canvas.refresh_from_db()
            data = {f"node_{index}": node["title"] for index, node in enumerate(canvas.graph["nodes"])}
            data.update({"revision": str(canvas.revision), "title": canvas.title, "operation": operation})
            data.update(fields)
            return self.client.post(detail, data)

        self.assertEqual(post("add-edge", edge_from="2", edge_to="0").status_code, 400)
        self.assertEqual(post("add-node", new_kind="review", new_title="人工核验").status_code, 302)
        self.assertEqual(post("save", revision="1").status_code, 409)
        self.assertEqual(post("add-edge", edge_from="2", edge_to="3", x_3="-120", y_3="300").status_code, 302)
        self.assertEqual(post("remove-edge:0:1").status_code, 302)
        self.assertEqual(post("remove-node:1").status_code, 302)
        saved = self.client.get(export)
        self.assertEqual(saved.status_code, 200)
        self.assertTrue(saved["Content-Disposition"].startswith("attachment"))
        output = saved.json()
        self.assertFalse(output["confirmed"])
        self.assertEqual(output["nodes"][2]["position"], {"x": -120, "y": 300})
        self.assertEqual(output["edges"], [{"from": "node-1", "to": "node-2"}])
        self.assertNotContains(saved, "local-agent")
        self.authenticate(self.peer)
        self.assertEqual(self.client.get(export).status_code, 404)
        self.assertEqual(self.client.post(detail, {"operation": "remove-node:1"}).status_code, 404)

        self.authenticate(self.owner)
        with_agent = self.upload(desktop_document())
        self.assertEqual(self.client.get(with_agent["Location"] + "export/").status_code, 404)
