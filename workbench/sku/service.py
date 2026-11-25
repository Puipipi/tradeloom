"""成本核算：渠道口径、单 SKU 计算、汇总与展示格式化。

纯函数，不碰数据库也不碰 HTTP——输入是 dict，输出是 dict。
这样计算规则可以脱离 Django 单独验证（历史上两份台账都栽在单位与缺字段上）。

沿用两条硬规矩：
  1. 0 与空白含义不同。0 是"真的是 0"，None 是"还没填"。
  2. 缺必要字段不出利润率，标「待补」并列出缺哪几项——宁可不给数，也不给假数。
"""
from __future__ import annotations

import csv
import io
from decimal import Decimal

from .fx import DEFAULT_CURRENCY, as_float, normalize_currency
from .market import (
    DEFAULT_MARKET,
    default_duty as market_default_duty,
    market_name,
    normalize_market,
)

VAT_RATE = 0.13

# 期间费用：按月实际发生、逐单都不同，**不进 SKU 单件成本**。
# 广告花费、退货损失、店铺月费如果是估出来的均值再乘进售价，得到的是一个假设模型，
# 既解释不了、也校准不了。它们单独登记，和商品毛利在汇总层相加，才算经营净利。
PERIOD_FIELDS = ("ad_spend_cny", "returns_cny", "shop_fee_cny", "other_cny")
# 「其他费用」是可选的口子：不填就是没有，不算缺项，也不该因此把净利标成上限。
PERIOD_REQUIRED = ("ad_spend_cny", "returns_cny", "shop_fee_cny")
PERIOD_LABELS = {
    "ad_spend_cny": "广告花费",
    "returns_cny": "退货损失",
    "shop_fee_cny": "店铺月费",
    "other_cny": "其他费用",
}

# 渠道只提供「可确定的」口径：佣金比例是平台合同定的，店铺月费是固定月租。
# 关税不在这里——它由 SkuDutyRate 按「HS × 目的国」查表，逐 SKU 逐市场都不同。
CHANNELS = {
    "domestic_wholesale": {"name": "国内线下批发", "commission": 0.0, "shop_fee_cny": 0.0},
    "amazon_us": {"name": "亚马逊美国", "commission": 0.15, "shop_fee_usd": 39.99},
    "b2b_export": {"name": "B2B 出口 FOB", "commission": 0.0, "shop_fee_cny": 0.0},
}
DEFAULT_CHANNEL = "domestic_wholesale"

# 人工可填字段。售价字段名是 price，币种记在 price_currency。
# 不含关税：它按「HS 编码 × 目的市场」查表，不逐 SKU 填。
# 不含广告/退货：它们是期间费用，逐单不同，填在「期间费用」里，不摊进单件成本。
# 包装长宽高与重量也不在这里：没有数据源、不参与任何计算，留着只会让人误以为要填。
FILLABLE = (
    "hs_code", "price", "cost_cny", "freight_cny",
    "units", "commission",
)
TEXT_FILLABLE = ("hs_code",)

LABELS = {
    "sku": "SKU", "name": "商品名称", "category": "系列", "hs_code": "HS编码",
    "price": "售价{cur}", "cost_cny": "采购价CNY",
    "freight_cny": "头程CNY", "units": "预估月销",
    "commission": "佣金%", "duty": "关税",
    "landed": "到岸成本", "profit": "商品毛利",
}

# 导出只放人工填的原始字段，不放算出来的到岸成本/毛利：
# 毛利依赖当前市场的税率与汇率，文件里没记这两个前提，导出去容易被当成事实。
CSV_COLS = [
    ("sku", "sku"), ("name", "商品名称"), ("category", "系列"),
    ("hs_code", "HS编码"), ("price", "售价{cur}"),
    ("cost_cny", "采购价CNY"), ("freight_cny", "头程CNY"),
    ("units", "预估月销"),
    ("commission", "佣金%"),
]

