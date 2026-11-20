from django.db import migrations, models
import workbench.models


class Migration(migrations.Migration):
    dependencies = [("workbench", "0013_native_artifact_version")]

    operations = [
        migrations.CreateModel(
            name="BusinessDispatch",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("kind", models.CharField(choices=[("notification", "Notification"), ("action", "Action")], max_length=16)),
                ("status", models.CharField(choices=[("queued", "Queued"), ("claimed", "Claimed"), ("acknowledged", "Acknowledged"), ("completed", "Completed"), ("failed", "Failed")], default="queued", max_length=16)),
                ("sender_session_id", models.CharField(db_index=True, max_length=256)),
                ("sender_agent_id", models.CharField(max_length=256)),
                ("sender_preset", models.CharField(max_length=80)),
                ("recipient_session_id", models.CharField(db_index=True, max_length=256)),
                ("recipient_agent_id", models.CharField(max_length=256)),
                ("recipient_preset", models.CharField(max_length=80)),
                ("source", models.CharField(max_length=200)),
                ("requirement", models.TextField(max_length=4000)),
                ("idempotency_key", models.CharField(max_length=200)),
                ("request_fingerprint", models.CharField(max_length=64)),
                ("delivery_result", models.JSONField(default=dict)),
                ("receipt", models.JSONField(blank=True, null=True)),
                ("receipt_fingerprint", models.CharField(blank=True, default="", max_length=64)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("claimed_at", models.DateTimeField(blank=True, null=True)),
                ("closed_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={"ordering": ["-created_at", "-id"]},
        ),
        migrations.AddConstraint(
            model_name="businessdispatch",
            constraint=models.UniqueConstraint(fields=("sender_session_id", "idempotency_key"), name="uniq_dispatch_sender_idem"),
        ),
        migrations.AddConstraint(
            model_name="businessdispatch",
            constraint=models.UniqueConstraint(
                condition=models.Q(("kind", "action"), ("status", "claimed")),
                fields=("recipient_session_id",),
                name="uniq_dispatch_action_claim_recipient",
            ),
        ),
    ]
