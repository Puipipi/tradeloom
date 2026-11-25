# 关税率表加「优惠税率」一栏（自贸协定项下，凭原产地证才用得上）。
#
# 为什么单独一栏而不是并进 base_rate：
#   1. 优惠税率是**有条件的**税率——RCEP、中澳 ChAFTA 都要原产地证。把它当基础
#      税率算，会让毛利看起来比实际高一大截，而那个差额客户根本拿不到；
#   2. 「没有优惠」和「优惠 0%」是两件事：香港、内地那种本来就 0，和
#      「这条编码谈下来了 0%」在报表上不该长一样，所以字段允许为空。
#
# 这一版**不参与成本计算**，只登记与展示；要不要按它计征，等用户明确
# 「本批货有原产地证」再说。
import workbench.models
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workbench", "0025_sku_period_cost"),
    ]

    operations = [
        migrations.AddField(
            model_name="skudutyrate",
            name="preferred_rate",
            field=models.DecimalField(
                blank=True, decimal_places=6, default=None, max_digits=9, null=True,
            ),
        ),
    ]