HS_SUGGEST = {
    "Velvet Ribbon": ("5806.32", "机织狭幅织物，人造纤维制（丝带）"),
    "Knitting Ribbon": ("5806.32", "机织狭幅织物，人造纤维制（针织丝带）"),
    "Bling-Bling Ribbon": ("5806.32", "机织狭幅织物，人造纤维制（亮片丝带）"),
}
HS_FALLBACK = ("5806.32", "机织狭幅织物，人造纤维制（待核实）")


def num(value) -> float | None:
    return as_float(value)


def percent(value) -> float | None:
    """支持 15 / 0.15 / '15%'，统一成小数。"""
    if isinstance(value, str):
        text = value.strip()
        if text.endswith("%"):
            parsed = num(text[:-1])
            return None if parsed is None else parsed / 100
    parsed = num(value)
    if parsed is None:
        return None
    return parsed / 100 if parsed > 1 else parsed


def rnd(value, digits: int = 4):
    return None if value is None else round(float(value), digits)


def price_label(currency: str | None = None) -> str:
    return LABELS["price"].replace("{cur}", normalize_currency(currency or DEFAULT_CURRENCY))


def col_label(label: str, currency: str | None = None) -> str:
    return label.replace("{cur}", normalize_currency(currency or DEFAULT_CURRENCY))


def csv_label_map(currency: str | None = None) -> dict[str, str]:
    """`售价{cur}` 这类占位标签同时认所有币种和裸「售价」，
    这样切到欧元后拿旧的美元模板导入也不会整列丢字段。"""
    from .fx import CURRENCY_ORDER

    out: dict[str, str] = {}
    for key, label in CSV_COLS:
        out[key] = key
        if "{cur}" in label:
            for code in CURRENCY_ORDER:
                out[label.replace("{cur}", code)] = key
            out[label.replace("{cur}", "")] = key
        else:
            out[label] = key
    return out


def compute(row: dict, settings: dict, fx_rate: float,
            duty_rate: float | None = None, duty_source: str = "") -> dict:
    """单 SKU 核算——**只算商品成本**。返回的 dict 会直接 merge 进行数据。

    商品成本 = 采购价（可扣退税）+ 头程 + 关税，也就是「到岸成本」。
    佣金是平台按合同比例抽的，可确定，单独一列并从毛利里扣：得到「商品毛利」。
    广告、退货、店铺月费逐单逐月都不同，属于期间费用，**不在这里猜**——
    它们由 store 按月登记，和这里的商品毛利在汇总层相加，才是经营净利。

    ``duty_rate`` 由 store 按「HS 编码 × 当前市场」从税率表取出来传进来：
    None 表示该市场还没配税率——这时宁可不给利润率，也不按 0 蒙一个。
    """
    channel = CHANNELS.get(settings.get("channel")) or CHANNELS[DEFAULT_CHANNEL]
    currency = normalize_currency(settings.get("currency"))
    market = normalize_market(settings.get("market"))
    duty = duty_rate
    commission = percent(row.get("commission"))
    commission = channel["commission"] if commission is None else commission

    price = num(row.get("price"))
    cost_cny = num(row.get("cost_cny"))
    freight_cny = num(row.get("freight_cny"))
    units = num(row.get("units"))

    missing: list[str] = []
    if price is None:
        missing.append(price_label(currency))
    if cost_cny is None:
        missing.append(LABELS["cost_cny"])
    if freight_cny is None:
        missing.append(LABELS["freight_cny"])
    if duty is None:
        missing.append(f"{LABELS['duty']}（{market_name(market)}未设税率）")
    if commission is None:
        missing.append(LABELS["commission"])
    # 月销只用于「月商品毛利」汇总，不影响单件成本，缺了不算待补。

    out = {
        "sku": row.get("sku", ""),
        "units": units,
        "missing": missing,
        "status": "待补" if missing else "可算",
        "channel": channel["name"],
        "currency": currency,
        "market": market,
        "market_name": market_name(market),
        "price_label": price_label(currency),
        "fx": fx_rate,
        "duty_rate": None if duty is None else rnd(duty),
        "duty_source": duty_source,
        "duty_base": None,
    }
    if missing:
        return out

    price_cny = price * fx_rate
    # 退税率与佣金一样允许 13 / 0.13 / "13%" 三种写法：口径设置只有接口能改，
    # 让人去记「这里填小数、那里填百分数」迟早会写出 13 当 13% 用的负数成本。
    rebate = percent(settings.get("rebate")) or 0.0
    unit_cost = cost_cny * (1 - rebate / (1 + VAT_RATE)) if rebate else cost_cny
    # 关税按到岸价（CIF）计征，不是按采购价：采购价 + 头程运费才是报关基数，
    # 只用采购价会系统性低估关税，把毛利算得偏高。
    duty_base = unit_cost + freight_cny
    duty_cny = duty_base * duty
    landed = unit_cost + freight_cny + duty_cny
    commission_cny = price_cny * (commission or 0)
    profit = price_cny - landed - commission_cny
    # 保本售价：卖到这个价，扣掉到岸成本与佣金刚好不亏（不含广告退货）
    bep = (landed / (1 - commission) / fx_rate) if (commission or 0) < 1 else None

    out.update({
        "price_cny": rnd(price_cny),
        "unit_cost": rnd(unit_cost),
        "duty_base": rnd(duty_base),
        "duty_cny": rnd(duty_cny),
        "landed_cost": rnd(landed),
        "commission_cny": rnd(commission_cny),
        "profit": rnd(profit),
        "margin": rnd(profit / price_cny) if price_cny else None,
        "roi": rnd(profit / landed) if landed else None,
        "bep_price": rnd(bep) if bep is not None else None,
        "commission_rate": rnd(commission),
    })
    return out


