# P1.5 机型层：ProductVariant / VariantComponent + 生产要求行机型引用列 + 演示机型种子。

import workbench.models
from django.db import migrations, models


def seed_demo_variant(apps, schema_editor):
    """植入演示机型（远红外桑拿房：主控制器标配、彩灯带选配），来源标注 demo_fixture。"""
    ProductVariant = apps.get_model("workbench", "ProductVariant")
    VariantComponent = apps.get_model("workbench", "VariantComponent")
    variant = ProductVariant.objects.create(
        variant_code="DEMO-SAUNA-001",
        name="远红外桑拿房（演示机型）",
        source="demo_fixture",
    )
    for position, item_ref, quantity, role in (
        (1, "MAT-CTRL-001", "1", "main"),
        (2, "MAT-LED-001", "2", "optional"),
    ):
        VariantComponent.objects.create(
            variant=variant, position=position, item_ref=item_ref, quantity=quantity, role=role,
        )


def unseed_demo_variant(apps, schema_editor):
    ProductVariant = apps.get_model("workbench", "ProductVariant")
    ProductVariant.objects.filter(source="demo_fixture").delete()


class Migration(migrations.Migration):

    dependencies = [
        ('workbench', '0021_erp_draft_doctype_allowlist'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProductVariant',
            fields=[
                ('id', models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('variant_code', models.CharField(max_length=140, unique=True)),
                ('name', models.CharField(max_length=200)),
                ('disabled', models.BooleanField(default=False)),
                ('source', models.CharField(default='manual', max_length=64)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['variant_code'],
            },
        ),
        migrations.CreateModel(
            name='VariantComponent',
            fields=[
                ('id', models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('position', models.PositiveIntegerField()),
                ('item_ref', models.CharField(max_length=140)),
                ('quantity', models.CharField(max_length=40)),
                ('role', models.CharField(choices=[('main', '标配'), ('optional', '选配')], default='main', max_length=16)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('variant', models.ForeignKey(on_delete=models.CASCADE, related_name='components', to='workbench.productvariant')),
            ],
            options={
                'ordering': ['variant_id', 'position', 'id'],
            },
        ),
        migrations.AddConstraint(
            model_name='variantcomponent',
            constraint=models.UniqueConstraint(fields=('variant', 'position'), name='uniq_variant_component_position'),
        ),
        migrations.AddField(
            model_name='productionrequirementline',
            name='variant_ref',
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='productionrequirementline',
            name='variant_status',
            field=models.CharField(default='unresolved', max_length=24),
        ),
        migrations.RunPython(seed_demo_variant, unseed_demo_variant),
    ]
