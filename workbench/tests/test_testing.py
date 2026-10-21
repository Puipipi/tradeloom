from __future__ import annotations

import os
from copy import deepcopy
from unittest.mock import patch

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase
from django.test.utils import get_runner

from workbench.agents.schema_validation import validate_json_contract


class TestDatabaseGuardTests(SimpleTestCase):
    def make_runner(self, *, keepdb=True):
        return get_runner(settings)(verbosity=0, interactive=False, keepdb=keepdb)

    def assert_rejected_before_database_setup(
        self, test_name, env_name, production_name="tradeloom_dev"
    ):
        databases = deepcopy(settings.DATABASES)
        databases["default"]["NAME"] = production_name
        databases["default"]["TEST"] = {"NAME": test_name}
        environment = {
            "TRADELOOM_DB_TEST_NAME": env_name,
            "TRADELOOM_TEST_DB_NAME": "tradeloom_test_wrong_name",
        }
        with (
            patch.object(settings, "DATABASES", databases),
            patch.dict(os.environ, environment, clear=False),
            patch("django.test.runner.DiscoverRunner.setup_databases") as setup,
        ):
            with self.assertRaises(ImproperlyConfigured):
                self.make_runner().setup_databases()
        setup.assert_not_called()

    def test_missing_canonical_environment_variable_rejects_before_database_setup(self):
        databases = deepcopy(settings.DATABASES)
        databases["default"]["NAME"] = "tradeloom_dev"
        databases["default"]["TEST"] = {"NAME": "tradeloom_test_phase4_inputs"}
        with (
            patch.object(settings, "DATABASES", databases),
            patch.dict(os.environ, {"TRADELOOM_TEST_DB_NAME": "tradeloom_test_phase4_inputs"}, clear=False),
            patch.dict(os.environ, {}, clear=False) as environment,
            patch("django.test.runner.DiscoverRunner.setup_databases") as setup,
        ):
            environment.pop("TRADELOOM_DB_TEST_NAME", None)
            with self.assertRaises(ImproperlyConfigured):
                self.make_runner().setup_databases()
        setup.assert_not_called()

    def test_default_test_database_name_rejects_before_database_setup(self):
        self.assert_rejected_before_database_setup("tradeloom_test", "tradeloom_test")

    def test_production_database_name_rejects_before_database_setup(self):
        self.assert_rejected_before_database_setup("tradeloom_dev", "tradeloom_dev")

    def test_validly_named_test_database_cannot_equal_production_database(self):
        name = "tradeloom_test_phase4_inputs"
        self.assert_rejected_before_database_setup(name, name, production_name=name)

    def test_environment_and_django_test_name_must_match(self):
        self.assert_rejected_before_database_setup(
            "tradeloom_test_phase4_inputs", "tradeloom_test_other"
        )

    def test_explicit_disposable_test_database_reaches_parent_setup(self):
        databases = deepcopy(settings.DATABASES)
        databases["default"]["NAME"] = "tradeloom_dev"
        databases["default"]["TEST"] = {"NAME": "tradeloom_test_phase4_inputs"}
        with (
            patch.object(settings, "DATABASES", databases),
            patch.dict(
                os.environ,
                {"TRADELOOM_DB_TEST_NAME": "tradeloom_test_phase4_inputs"},
                clear=False,
            ),
            patch("django.test.runner.DiscoverRunner.setup_databases", return_value="ok") as setup,
        ):
            result = self.make_runner().setup_databases()
        self.assertEqual(result, "ok")
        setup.assert_called_once()

    def test_missing_keepdb_flag_rejects_before_parent_database_setup(self):
        databases = deepcopy(settings.DATABASES)
        databases["default"]["NAME"] = "tradeloom_dev"
        databases["default"]["TEST"] = {"NAME": "tradeloom_test_phase4_inputs"}
        with (
            patch.object(settings, "DATABASES", databases),
            patch.dict(
                os.environ,
                {"TRADELOOM_DB_TEST_NAME": "tradeloom_test_phase4_inputs"},
                clear=False,
            ),
            patch("django.test.runner.DiscoverRunner.setup_databases") as setup,
        ):
            with self.assertRaises(ImproperlyConfigured):
                self.make_runner(keepdb=False).setup_databases()
        setup.assert_not_called()

    def test_schema_validation_rejects_non_standard_json_values(self):
        with self.assertRaises(ValueError):
            validate_json_contract({"extension": float("nan")}, {"type": "object"})