def period_summary(rows: list[dict], period: dict) -> dict:
    """商品毛利与期间费用在**汇总层**相加，算经营净利。

    为什么在这里相加而不是在 SKU 行里：商品毛利是「每卖一件剩多少」，可以乘月销放大；
    广告、退货、店铺月费是「这个月花了多少」，逐单不同、只有实际发生额。
    两者口径不同，只有在月度汇总这一层相加才成立。

    没填的项不当 0：缺项会让净利偏高，所以标注 ``missing``，页面显示成「≤」。
    """
    computed = [row for row in rows if row.get("status") == "可算"]
    revenue = sum((row.get("price_cny") or 0) * (row.get("units") or 0) for row in computed)
    gross = sum((row.get("profit") or 0) * (row.get("units") or 0) for row in computed)

    parts = {field: num(period.get(field)) for field in PERIOD_FIELDS}
    filled = {key: value for key, value in parts.items() if value is not None}
    total = sum(filled.values()) if filled else None
    net = (gross - total) if total is not None else None

    def pct(value, base):
        return None if (value is None or not base) else rnd(value / base, 4)

    def money(value, with_sign=False):
        """金额文案带 ¥。负数把符号提到前面（−¥433），不写成 ¥-433。"""
        if value is None:
            return ""
        sign = "−" if (with_sign and value < 0) else ""
        return f"{sign}¥{abs(value) if with_sign else value:,.0f}"

    def as_percent(value):
        return "" if value is None else f"{value * 100:.1f}%"

    return {
        "revenue": rnd(revenue, 2),
        "gross_profit": rnd(gross, 2),
        "expense": {key: (None if value is None else rnd(value, 2)) for key, value in parts.items()},
        "expense_total": None if total is None else rnd(total, 2),
        "net_profit": None if net is None else rnd(net, 2),
        "net_margin": pct(net, revenue),
        "gross_margin": pct(gross, revenue),
        # 实际广告费率 = 实际广告花费 ÷ 本月销售额。这才是真 ACOS，
        # 不是「填一个 25% 当假设」——分母是推算销售额，所以标注为「按预估月销」。
        "ad_ratio": pct(parts.get("ad_spend_cny"), revenue),
        "returns_ratio": pct(parts.get("returns_cny"), revenue),
        "units": rnd(sum((row.get("units") or 0) for row in computed), 0),
        "missing": [PERIOD_LABELS[field] for field in PERIOD_REQUIRED if parts.get(field) is None],
        "has_expense": bool(filled),
        "revenue_text": money(revenue),
        "gross_profit_text": money(gross, with_sign=True),
        "expense_total_text": money(total),
        "net_profit_text": money(net, with_sign=True),
        "net_margin_text": as_percent(pct(net, revenue)),
        "gross_margin_text": as_percent(pct(gross, revenue)),
        "ad_ratio_text": as_percent(pct(parts.get("ad_spend_cny"), revenue)),
        "returns_ratio_text": as_percent(pct(parts.get("returns_cny"), revenue)),
    }


