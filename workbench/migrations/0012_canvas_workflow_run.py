from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("workbench", "0011_narrative_annotation_revision")]
    operations = [
        migrations.CreateModel(
            name="CanvasWorkflowRun",
            fields=[
                ("id", models.UUIDField(editable=False, primary_key=True, serialize=False)),
                ("workflow_id", models.CharField(db_index=True, max_length=48)),
                ("revision", models.PositiveIntegerField(default=1)),
                ("status", models.CharField(max_length=20)),
                ("execution_mode", models.CharField(max_length=20)),
                ("snapshot", models.JSONField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["-created_at", "-id"]},
        ),
        migrations.AddConstraint(
            model_name="canvasworkflowrun",
            constraint=models.UniqueConstraint(
                fields=("workflow_id",),
                condition=models.Q(status__in=["running", "waiting"]),
                name="canvas_one_active_workflow_run",
            ),
        ),
    ]
