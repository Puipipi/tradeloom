import uuid

from django.db import migrations, models
from django.db.migrations.exceptions import IrreversibleError


def create_run_namespace(apps, schema_editor):
    namespace_model = apps.get_model("workbench", "CanvasWorkflowRunNamespace")
    namespace_model.objects.using(schema_editor.connection.alias).get_or_create(
        pk=1, defaults={"namespace_id": uuid.uuid4()}
    )


def refuse_unsafe_reverse(apps, schema_editor):
    raise IrreversibleError(
        "Workflow run ownership columns contain fencing state; keep this migration applied."
    )


class Migration(migrations.Migration):
    atomic = True

    dependencies = [
        ("workbench", "0016_merge_canvas_workflow_definition"),
    ]

    operations = [
        migrations.CreateModel(
            name="CanvasWorkflowRunNamespace",
            fields=[
                ("id", models.PositiveSmallIntegerField(default=1, editable=False, primary_key=True, serialize=False)),
                ("namespace_id", models.UUIDField(editable=False, unique=True)),
            ],
            options={
                "constraints": [
                    models.CheckConstraint(condition=models.Q(id=1), name="canvas_workflow_run_namespace_singleton"),
                ],
            },
        ),
        migrations.AddField(
            model_name="canvasworkflowrun",
            name="owner_namespace_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="canvasworkflowrun",
            name="owner_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="canvasworkflowrun",
            name="owner_epoch",
            field=models.BigIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="canvasworkflowrun",
            name="owner_token_hash",
            field=models.CharField(blank=True, max_length=64, null=True),
        ),
        migrations.AddField(
            model_name="canvasworkflowrun",
            name="owner_create_fingerprint",
            field=models.CharField(blank=True, max_length=64, null=True),
        ),
        migrations.AddField(
            model_name="canvasworkflowrun",
            name="owner_lease_expires_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="canvasworkflowrun",
            name="owner_released_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="canvasworkflowrun",
            name="owner_fenced_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(create_run_namespace, refuse_unsafe_reverse),
    ]