def display(row: dict) -> dict:
    """模板用的格式化字段，避免在模板里做算术。"""
    def money(value):
        return "" if value is None else f"{value:,.2f}"

    def as_percent(value):
        return "" if value is None else f"{value * 100:.1f}%"

    margin = row.get("margin")
    previous = row.get("price_prev")
    previous_currency = row.get("price_prev_currency") or ""
    duty_rate = row.get("duty_rate")
    # 商品毛利率的分档按「选品」尺度定：扣完到岸成本与佣金还剩不到 15%，
    # 基本经不起广告和退货，属于该重新定价的品；不能用净利率的 10% 当线。
    margin_class = (
        "" if margin is None else ("sku-neg" if margin < 0 else ("sku-low" if margin < 0.15 else "sku-good"))
    )
    return {
        "price_cny_text": money(row.get("price_cny")),
        "landed_text": money(row.get("landed_cost")),
        "profit_text": money(row.get("profit")),
        "bep_text": money(row.get("bep_price")),
        "duty_cny_text": money(row.get("duty_cny")),
        "duty_rate_text": "" if duty_rate is None else f"{duty_rate * 100:.2f}%",
        "commission_cny_text": money(row.get("commission_cny")),
        "margin_text": as_percent(margin),
        "roi_text": as_percent(row.get("roi")),
        "price_prev_text": "" if previous is None else f"原 {previous:g} {previous_currency}".strip(),
        "margin_class": margin_class,
        "is_loss": bool(row.get("profit") is not None and row["profit"] < 0),
    }


def match_duty(hs_key: str, duty_map: dict | None, market: str) -> tuple[float | None, str]:
    """按 HS 前缀最长匹配，返回 (税率, 来源说明)。

    前缀匹配是为了让人只录一次「5806」就能覆盖 5806.32 / 5806.32.10 这些细分码。
    表里没有就退回市场默认值；市场默认值为 None 时返回 (None, 原因)，由 compute
    把「关税」记进缺项——不编数字。
    """
    key = str(hs_key or "").strip()
    if key and duty_map:
        best_prefix = None
        best_rate = None
        for prefix, rate in duty_map.items():
            prefix = str(prefix or "").strip()
            if prefix and key.startswith(prefix):
                if best_prefix is None or len(prefix) > len(best_prefix):
                    best_prefix, best_rate = prefix, rate
        if best_prefix is not None and best_rate is not None:
            return float(best_rate), f"税率表 {best_prefix}"

    fallback = market_default_duty(market)
    if fallback is None:
        return None, f"{market_name(market)}未设税率"
    return float(fallback), f"{market_name(market)}默认 0"


