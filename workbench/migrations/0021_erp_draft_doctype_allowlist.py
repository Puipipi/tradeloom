from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workbench", "0020_business_documents"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="erpnextdraftoperation",
            name="erp_draft_fixed_quotation",
        ),
        migrations.AddConstraint(
            model_name="erpnextdraftoperation",
            constraint=models.CheckConstraint(
                condition=models.Q(("doctype", "Quotation")) | models.Q(("doctype", "Purchase Order")),
                name="erp_draft_doctype_allowlist",
            ),
        ),
    ]
