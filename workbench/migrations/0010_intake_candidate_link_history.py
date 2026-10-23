# Generated for append-only candidate-link decision history.
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("workbench", "0009_execution_plan_revision")]

    operations = [
        migrations.RemoveConstraint(
            model_name="intakecandidatelink",
            name="uniq_intake_candidate_link",
        ),
    ]
