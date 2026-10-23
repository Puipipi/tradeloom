from django.db import migrations, models
import django.db.models.deletion
import workbench.models


class Migration(migrations.Migration):
    dependencies = [("workbench", "0010_intake_candidate_link_history")]

    operations = [
        migrations.CreateModel(
            name="NarrativeAnnotationRevision",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("revision", models.PositiveIntegerField()),
                ("source_kind", models.CharField(choices=[("transcript_excerpt", "Transcript excerpt"), ("secondary_summary_analysis", "Secondary summary or analysis"), ("user_supplement", "User supplement"), ("unknown", "Unknown")], max_length=40)),
                ("recording_date", models.DateField(blank=True, null=True)),
                ("audio_review_status", models.CharField(choices=[("unknown", "Unknown"), ("not_checked", "Not checked"), ("operator_claimed_checked", "Operator claimed checked")], max_length=32)),
                ("content_status", models.CharField(choices=[("unconfirmed", "Unconfirmed")], default="unconfirmed", max_length=16)),
                ("actor", models.CharField(default="local_workbench", max_length=32)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("source", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="annotation_revisions", to="workbench.narrativesourceversion")),
            ],
            options={"ordering": ["source_id", "revision"]},
        ),
        migrations.AddConstraint(
            model_name="narrativeannotationrevision",
            constraint=models.UniqueConstraint(fields=("source", "revision"), name="uniq_narrative_annotation_revision"),
        ),
        migrations.AddConstraint(
            model_name="narrativeannotationrevision",
            constraint=models.CheckConstraint(condition=models.Q(("revision__gt", 0)), name="narrative_annotation_revision_positive"),
        ),
        migrations.AddConstraint(
            model_name="narrativeannotationrevision",
            constraint=models.CheckConstraint(condition=models.Q(("content_status", "unconfirmed")), name="narrative_annotation_unconfirmed"),
        ),
    ]
