from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("auth", "0012_alter_user_first_name_max_length"),
        ("workbench", "0001_initial"),
    ]
    operations = [
        migrations.CreateModel(
            name="EnterpriseEntry",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("body", models.CharField(max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("created_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="enterprise_entries", to=settings.AUTH_USER_MODEL)),
                ("factory_group", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="enterprise_entries", to="auth.group")),
                ("task", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="enterprise_entries", to="workbench.task")),
            ],
            options={
                "ordering": ["-created_at", "-id"],
                "permissions": [("view_all_enterpriseentry", "Can view all enterprise entries"), ("view_business_data", "Can view shared business task and product data")],
            },
        ),
    ]
