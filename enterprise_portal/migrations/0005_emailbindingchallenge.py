from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("enterprise_portal", "0004_emailloginchallenge"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]
    operations = [
        migrations.CreateModel(
            name="EmailBindingChallenge",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("email", models.EmailField(blank=True, max_length=254)),
                ("token", models.CharField(blank=True, max_length=64)),
                ("code_digest", models.CharField(blank=True, max_length=64)),
                ("credential_version", models.CharField(blank=True, max_length=64)),
                ("expires_at", models.DateTimeField(null=True)),
                ("last_sent_at", models.DateTimeField(null=True)),
                ("window_started_at", models.DateTimeField(null=True)),
                ("sends_in_window", models.PositiveSmallIntegerField(default=0)),
                ("attempts_left", models.PositiveSmallIntegerField(default=0)),
                ("user", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL)),
            ],
        ),
    ]