def build_rows(catalog: list[dict], costs: dict[str, dict], settings: dict,
               fx_rate: float, duty_map: dict | None = None) -> list[dict]:
    """清单 + 人工成本 + 计算结果合成整表。

    duty_map: ``{hs前缀: 有效税率}``，由 store 按当前市场查表给出。
    HS 键优先用人工填的 hs_code；没填就用按子系列给的**建议值**去匹配，
    并在行上标明「建议」——建议值只是拿去查税率，不会被写进数据库。
    """
    currency = normalize_currency(settings.get("currency"))
    market = normalize_market(settings.get("market"))
    rows: list[dict] = []
    for base in catalog:
        sku = base["sku"]
        saved = costs.get(sku) or {}
        row = {
            "sku": sku,
            "name": base.get("name", ""),
            "series": base.get("series", ""),
            "sub": base.get("sub_category", ""),
            "category": " > ".join(x for x in (base.get("series"), base.get("sub_category")) if x),
            "material": base.get("material", ""),
            "size": base.get("size", ""),
            "url": base.get("url", ""),
            "active": base.get("active", True),
        }
        hs_suggest, hs_note = HS_SUGGEST.get(base.get("sub_category"), HS_FALLBACK)
        row["hs_suggest"] = hs_suggest
        row["hs_note"] = hs_note
        for field in FILLABLE:
            row[field] = None
        row.update({key: value for key, value in saved.items() if key in FILLABLE})

        # 售价属于某个币种。切了币种却沿用旧数字 = 静默算错，宁可退回「待补」。
        previous_currency = saved.get("price_currency") or ""
        if row.get("price") is not None and previous_currency and previous_currency != currency:
            row["price_prev"] = num(row["price"])
            row["price_prev_currency"] = previous_currency
            row["price"] = None
        else:
            row["price_prev"] = None
            row["price_prev_currency"] = ""

        own_hs = str(row.get("hs_code") or "").strip()
        duty_key = own_hs or hs_suggest
        rate, source = match_duty(duty_key, duty_map, market)
        row["duty_hs"] = duty_key
        row["duty_hs_from_suggest"] = not own_hs
        row.update(compute(row, settings, fx_rate, duty_rate=rate, duty_source=source))
        if row.get("price_prev") is not None:
            row["missing"].append(f"原售价 {row['price_prev']:g} {row['price_prev_currency']} 需按 {currency} 重填")
            row["status"] = "待补"
        row["missing_text"] = "、".join(row.get("missing") or [])
        row.update(display(row))
        rows.append(row)
    return rows


def _prefix_rate(hs_key: str, mapping: dict | None) -> float | None:
    """最长前缀匹配，只返回值本身（不掺市场默认值）。优惠税率专用。"""
    key = str(hs_key or "").strip()
    if not key or not mapping:
        return None
    best = None
    for prefix, value in mapping.items():
        prefix = str(prefix or "").strip()
        if prefix and key.startswith(prefix):
            if best is None or len(prefix) > len(best[0]):
                best = (prefix, value)
    return None if best is None else float(best[1])


def duty_groups(catalog: list[dict], costs: dict[str, dict],
                duty_map: dict | None, market: str,
                preferred_map: dict | None = None) -> list[dict]:
    """按「实际拿去查税的 HS 编码」给 SKU 分组，给关税弹窗与缺项提示用。

    为什么要这层分组：税率表挂在「HS × 目的国」上，SKU 只负责回答「我是哪个 HS」。
    但没有这个视图时，用户看到的是一个空白表格，得自己回忆本公司有哪几个编码、
    每个编码管多少 SKU——这正是「不同商品不同关税」配不起来的原因。

    三个字段要分清：
      * ``own_count``：行里真填了 hs_code 的 SKU 数；
      * ``suggest_count``：没填、按子系列推出来的（``HS_SUGGEST``），只是拿去查税，
        不写库，所以要标出来——编码是猜的，税率再准也没意义；
      * ``configured``：这个编码在本市场命中税率没有（含市场默认 0 的情况）。
    """
    buckets: dict[str, dict] = {}
    for base in catalog:
        saved = costs.get(base["sku"]) or {}
        own_hs = str(saved.get("hs_code") or "").strip()
        suggest, _note = HS_SUGGEST.get(base.get("sub_category"), HS_FALLBACK)
        hs = own_hs or suggest
        bucket = buckets.get(hs)
        if bucket is None:
            bucket = buckets[hs] = {
                "hs": hs, "sku_count": 0, "series": [], "sample": [],
                "own_count": 0, "suggest_count": 0,
            }
        bucket["sku_count"] += 1
        bucket["own_count" if own_hs else "suggest_count"] += 1
        label = base.get("sub_category") or base.get("series") or ""
        if label and label not in bucket["series"]:
            bucket["series"].append(label)
        if len(bucket["sample"]) < 3:
            bucket["sample"].append(base["sku"])

    groups: list[dict] = []
    for bucket in buckets.values():
        rate, source = match_duty(bucket["hs"], duty_map, market)
        preferred = _prefix_rate(bucket["hs"], preferred_map)
        series = bucket["series"]
        groups.append({
            "hs": bucket["hs"],
            "hs_text": bucket["hs"] or "未填编码",
            "sku_count": bucket["sku_count"],
            "own_count": bucket["own_count"],
            "suggest_count": bucket["suggest_count"],
            "series": series[:3],
            "series_text": "、".join(series[:3]) + ("等" if len(series) > 3 else ""),
            "sample": bucket["sample"],
            "configured": rate is not None,
            "rate": rate,
            "rate_text": "" if rate is None else f"{rate * 100:.2f}%",
            "source": source,
            # 优惠税率只展示、不进成本：没办原产地证就用不上它
            "preferred": preferred,
            "preferred_text": "" if preferred is None else f"{preferred * 100:.2f}%",
        })
    # 未配的排前面：弹窗打开第一眼该看到的是要处理的东西，不是已完成的
    groups.sort(key=lambda g: (g["configured"], -g["sku_count"], g["hs"]))
    return groups


