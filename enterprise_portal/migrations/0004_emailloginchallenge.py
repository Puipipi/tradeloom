from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [("enterprise_portal", "0003_websitenotice"), migrations.swappable_dependency(settings.AUTH_USER_MODEL)]
    operations = [migrations.CreateModel(name="EmailLoginChallenge", fields=[
        ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
        ("token", models.CharField(max_length=64, unique=True)),
        ("code_digest", models.CharField(blank=True, max_length=64)),
        ("email", models.EmailField(max_length=254)),
        ("credential_version", models.CharField(max_length=64)),
        ("expires_at", models.DateTimeField()), ("last_sent_at", models.DateTimeField()),
        ("window_started_at", models.DateTimeField()),
        ("sends_in_window", models.PositiveSmallIntegerField(default=0)),
        ("attempts_left", models.PositiveSmallIntegerField(default=5)),
        ("user", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL)),
    ])]
