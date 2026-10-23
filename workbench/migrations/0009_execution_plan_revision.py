# Generated for the append-only execution-plan draft API.
import django.db.models.deletion
import workbench.models
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("workbench", "0008_production_requirement_drafts")]

    operations = [
        migrations.CreateModel(
            name="ExecutionPlanRevision",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("revision", models.PositiveIntegerField()),
                ("status", models.CharField(choices=[("draft", "Draft")], default="draft", max_length=16)),
                ("requirement_refs", models.JSONField(default=list)),
                ("materials", models.JSONField(default=list)),
                ("operations", models.JSONField(default=list)),
                ("actor", models.CharField(default="local_workbench", max_length=32)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("requirement_revision", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT,
                    related_name="execution_plan_revisions", to="workbench.productionrequirementrevision")),
            ],
            options={"ordering": ["requirement_revision_id", "revision"]},
        ),
        migrations.AddConstraint(
            model_name="executionplanrevision",
            constraint=models.UniqueConstraint(fields=("requirement_revision", "revision"), name="uniq_execution_plan_revision"),
        ),
        migrations.AddConstraint(
            model_name="executionplanrevision",
            constraint=models.CheckConstraint(condition=models.Q(("revision__gt", 0)), name="execution_plan_revision_positive"),
        ),
        migrations.AddConstraint(
            model_name="executionplanrevision",
            constraint=models.CheckConstraint(condition=models.Q(("status", "draft")), name="execution_plan_draft_only"),
        ),
    ]
