from django.db import migrations, models
import django.db.models.deletion
import workbench.models


class Migration(migrations.Migration):
    dependencies = [("workbench", "0004_erpnext_draft_operation")]

    operations = [
        migrations.CreateModel(
            name="IntakeSourceVersion",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("sha256", models.CharField(max_length=64, unique=True)),
                ("storage_key", models.CharField(max_length=80, unique=True)),
                ("original_name", models.CharField(max_length=255)),
                ("byte_size", models.PositiveBigIntegerField()),
                ("mime_type", models.CharField(max_length=120)),
                ("received_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"ordering": ["-received_at"]},
            managers=[("objects", workbench.models.AppendOnlyQuerySet.as_manager())],
        ),
        migrations.CreateModel(
            name="WorkbookSnapshot",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("parser_version", models.CharField(max_length=40)),
                ("status", models.CharField(max_length=20)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("warnings", models.JSONField(default=list)),
                ("sheet_count", models.PositiveIntegerField(default=0)),
                ("cell_count", models.PositiveIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("source", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="snapshots", to="workbench.intakesourceversion")),
            ],
            options={"ordering": ["-created_at"]},
            managers=[("objects", workbench.models.AppendOnlyQuerySet.as_manager())],
        ),
        migrations.CreateModel(
            name="WorkbookSheetSnapshot",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("sheet_index", models.PositiveSmallIntegerField()),
                ("title", models.CharField(max_length=255)),
                ("dimensions", models.CharField(blank=True, default="", max_length=64)),
                ("merged_ranges", models.JSONField(default=list)),
                ("source_part", models.CharField(max_length=255)),
                ("warnings", models.JSONField(default=list)),
                ("snapshot", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="sheets", to="workbench.workbooksnapshot")),
            ],
            options={"ordering": ["sheet_index"]},
            managers=[("objects", workbench.models.AppendOnlyQuerySet.as_manager())],
        ),
        migrations.CreateModel(
            name="SourceCellSnapshot",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("coordinate", models.CharField(max_length=16)),
                ("source_type", models.CharField(blank=True, default="", max_length=24)),
                ("raw_value", models.JSONField(blank=True, null=True)),
                ("normalized_value", models.JSONField(blank=True, null=True)),
                ("formula", models.TextField(blank=True, default="")),
                ("cached_value", models.JSONField(blank=True, null=True)),
                ("number_format", models.CharField(blank=True, default="", max_length=120)),
                ("formula_status", models.CharField(blank=True, default="", max_length=24)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("sheet", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="cells", to="workbench.workbooksheetsnapshot")),
            ],
            options={"ordering": ["coordinate"]},
            managers=[("objects", workbench.models.AppendOnlyQuerySet.as_manager())],
        ),
        migrations.CreateModel(
            name="WorkbookImageReference",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("kind", models.CharField(max_length=24)),
                ("coordinate", models.CharField(blank=True, default="", max_length=16)),
                ("anchor", models.JSONField(blank=True, null=True)),
                ("source_part", models.CharField(max_length=255)),
                ("relationship_id", models.CharField(blank=True, default="", max_length=120)),
                ("target_part", models.CharField(blank=True, default="", max_length=255)),
                ("mime_type", models.CharField(blank=True, default="", max_length=120)),
                ("rich_value_index", models.PositiveIntegerField(blank=True, null=True)),
                ("relationship_slot", models.PositiveIntegerField(blank=True, null=True)),
                ("warning_code", models.CharField(blank=True, default="", max_length=64)),
                ("sheet", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="image_references", to="workbench.workbooksheetsnapshot")),
                ("snapshot", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="image_references", to="workbench.workbooksnapshot")),
            ],
            options={"ordering": ["sheet_id", "coordinate", "source_part"]},
            managers=[("objects", workbench.models.AppendOnlyQuerySet.as_manager())],
        ),
        migrations.AddConstraint(model_name="workbooksnapshot", constraint=models.UniqueConstraint(fields=("source", "parser_version"), name="uniq_intake_source_parser")),
        migrations.AddConstraint(model_name="workbooksheetsnapshot", constraint=models.UniqueConstraint(fields=("snapshot", "sheet_index"), name="uniq_intake_snapshot_sheet")),
        migrations.AddConstraint(model_name="sourcecellsnapshot", constraint=models.UniqueConstraint(fields=("sheet", "coordinate"), name="uniq_intake_sheet_cell")),
    ]
