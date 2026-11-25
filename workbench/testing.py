from __future__ import annotations

import os
import re
import uuid
from contextlib import contextmanager

import psycopg
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import connection
from django.test.runner import DiscoverRunner


_TEST_DATABASE_PATTERN = re.compile(r"tradeloom_test_[a-z0-9_]+")


@contextmanager
def fresh_migration_database():
    """一次性 tradeloom_test_migration_* 库，并把默认连接切过去，用完即删。

    0017 起的 workbench 迁移不可逆，共享测试库禁止回滚穿越；迁移类测试改用
    本上下文从零正向迁移，全程不触碰共享测试库。
    """
    settings_dict = connection.settings_dict
    original_name = settings_dict["NAME"]
    db_name = f"tradeloom_test_migration_{uuid.uuid4().hex[:12]}"
    if not _TEST_DATABASE_PATTERN.fullmatch(db_name):
        raise ImproperlyConfigured("一次性迁移库名不符合 tradeloom_test_* 约定")
    admin_kwargs = {
        "dbname": "postgres",
        "host": settings_dict.get("HOST") or None,
        "port": settings_dict.get("PORT") or None,
        "user": settings_dict.get("USER") or None,
        "password": settings_dict.get("PASSWORD") or "",
    }
    connection.close()
    admin = psycopg.connect(autocommit=True, **admin_kwargs)
    try:
        admin.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        admin.close()
    connection.settings_dict["NAME"] = db_name
    try:
        yield connection
    finally:
        connection.close()
        connection.settings_dict["NAME"] = original_name
        admin = psycopg.connect(autocommit=True, **admin_kwargs)
        try:
            admin.execute(f'DROP DATABASE "{db_name}" WITH (FORCE)')
        finally:
            admin.close()


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
