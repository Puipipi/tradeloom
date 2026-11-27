# 关税从「渠道开关」升级成「HS × 目的国」的规则表。
#
# 起因：同一个 SKU 发往不同国家，进口关税完全不同（美国有 301 附加税、欧盟有反倾销税），
# 关税既不能挂在 SKU 上，也不该每单体填。所以独立成 SkuDutyRate：
#   base_rate（基础税率）+ extra_rate（附加税）→ 匹配时取和。
# hs_prefix 支持前缀匹配，录一次 5806 就能覆盖 5806.32 / 5806.32.10。
#
# SkuSetting.market 让口径从「结算币种」变成「目的国市场」，币种由市场决定；
# 本迁移按现有 currency 反推 market，不改变用户当前看到的数字。
import workbench.models
from django.db import migrations, models

CURRENCY_TO_MARKET = {
    "USD": "US",
    "EUR": "EU",
    "GBP": "GB",
    "JPY": "JP",
    "AUD": "AU",
    "HKD": "HK",
    "CNY": "CN",
}


def backfill_market(apps, schema_editor):
    """旧版本只存了币种。按币种推回市场：EUR → EU、USD → US，其余类推。

    这个映射是唯一的：一个市场只有一个报价币种（见 sku/market.py）。
    """
    SkuSetting = apps.get_model("workbench", "SkuSetting")
    for row in SkuSetting.objects.all():
        market = CURRENCY_TO_MARKET.get(str(row.currency or "").upper(), "US")
        if row.market != market:
            row.market = market
            row.save(update_fields=["market"])


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("workbench", "0023_sku_drop_dimensions"),
    ]

    operations = [
        migrations.AddField(
            model_name="skusetting",
            name="market",
            field=models.CharField(default="US", max_length=8),
        ),
        migrations.CreateModel(
            name="SkuDutyRate",
            fields=[
                ("id", models.CharField(default=workbench.models.hex_uuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("market", models.CharField(max_length=8)),
                ("hs_prefix", models.CharField(max_length=20)),
                ("base_rate", models.DecimalField(decimal_places=6, default=0, max_digits=9)),
                ("extra_rate", models.DecimalField(decimal_places=6, default=0, max_digits=9)),
                ("note", models.CharField(blank=True, default="", max_length=200)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["market", "hs_prefix"],
                "constraints": [
                    models.UniqueConstraint(fields=("market", "hs_prefix"), name="sku_duty_market_hs_unique")
                ],
            },
        ),
        migrations.RunPython(backfill_market, noop),
    ]
