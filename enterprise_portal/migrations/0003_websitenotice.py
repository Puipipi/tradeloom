from django.db import migrations, models


def initialize(apps, schema_editor):
    apps.get_model("enterprise_portal", "WebsiteNotice").objects.create(pk=1)


class Migration(migrations.Migration):
    dependencies = [("enterprise_portal", "0002_server_operations_permission")]
    operations = [
        migrations.CreateModel(name="WebsiteNotice", fields=[
            ("id", models.PositiveSmallIntegerField(default=1, editable=False, primary_key=True, serialize=False)),
            ("text", models.CharField(blank=True, default="", max_length=500)),
            ("revision", models.PositiveIntegerField(default=0)),
            ("updated_at", models.DateTimeField(blank=True, null=True)),
        ]),
        migrations.RunPython(initialize, migrations.RunPython.noop),
    ]
