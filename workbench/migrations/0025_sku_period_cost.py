# SKU 只算商品成本：广告/退货/店铺月费移出单件成本，改为按月登记。
#
# 起因：ACOS 与退货率逐单都不一样，把它们当固定费率乘进售价，得到的是一个
# 假设模型——既解释不了「这一单赚了多少」，也没法用实际数校准。
# 所以：
#   1. 删掉 SkuCostEntry.acos（SKU 上不再有「估的广告费率」）；
#   2. 新增 SkuPeriodCost，按「市场 × 月份」登记实际发生的广告花费、退货损失、
#      店铺月费、其他费用。
# 商品毛利由 service 层算（售价 − 到岸成本 − 佣金），经营净利在汇总层
# 用「商品毛利 × 月销 − 期间费用」得到，两者不混。
#
# 已有 acos 数值不迁移：那是估算的费率，转成金额没有真实依据，
# 宁可空着让人按月填实际数，也不把假数搬进一张会当真的表。
import workbench.models
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workbench", "0024_sku_duty_rates"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="skucostentry",
            name="acos",
        ),
        migrations.CreateModel(
            name="SkuPeriodCost",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("market", models.CharField(max_length=8)),
                ("month", models.CharField(max_length=7)),
                ("ad_spend_cny", models.DecimalField(blank=True, decimal_places=2, max_digits=18, null=True)),
                ("returns_cny", models.DecimalField(blank=True, decimal_places=2, max_digits=18, null=True)),
                ("shop_fee_cny", models.DecimalField(blank=True, decimal_places=2, max_digits=18, null=True)),
                ("other_cny", models.DecimalField(blank=True, decimal_places=2, max_digits=18, null=True)),
                ("note", models.CharField(blank=True, default="", max_length=200)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["-month", "market"],
                "constraints": [
                    models.UniqueConstraint(fields=("market", "month"), name="sku_period_market_month_unique"),
                ],
            },
        ),
    ]