def summary(items: list[dict]) -> dict:
    """SKU 层的汇总——只汇总商品口径，不含广告/退货/店铺月费。

    那些是期间费用，混进来会让「平均毛利率」变成一个既不是商品毛利、
    也不是净利的中间数。经营层面的数看 ``period_summary``。
    """
    computed = [row for row in items if row["status"] == "可算"]
    margins = sorted(row["margin"] for row in computed if row.get("margin") is not None)
    average = round(sum(margins) / len(margins), 4) if margins else None
    units = sum((row.get("units") or 0) for row in computed)
    revenue = sum((row.get("price_cny") or 0) * (row.get("units") or 0) for row in computed)
    gross = sum((row.get("profit") or 0) * (row.get("units") or 0) for row in computed)
    return {
        "total": len(items),
        "active": sum(1 for row in items if row.get("active", True)),
        "archived": sum(1 for row in items if not row.get("active", True)),
        "ok": len(computed),
        "pending": len(items) - len(computed),
        "units_month": round(units, 0),
        "avg_margin": average,
        "avg_margin_text": "—" if average is None else f"{average * 100:.1f}%",
        "min_margin": margins[0] if margins else None,
        "max_margin": margins[-1] if margins else None,
        "loss_count": sum(1 for row in computed if (row.get("profit") or 0) < 0),
        "revenue_month": round(revenue, 2),
        "revenue_month_text": f"{revenue:,.0f} 元",
        "gross_month": round(gross, 2),
        "gross_month_text": f"{gross:,.0f} 元",
    }


# ---------------------------------------------------------------- 选品建议

ADVICE_SWITCH_MIN = 30.0      # 月毛利差低于这个数不值得提：折腾物流的隐性成本比它高
ADVICE_THIN_MARGIN = 0.15     # 与页面上 sku-low 同一档：15% 以下经不起广告与退货
ADVICE_LIMIT = 8


def _money(value) -> str:
    return "—" if value is None else f"{value:,.0f}"


