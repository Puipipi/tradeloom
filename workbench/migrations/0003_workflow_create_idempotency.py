from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("workbench", "0002_workflow_domain"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowtask",
            name="creation_idempotency_key",
            field=models.CharField(
                blank=True,
                max_length=200,
                null=True,
                unique=True,
            ),
        ),
        migrations.AddField(
            model_name="workflowtask",
            name="creation_request_fingerprint",
            field=models.CharField(blank=True, max_length=64, null=True),
        ),
        migrations.AddField(
            model_name="workflowtask",
            name="creation_receipt",
            field=models.JSONField(blank=True, null=True),
        ),
    ]
