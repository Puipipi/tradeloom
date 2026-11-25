
import datetime

from django.contrib.auth.models import Group, Permission, User
from django.urls import reverse
from django.utils import timezone

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.models import Product, Task


class ProductSearchTests(EmailVerifiedTestCase):
    @classmethod
    def setUpTestData(cls):
        now = timezone.now()
        task = Task.objects.create(title="合成测试批次", mode="test", status="completed", created_at=now, updated_at=now)
        Product.objects.bulk_create([
            Product(task=task, position=index, sku=f"SKU-{index:03d}",
                    name=f"商品 {index}" if index else "唯一旧商品 <测试>",
                    image_stored_name="private.test.marker", created_at=now,
                    updated_at=now + datetime.timedelta(seconds=index))
            for index in range(110)
        ])
        owner_group = Group.objects.create(name="企业老板")
        factory_group = Group.objects.create(name="工厂登记员")
        cls.owner = User.objects.create_user(username="search-owner", email="search-owner@example.test")
        cls.factory = User.objects.create_user(username="search-factory", email="search-factory@example.test")
        grants = Permission.objects.filter(
            content_type__app_label="enterprise_portal", codename__in=("view_business_data", "view_all_enterpriseentry")
        )
        for user, group in ((cls.owner, owner_group), (cls.factory, factory_group)):
            group.permissions.add(*grants)
            user.groups.add(group)

    def test_fixed_projection_finds_old_products_and_preserves_order(self):
        self.client.force_login(self.owner)
        url = reverse("enterprise-products")
        first = self.client.get(url)
        self.assertContains(first, "SKU-109")
        self.assertNotContains(first, "SKU-000")
        self.assertContains(first, "合成测试批次")
        fifth = self.client.get(url, {"page": 5, "q": "SKU-"})
        self.assertContains(fifth, "SKU-000")
        self.assertNotContains(fifth, "SKU-109")
        self.assertNotContains(fifth, "private.test.marker")
        exact = self.client.get(url, {"q": "sku-000"})
        self.assertContains(exact, "唯一旧商品 &lt;测试&gt;")
        self.assertContains(self.client.get(url, {"q": "唯一旧商品"}), "SKU-000")
        self.assertContains(self.client.get(url, {"q": "零结果"}), "没有符合条件")
        for query in ("?q=" + "x" * 121, "?field=price", "?q=x&q=y", "?page=0"):
            self.assertEqual(self.client.get(url + query).status_code, 400)
        self.assertEqual(self.client.get(reverse("enterprise-customers"), {"q": "SKU"}).status_code, 400)
        self.assertEqual(self.client.get(reverse("enterprise-quotations"), {"q": "SKU"}).status_code, 400)

    def test_search_keeps_factory_role_denied_with_direct_business_grant(self):
        self.client.force_login(self.factory)
        self.assertEqual(self.client.get(reverse("enterprise-products"), {"q": "SKU-000"}).status_code, 403)