def _ratio(value) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def advice(inputs: dict) -> dict:
    """跨市场选品建议：只回答「同一批货放到哪个市场更划算」。

    三条自我约束：
      1. **只比能算的市场**。某市场没配该 HS 的税率就不参与比较——把「未配」
         当成 0 会得出一个漂亮但假的毛利，比不比更糟。
      2. **换市场看月毛利差，不看毛利率**。百分比高的市场可能没有量，
         只盯比例会把人引到卖不动的地方。
      3. **不下「该砍掉」的结论**。库存、账期、账号资质都不在这份数据里，
         台账只能提示「这个价卖了不赚」，砍品要人自己定。
    """
    month = inputs.get("month") or ""
    current = inputs.get("current_market") or ""
    markets = inputs.get("markets") or []
    skus = inputs.get("skus") or []

    stats: list[dict] = []
    by_market: dict[str, dict[str, dict]] = {}
    for entry in markets:
        code = entry["code"]
        rows = [row for row in entry.get("rows") or [] if row.get("status") == "可算"]
        by_market[code] = {row["sku"]: row for row in rows}
        margins = [row["margin"] for row in rows if row.get("margin") is not None]
        average = round(sum(margins) / len(margins), 4) if margins else None
        stats.append({
            "code": code,
            "name": entry.get("name") or code,
            "currency": entry.get("currency") or "",
            # 零关税是「市场默认值」而不是查过税则时，排名要往后放：那是假设不是事实
            "assumed_zero": bool(entry.get("assumed_zero")),
            "ready": len(rows),
            "total": len(entry.get("rows") or []),
            "loss": sum(1 for row in rows if (row.get("profit") or 0) < 0),
            "avg_margin": average,
            "avg_margin_text": _ratio(average),
        })

    name_of = {item["code"]: item["name"] for item in stats}
    # 默认零关税的市场不当「最佳去处」：那是没查过税则的假设值，照它建议换市场等于劝人踩坑
    zero_markets = {item["code"] for item in stats if item["assumed_zero"]}
    current_name = name_of.get(current, current)
    switches: list[dict] = []
    losses: list[dict] = []
    thins: list[dict] = []
    blocked = 0

    for meta in skus:
        sku = meta["sku"]
        if meta.get("active") is False:
            continue
        usable = {code: rows[sku] for code, rows in by_market.items() if sku in rows}
        if not usable:
            blocked += 1
            continue
        base = usable.get(current)
        pool = {code: row for code, row in usable.items() if code not in zero_markets} or usable
        best_code, best = max(pool.items(), key=lambda item: item[1].get("profit") or 0)
        best_name = name_of.get(best_code, best_code)
        units = best.get("units") or (base or {}).get("units") or 0

        if base is None:
            # 当前市场算不出（多半缺税率），别处能算：这是「欠配置」，不是建议
            if (best.get("profit") or 0) > 0:
                switches.append({
                    "kind": "fill",
                    "sku": sku, "name": meta.get("name", ""),
                    "market": best_code, "market_name": best_name,
                    "profit": best.get("profit"),
                    "delta_unit": None, "delta_month": 0.0,
                    "text": f"{current_name}还缺这个 HS 的税率，算不出；在{best_name}"
                            f"每件毛利 {best['profit']:.2f} 元。补齐税率才谈得上比较。",
                })
            continue

        base_profit = base.get("profit")
        if base_profit is None:
            continue
        if best_code != current and best.get("profit") is not None:
            delta_unit = (best.get("profit") or 0) - base_profit
            delta_month = delta_unit * units
            if delta_unit > 0 and (delta_month >= ADVICE_SWITCH_MIN or units <= 0):
                switches.append({
                    "kind": "switch",
                    "sku": sku, "name": meta.get("name", ""),
                    "market": best_code, "market_name": best_name,
                    "profit": best.get("profit"),
                    "delta_unit": round(delta_unit, 2),
                    "delta_month": round(delta_month, 2),
                    "text": f"同样的成本，在{best_name}每件毛利 {best['profit']:.2f} 元，"
                            f"比{current_name}多 {delta_unit:.2f} 元"
                            + (f"；按月销 {units:g} 件，每月多 {_money(delta_month)} 元。" if units else "。"),
                })
        if base_profit < 0:
            losses.append({
                "kind": "loss",
                "sku": sku, "name": meta.get("name", ""),
                "market": current, "market_name": current_name,
                "profit": base_profit,
                "delta_month": round(base_profit * units, 2),
                "text": f"{current_name}每件亏 {abs(base_profit):.2f} 元"
                        + (f"（月销 {units:g} 件，每月亏 {_money(abs(base_profit * units))} 元）" if units else "")
                        + (f"；保本价 {base['bep_price']:.2f}，现价 {base['price']:g}。"
                           if base.get("bep_price") and base.get("price") else "。"),
            })
        elif base.get("margin") is not None and base["margin"] < ADVICE_THIN_MARGIN:
            thins.append({
                "kind": "thin",
                "sku": sku, "name": meta.get("name", ""),
                "market": current, "market_name": current_name,
                "margin": base.get("margin"), "margin_text": _ratio(base.get("margin")),
                "delta_month": 0.0,
                "text": f"{current_name}毛利率 {_ratio(base['margin'])}，扣完广告与退货基本不剩"
                        + (f"（保本价 {base['bep_price']:.2f}，现价 {base['price']:g}）。"
                           if base.get("bep_price") and base.get("price") else "。"),
            })

    switches.sort(key=lambda item: -abs(item.get("delta_month") or 0))
    losses.sort(key=lambda item: item.get("delta_month") or 0)      # 亏得多的在前
    thins.sort(key=lambda item: item.get("margin") or 0)

    ranked = sorted(
        [item for item in stats if item["ready"]],
        # 先按「是否只是默认零关税」分档，再比毛利率：否则零关税市场永远霸榜，
        # 看着像「去香港卖最赚」，其实是没查过香港税则的假设值。
        key=lambda item: (not item["assumed_zero"],
                          item["avg_margin"] if item["avg_margin"] is not None else -9,
                          item["ready"]),
        reverse=True,
    )
    assumed = [item for item in ranked if item["assumed_zero"]]
    head = ""
    if ranked:
        top = ranked[0]
        head = (f"{top['name']}的平均商品毛利率最高（{top['avg_margin_text']}，"
                f"{top['ready']}/{top['total']} 个 SKU 可算）。")
    head += f"这轮比了 {len(ranked)} 个市场、{len(skus)} 个 SKU。"
    if assumed:
        head += "、".join(item["name"] for item in assumed) + "按默认零关税算，没有查过税则，只作参考。"
    if blocked:
        head += f"另有 {blocked} 个 SKU 在所有市场都算不出（缺税率或缺成本），没进比较。"

    hint = ""
    if len([item for item in ranked if not item["assumed_zero"]]) == 0:
        hint = ("各市场都还没有实测税率（现在按市场默认 0 算），跨市场比较只能看个方向。"
                "切到目标市场 → 「关税率…」把 HS 税率配一遍，这里才会给换市场建议。")
    elif blocked:
        hint = f"{blocked} 个 SKU 在各市场都缺税率，先把编码配齐，比较结果才有意义。"

    return {
        "month": month,
        "current_market": current,
        "current_name": current_name,
        "headline": head,
        "hint": hint,
        "markets": ranked + [item for item in stats if not item["ready"]],
        "suggestions": switches[:ADVICE_LIMIT] + losses[:ADVICE_LIMIT] + thins[:4],
    }


