from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("workbench", "0014_business_dispatch")]

    operations = [
        migrations.CreateModel(
            name="CanvasWorkflowDefinition",
            fields=[
                ("workflow_id", models.CharField(max_length=48, primary_key=True, serialize=False)),
                ("revision", models.PositiveBigIntegerField(default=1)),
                ("definition_revision", models.CharField(blank=True, max_length=71, null=True)),
                ("document", models.TextField(blank=True, null=True)),
                ("deleted", models.BooleanField(default=False)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["workflow_id"]},
        ),
        migrations.AddConstraint(
            model_name="canvasworkflowdefinition",
            constraint=models.CheckConstraint(condition=models.Q(("revision__gt", 0)), name="canvas_workflow_definition_revision_positive"),
        ),
    ]
