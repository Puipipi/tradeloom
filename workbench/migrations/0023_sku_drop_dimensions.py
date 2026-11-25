# 去掉关税、包装长宽高、重量五列。
#
# 理由：关税改按渠道口径统一算（CHANNELS.duty），不再逐 SKU 填；
# 长宽高与重量没有数据源、也不参与任何计算，留着只会让人以为必须填。
# 成本表当前为空，删列无数据损失；万一将来要恢复，重新加字段并放开
# sku.service.FILLABLE 即可。
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("workbench", "0022_sku_import_json"),
    ]

    operations = [
        migrations.RemoveField(model_name="SkuCostEntry", name="duty"),
        migrations.RemoveField(model_name="SkuCostEntry", name="length"),
        migrations.RemoveField(model_name="SkuCostEntry", name="width"),
        migrations.RemoveField(model_name="SkuCostEntry", name="height"),
        migrations.RemoveField(model_name="SkuCostEntry", name="weight_oz"),
    ]