def export_csv_bytes(items: list[dict], currency: str) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([col_label(label, currency) for _key, label in CSV_COLS])
    for row in items:
        writer.writerow(["" if row.get(key) is None else row.get(key) for key, _label in CSV_COLS])
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


def parse_cost_csv(text: str, known_skus: set[str]) -> dict:
    """成本 CSV：按 SKU 匹配，只收非空格子。未知 SKU 单独报出来，不盲目建行。"""
    text = (text or "").lstrip("\ufeff")
    if not text.strip():
        raise ValueError("CSV 内容为空")
    mapping = csv_label_map()
    patch: dict[str, dict] = {}
    empty_rows = 0
    for record in csv.DictReader(io.StringIO(text)):
        sku = (record.get("sku") or record.get("SKU") or "").strip().lstrip("\ufeff")
        if not sku:
            continue
        fields = {}
        for column, value in record.items():
            if column is None:
                continue
            key = mapping.get(str(column).strip().lstrip("\ufeff"))
            if not key or key not in FILLABLE:
                continue
            if value is None or str(value).strip() == "":
                continue
            fields[key] = str(value).strip()
        if fields:
            patch[sku] = fields
        else:
            empty_rows += 1
    unknown = sorted(sku for sku in patch if sku not in known_skus)
    for sku in unknown:
        patch.pop(sku, None)
    return {"patch": patch, "empty_rows": empty_rows, "unknown": unknown}


def to_decimal(value) -> Decimal | None:
    parsed = num(value)
    return None if parsed is None else Decimal(str(parsed))
