import io
import json
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.test import SimpleTestCase
from .testing import EmailVerifiedClient as Client, EmailVerifiedTestCase as TestCase

from .management.commands.configure_enterprise_groups import Command
from . import operations_ai, operations


class WebsiteTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        Command().handle()
        cls.owner = get_user_model().objects.create_user("notice-owner")
        cls.owner.groups.add(Group.objects.get(name="企业老板"))
        cls.tech = get_user_model().objects.create_user("notice-tech")
        cls.tech.user_permissions.add(Permission.objects.get(codename="use_server_operations"))
        cls.factory = get_user_model().objects.create_user("notice-factory")
        cls.factory.groups.add(Group.objects.get(name="工厂登记员"))
        cls.factory.user_permissions.add(Permission.objects.get(codename="use_server_operations"))
        cls.admin = get_user_model().objects.create_superuser("notice-admin", "a@example.invalid", "synthetic")

    url = "/api/enterprise/operations/website/"

    def write(self, text, revision):
        return self.client.post(self.url, {"text": text, "revision": revision}, content_type="application/json")

    def test_publish_replace_clear_and_stale(self):
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get(self.url).json()["notice"]["revision"], 0)
        self.assertEqual(self.write("<script>synthetic</script>", 0).status_code, 200)
        self.assertEqual(self.write("stale", 0).status_code, 409)
        self.assertEqual(self.write("replacement", 1).json()["notice"]["revision"], 2)
        self.assertEqual(self.client.get("/enterprise/").context["website_notice"]["text"], "replacement")
        self.assertEqual(self.write("", 2).json()["notice"]["text"], "")

    def test_roles_and_input(self):
        self.assertEqual(self.client.get(self.url).status_code, 302)
        for user, read, write in [(self.tech, 200, 403), (self.factory, 403, 403), (self.admin, 200, 200)]:
            self.client.force_login(user)
            self.assertEqual(self.client.get(self.url).status_code, read)
            self.assertEqual(self.write("notice", 0).status_code, write)
        self.client.force_login(self.owner)
        for text, revision in [("x" * 501, 1), ("ok", True), ([], 1), ("ok", -1)]:
            self.assertEqual(self.write(text, revision).status_code, 400)

    def test_csrf_and_origin(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.owner)
        self.assertEqual(client.post(self.url, {"text": "x", "revision": 0}, content_type="application/json").status_code, 403)
        client.get("/enterprise/")
        token = client.cookies["csrftoken"].value
        self.assertEqual(client.post(self.url, {"text": "x", "revision": 0}, content_type="application/json",
                                     HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="https://untrusted.invalid").status_code, 403)
        self.assertEqual(client.post(self.url, {"text": "x", "revision": 0}, content_type="application/json",
                                     HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver").status_code, 200)

    def test_model_proposal_never_writes_and_tech_denied(self):
        store = Mock()
        store.metadata.return_value = {"deepseek_api_key": {"configured": True}}
        store._read_for_provider.return_value = "synthetic-key"
        with patch.object(operations, "vault", return_value=store), patch.object(operations_ai, "classify", return_value="open_website_notice_form"):
            self.assertEqual(operations_ai.route("请打开公告表单", self.owner)["effect"], "proposal")
            self.assertIsNone(operations_ai.route("请打开公告表单", self.tech)["proposal"])
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get(self.url).json()["notice"]["revision"], 0)

    def test_local_notice_draft_never_calls_provider_and_needs_explicit_write(self):
        self.client.force_login(self.owner)
        text = "合成正文\n<script>纯文本</script>"
        with patch.object(operations, "vault") as vault, patch.object(operations_ai, "classify") as model:
            response = self.client.post("/api/enterprise/operations/assistant/", {"message": "发布公告：" + text}, content_type="application/json")
            self.assertEqual(response.status_code, 200)
            proposal = response.json()["proposal"]
            self.assertEqual(proposal["text"], text)
            self.assertEqual(proposal["notice"]["revision"], 0)
            vault.assert_not_called()
            model.assert_not_called()
        self.assertEqual(self.client.get(self.url).json()["notice"]["text"], "")
        self.assertEqual(self.write(proposal["text"], proposal["notice"]["revision"]).status_code, 200)
        self.client.force_login(self.factory)
        self.assertContains(self.client.get("/enterprise/"), "&lt;script&gt;纯文本&lt;/script&gt;")

    def test_local_draft_owner_only_bounds_and_stale_confirmation(self):
        url = "/api/enterprise/operations/assistant/"
        local_tech = get_user_model().objects.create_user("synthetic-local-tech", password=None)
        local_tech.user_permissions.add(Permission.objects.get(codename="use_server_operations"))
        for user in (self.tech, local_tech, self.factory):
            self.client.force_login(user)
            self.assertEqual(self.client.post(url, {"message": "发布公告 合成"}, content_type="application/json").status_code, 403)
        self.client.force_login(self.owner)
        for text in ("", "x" * 501, "bad\x00text"):
            self.assertEqual(self.client.post(url, {"message": "替换公告 " + text}, content_type="application/json").status_code, 400)
        response = self.client.post(url, {"message": "替换公告 " + "字" * 500}, content_type="application/json")
        self.assertEqual(response.status_code, 200)
        base = response.json()["proposal"]["notice"]["revision"]
        self.assertEqual(self.write("并行更新", base).status_code, 200)
        self.assertEqual(self.write("待确认草稿", base).status_code, 409)
        self.owner.groups.clear()
        self.assertEqual(self.write("撤权草稿", base + 1).status_code, 403)


    def test_local_withdrawal_snapshot_empty_and_no_model_or_write(self):
        self.client.force_login(self.owner)
        url = "/api/enterprise/operations/assistant/"
        with patch.object(operations, "vault") as vault, patch.object(operations_ai, "classify") as model:
            empty = self.client.post(url, {"message": "撤下公告"}, content_type="application/json").json()
            self.assertIsNone(empty["proposal"])
            self.assertEqual(empty["notice"]["text"], "")
            self.write("现有公告\n<script>纯文本</script>", 0)
            proposal = self.client.post(url, {"message": "撤下公告"}, content_type="application/json").json()["proposal"]
            self.assertEqual(proposal["action"], "prepare_website_notice_withdrawal")
            self.assertEqual(proposal["notice"]["text"], "现有公告\n<script>纯文本</script>")
            self.assertEqual(proposal["notice"]["revision"], 1)
            self.assertEqual(self.client.get(self.url).json()["notice"], proposal["notice"])
            vault.assert_not_called()
            model.assert_not_called()
        self.assertEqual(self.write("", proposal["notice"]["revision"]).status_code, 200)
        self.client.force_login(self.factory)
        self.assertNotContains(self.client.get("/enterprise/"), "纯文本")

    def test_withdrawal_roles_stale_and_revocation(self):
        url = "/api/enterprise/operations/assistant/"
        local_tech = get_user_model().objects.create_user("withdraw-local-tech", password=None)
        local_tech.user_permissions.add(Permission.objects.get(codename="use_server_operations"))
        for user in (self.tech, local_tech, self.factory):
            self.client.force_login(user)
            self.assertEqual(self.client.post(url, {"message": "撤下公告"}, content_type="application/json").status_code, 403)
        self.client.force_login(self.owner)
        self.write("原公告", 0)
        proposal = self.client.post(url, {"message": "撤下公告"}, content_type="application/json").json()["proposal"]
        self.write("另一窗口新公告", 1)
        self.assertEqual(self.write("", proposal["notice"]["revision"]).status_code, 409)
        self.assertEqual(self.client.get(self.url).json()["notice"]["text"], "另一窗口新公告")
        self.owner.groups.clear()
        self.assertEqual(self.write("", 2).status_code, 403)


class ProviderTests(SimpleTestCase):
    def provider(self, content):
        response = Mock()
        response.__enter__ = Mock(return_value=io.BytesIO(json.dumps({"choices": [{"message": {"content": content}}]}).encode()))
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        return opener

    def test_fixed_endpoint_minimal_prompt_and_strict_output(self):
        opener = self.provider('{"action":"health"}')
        with patch.object(operations_ai.request, "build_opener", return_value=opener):
            self.assertEqual(operations_ai.classify("查看服务", "synthetic-key"), "health")
        req = opener.open.call_args.args[0]
        self.assertEqual(req.full_url, operations_ai.ENDPOINT)
        self.assertEqual(req.get_header("Authorization"), "Bearer synthetic-key")
        payload = json.loads(req.data)
        self.assertEqual(payload["messages"][1], {"role": "user", "content": "查看服务"})
        self.assertEqual(len(payload["messages"]), 2)
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        for content in ['{"action":"shell"}', '{"action":"health","text":"<script>"}', 'not json']:
            with patch.object(operations_ai.request, "build_opener", return_value=self.provider(content)):
                with self.assertRaises(ValueError):
                    operations_ai.classify("test", "synthetic-key")
        self.assertIsNone(operations_ai.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.invalid"))
