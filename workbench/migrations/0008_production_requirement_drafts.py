# Generated for the production-requirement draft API.
import django.db.models.deletion
import workbench.models
from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):
    dependencies = [("workbench", "0007_narrative_evidence_sources")]

    operations = [
        migrations.CreateModel(
            name="ProductionRequirementDraft",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("record_kind", models.CharField(choices=[("new_demand", "New demand"), ("historical_reference", "Historical reference")], max_length=32)),
                ("status", models.CharField(choices=[("needs_confirmation", "Needs confirmation"), ("confirmed", "Confirmed")], default="needs_confirmation", max_length=24)),
                ("current_revision", models.PositiveIntegerField(default=1)),
                ("actor", models.CharField(default="local_workbench", max_length=32)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("source_candidate", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="requirement_drafts", to="workbench.intakecandidate")),
            ],
            options={"ordering": ["-created_at", "-id"]},
        ),
        migrations.AddConstraint(
            model_name="productionrequirementdraft",
            constraint=models.UniqueConstraint(fields=("source_candidate",), name="uniq_req_draft_candidate"),
        ),
        migrations.CreateModel(
            name="ProductionRequirementRevision",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("revision", models.PositiveIntegerField()),
                ("fields", models.JSONField(default=dict)),
                ("unresolved_fields", models.JSONField(default=dict)),
                ("confirmed_unit_pair", models.JSONField(blank=True, null=True)),
                ("status", models.CharField(choices=[("needs_confirmation", "Needs confirmation"), ("confirmed", "Confirmed")], default="needs_confirmation", max_length=24)),
                ("actor", models.CharField(default="local_workbench", max_length=32)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("draft", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="revisions", to="workbench.productionrequirementdraft")),
            ],
            options={"ordering": ["draft_id", "revision"]},
        ),
        migrations.AddConstraint(
            model_name="productionrequirementrevision",
            constraint=models.UniqueConstraint(fields=("draft", "revision"), name="uniq_req_revision_number"),
        ),
        migrations.AlterField(
            model_name="evidencerecord", name="candidate",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="evidence_records", to="workbench.intakecandidate"),
        ),
        migrations.AddField(
            model_name="evidencerecord", name="requirement_revision",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="evidence_records", to="workbench.productionrequirementrevision"),
        ),
        migrations.RemoveConstraint(model_name="evidencerecord", name="uniq_intake_evidence_revision"),
        migrations.AddConstraint(
            model_name="evidencerecord",
            constraint=models.CheckConstraint(
                condition=(Q(candidate__isnull=False, requirement_revision__isnull=True) |
                           Q(candidate__isnull=True, requirement_revision__isnull=False)),
                name="intake_evidence_one_target",
            ),
        ),
        migrations.AddConstraint(
            model_name="evidencerecord",
            constraint=models.UniqueConstraint(fields=("candidate", "field_key", "kind", "revision"),
                condition=Q(candidate__isnull=False), name="uniq_intake_evidence_candidate_revision"),
        ),
        migrations.AddConstraint(
            model_name="evidencerecord",
            constraint=models.UniqueConstraint(fields=("requirement_revision", "field_key", "kind", "revision"),
                condition=Q(requirement_revision__isnull=False), name="uniq_req_evidence_revision"),
        ),
    ]
