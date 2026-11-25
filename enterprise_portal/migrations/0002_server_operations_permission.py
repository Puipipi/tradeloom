from django.db import migrations

class Migration(migrations.Migration):
    dependencies = [("enterprise_portal", "0001_initial")]
    operations = [migrations.AlterModelOptions(name="enterpriseentry", options={
        "ordering": ["-created_at", "-id"],
        "permissions": [("view_all_enterpriseentry", "Can view all enterprise entries"),
                        ("view_business_data", "Can view shared business task and product data"),
                        ("use_server_operations", "Can use safe server diagnostics and operations assistant")],
    })]
