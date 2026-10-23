from django.db import migrations, models
import django.db.models.deletion
import workbench.models


class Migration(migrations.Migration):
    dependencies = [
        ("workbench", "0003_workflow_create_idempotency"),
    ]

    operations = [
        migrations.CreateModel(
            name="ErpNextDraftOperation",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("instance_id", models.CharField(max_length=128)),
                ("idempotency_key", models.CharField(max_length=200)),
                ("action", models.CharField(choices=[("create", "创建草稿"), ("update", "修改草稿")], max_length=16)),
                ("fingerprint", models.CharField(max_length=64)),
                ("payload_sha256", models.CharField(max_length=64)),
                ("request_payload", models.JSONField()),
                ("expected_modified", models.CharField(blank=True, default="", max_length=64)),
                ("doctype", models.CharField(default="Quotation", max_length=32)),
                ("source", models.CharField(choices=[("local_workbench", "本地工作台"), ("dsh_center", "中心 Agent")], max_length=32)),
                ("status", models.CharField(choices=[("reserved", "操作已预留"), ("succeeded", "已回读确认"), ("outcome_unknown", "结果待调和"), ("conflict", "远端版本冲突")], default="outcome_unknown", max_length=24)),
                ("remote_name", models.CharField(blank=True, default="", max_length=255)),
                ("remote_modified", models.CharField(blank=True, default="", max_length=64)),
                ("receipt", models.JSONField(blank=True, null=True)),
                ("result_ref", models.JSONField(default=dict)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("target_operation", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="updates", to="workbench.erpnextdraftoperation")),
                ("workflow", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="erpnext_draft_operations", to="workbench.workflowtask")),
            ],
            options={"ordering": ["created_at", "id"]},
        ),
        migrations.AddConstraint(
            model_name="erpnextdraftoperation",
            constraint=models.UniqueConstraint(fields=("instance_id", "idempotency_key"), name="uniq_erp_draft_instance_key"),
        ),
        migrations.AddConstraint(
            model_name="erpnextdraftoperation",
            constraint=models.CheckConstraint(condition=models.Q(("doctype", "Quotation")), name="erp_draft_fixed_quotation"),
        ),
    ]
