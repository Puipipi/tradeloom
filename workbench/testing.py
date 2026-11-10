from __future__ import annotations

import os
import re

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.test.runner import DiscoverRunner


_TEST_DATABASE_PATTERN = re.compile(r"tradeloom_test_[a-z0-9_]+")


class IsolatedTestDatabaseRunner(DiscoverRunner):
    """Require an explicitly named disposable database before Django setup."""

    def setup_databases(self, **kwargs):
        if not self.keepdb:
            raise ImproperlyConfigured(
                "工作台测试必须使用 --keepdb，避免 Django 自动删除已有测试库。"
            )
        configured_name = os.environ.get("TRADELOOM_DB_TEST_NAME")
        database_config = settings.DATABASES.get("default", {})
        test_config = database_config.get("TEST", {})
        test_name = test_config.get("NAME")
        production_name = database_config.get("NAME")

        if (
            not configured_name
            or configured_name != test_name
            or not _TEST_DATABASE_PATTERN.fullmatch(configured_name)
            or configured_name == production_name
        ):
            raise ImproperlyConfigured(
                "设置 TRADELOOM_DB_TEST_NAME 为显式的 tradeloom_test_* 隔离库名，"
                "并确保它与 Django TEST.NAME 一致且不同于业务库。"
            )
        return super().setup_databases(**kwargs)
