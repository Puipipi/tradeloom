from __future__ import annotations

import workbench.models
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Task",
            fields=[
                (
                    "id",
                    models.CharField(
                        default=workbench.models.hex_uuid,
                        editable=False,
                        max_length=32,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("title", models.CharField(max_length=200)),
                ("mode", models.CharField(max_length=20)),
                ("status", models.CharField(max_length=40)),
                ("created_at", models.DateTimeField()),
                ("updated_at", models.DateTimeField()),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="TaskFile",
            fields=[
                (
                    "id",
                    models.CharField(
                        default=workbench.models.hex_uuid,
                        editable=False,
                        max_length=32,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("kind", models.CharField(max_length=32)),
                ("original_name", models.CharField(max_length=255)),
                ("stored_name", models.CharField(max_length=255)),
                ("created_at", models.DateTimeField()),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="files",
                        to="workbench.task",
                    ),
                ),
            ],
            options={"ordering": ["created_at"]},
        ),
        migrations.CreateModel(
            name="Product",
            fields=[
                (
                    "id",
                    models.CharField(
                        default=workbench.models.hex_uuid,
                        editable=False,
                        max_length=32,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("position", models.PositiveIntegerField()),
                ("sku", models.CharField(max_length=120)),
                ("name", models.CharField(max_length=200)),
                ("category", models.CharField(max_length=120)),
                ("material", models.CharField(max_length=200)),
                ("size", models.CharField(max_length=120)),
                ("color", models.CharField(max_length=120)),
                ("image_filename", models.CharField(max_length=255)),
                (
                    "image_stored_name",
                    models.CharField(blank=True, default="", max_length=255),
                ),
                ("missing_fields", models.JSONField(default=list)),
                ("created_at", models.DateTimeField()),
                ("updated_at", models.DateTimeField()),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="products",
                        to="workbench.task",
                    ),
                ),
            ],
            options={"ordering": ["position"]},
        ),
        migrations.CreateModel(
            name="AgentRun",
            fields=[
                (
                    "run_id",
                    models.CharField(
                        default=workbench.models.hex_uuid,
                        editable=False,
                        max_length=32,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("capability_id", models.CharField(max_length=64)),
                ("status", models.CharField(max_length=32)),
                ("started_at", models.DateTimeField()),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("result", models.JSONField(blank=True, null=True)),
                ("error", models.TextField(blank=True, null=True)),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="agent_runs",
                        to="workbench.task",
                    ),
                ),
            ],
            options={"ordering": ["-started_at"]},
        ),
    ]
