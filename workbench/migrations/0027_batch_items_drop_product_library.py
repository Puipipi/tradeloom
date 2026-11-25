"""用「批次产品行」（BatchItem）取代产品资料库。

删掉 `Product` / `ProductRevision` 两张表与整套版本体系，改由 `BatchItem`
承载「这一批货包含哪些 SKU」。产品资料库的查询、还原、版本接口在同一提交里
一并下线；执行前如仍有数据，会先复制到 `BatchItem`，再删旧表。
"""

from django.db import migrations, models
import django.db.models.deletion

import workbench.models


def copy_products_to_batch_items(apps, schema_editor):
    BatchItem = apps.get_model("workbench", "BatchItem")
    Product = apps.get_model("workbench", "Product")
    rows = [
        BatchItem(
            id=item.id,
            task_id=item.task_id,
            position=item.position,
            sku=item.sku,
            name=item.name,
            category=item.category,
            material=item.material,
            size=item.size,
            color=item.color,
            image_filename=item.image_filename,
            image_stored_name=item.image_stored_name,
            missing_fields=item.missing_fields,
            created_at=item.created_at,
            updated_at=item.updated_at,
        )
        for item in Product.objects.all().iterator()
    ]
    if rows:
        BatchItem.objects.bulk_create(rows, batch_size=500)


class Migration(migrations.Migration):

    dependencies = [
        ("workbench", "0026_sku_duty_preferred"),
    ]

    operations = [
        migrations.CreateModel(
            name="BatchItem",
            fields=[
                (
                    "id",
                    models.CharField(
                        default=workbench.models.hex_uuid,
                        editable=False,
                        max_length=32,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("position", models.PositiveIntegerField()),
                ("sku", models.CharField(max_length=120)),
                ("name", models.CharField(max_length=200)),
                ("category", models.CharField(max_length=120)),
                ("material", models.CharField(max_length=200)),
                ("size", models.CharField(max_length=120)),
                ("color", models.CharField(max_length=120)),
                ("image_filename", models.CharField(max_length=255)),
                (
                    "image_stored_name",
                    models.CharField(blank=True, default="", max_length=255),
                ),
                ("missing_fields", models.JSONField(default=list)),
                ("created_at", models.DateTimeField()),
                ("updated_at", models.DateTimeField()),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="batch_items",
                        to="workbench.task",
                    ),
                ),
            ],
            options={"ordering": ["position"]},
        ),
        migrations.RunPython(copy_products_to_batch_items, migrations.RunPython.noop),
        migrations.DeleteModel(name="ProductBatch"),
        migrations.DeleteModel(name="ProductRevision"),
        migrations.DeleteModel(name="Product"),
    ]
