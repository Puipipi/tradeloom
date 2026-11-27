# SKU 台账建表：清单、成本、设置、汇率快照、导入流水。
import workbench.models
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workbench", "0020_business_documents"),
    ]

    operations = [
        migrations.CreateModel(
            name="SkuCatalogImport",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("source", models.CharField(max_length=64)),
                ("added", models.PositiveIntegerField(default=0)),
                ("updated", models.PositiveIntegerField(default=0)),
                ("skipped", models.PositiveIntegerField(default=0)),
                ("total", models.PositiveIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "ordering": ["-created_at", "id"],
            },
        ),
        migrations.CreateModel(
            name="SkuCatalogItem",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("sku", models.CharField(max_length=120, unique=True)),
                ("name", models.CharField(blank=True, default="", max_length=300)),
                ("series", models.CharField(blank=True, default="", max_length=200)),
                ("sub_category", models.CharField(blank=True, default="", max_length=200)),
                ("material", models.CharField(blank=True, default="", max_length=300)),
                ("size", models.CharField(blank=True, default="", max_length=120)),
                ("url", models.CharField(blank=True, default="", max_length=500)),
                ("image", models.CharField(blank=True, default="", max_length=500)),
                ("active", models.BooleanField(default=True)),
                ("position", models.PositiveIntegerField(default=0)),
                ("source", models.CharField(default="manual", max_length=64)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["position", "sku"],
            },
        ),
        migrations.CreateModel(
            name="SkuCostEntry",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("sku", models.CharField(max_length=120, unique=True)),
                ("hs_code", models.CharField(blank=True, default="", max_length=40)),
                ("duty", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("price", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("price_currency", models.CharField(blank=True, default="", max_length=3)),
                ("cost_cny", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("freight_cny", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("length", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("width", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("height", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("weight_oz", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("units", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("commission", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("acos", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["sku"],
            },
        ),
        migrations.CreateModel(
            name="SkuFxSnapshot",
            fields=[
                ("id", models.PositiveSmallIntegerField(default=1, editable=False, primary_key=True, serialize=False)),
                ("base", models.CharField(default="USD", max_length=3)),
                ("rates", models.JSONField(blank=True, default=dict)),
                ("prev_rates", models.JSONField(blank=True, default=dict)),
                ("quotes", models.JSONField(blank=True, default=list)),
                ("sources", models.JSONField(blank=True, default=dict)),
                ("source", models.CharField(blank=True, default="", max_length=64)),
                ("source_count", models.PositiveSmallIntegerField(default=0)),
                ("divergent", models.BooleanField(default=False)),
                ("spread", models.DecimalField(decimal_places=6, default=0, max_digits=18)),
                ("checked_at", models.DateTimeField(blank=True, null=True)),
            ],
        ),
        migrations.CreateModel(
            name="SkuSetting",
            fields=[
                ("id", models.PositiveSmallIntegerField(default=1, editable=False, primary_key=True, serialize=False)),
                ("currency", models.CharField(default="USD", max_length=3)),
                ("channel", models.CharField(default="domestic_wholesale", max_length=40)),
                ("fx_mode", models.CharField(default="auto", max_length=10)),
                ("fx_manual", models.JSONField(blank=True, default=dict)),
                ("rebate", models.DecimalField(decimal_places=6, default=0, max_digits=18)),
                ("fixed_fee", models.DecimalField(blank=True, decimal_places=6, max_digits=18, null=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
        ),
    ]
