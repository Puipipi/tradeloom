"""需求量口径：把 Comtrade 的原始观测算成「这个市场能吃下多少」。

为什么单独一层：Comtrade 给的是「报告国 × 伙伴国 × 年份」的三维原始值，
而选品要回答的是「这个 HS6 在目标市场一年进口多少、在涨还是在跌、中国占多少、
单价带在哪」。同一批行换个算法（同比 vs CAGR、要不要剔掉转口）结论会变，
所以口径集中在这里，改的时候不用回写数据库。

**不做的事**：不拿它算毛利。进口额是需求侧事实，毛利是成本侧事实，
两者混在一个数里就没人说得清哪部分是假设。
"""
from __future__ import annotations

import re

from workbench.sku import market as market_module
from workbench.sku import store as sku_store

from . import client

# 需求量分档（美元/年）。丝带、工艺品这类品类的量级参考：
# 单国年进口 2000 万美元以下基本是「小池子」，3 亿美元以上算「大盘」。
DEMAND_SMALL_USD = 20_000_000
DEMAND_BIG_USD = 300_000_000
# 低于这个数就当「没有需求」：此时毛利再漂亮也不建议去，多半是算错了或被小单骗了
DEMAND_FLOOR_USD = 5_000_000
# 单价带对比容差：我方单价高出市场均价这么多，说明报价没空间
PRICE_GAP_TOLERANCE = 0.25


def money_text(value: float | None) -> str:
    """美元金额的中文量级。选品面板一行只放得下一个数，不能写 1234567890。"""
    if value is None:
        return "—"
    if value >= 100_000_000:
        return f"{value / 100_000_000:.2f} 亿美元"
    if value >= 10_000:
        return f"{value / 10_000:.0f} 万美元"
    return f"{value:.0f} 美元"


def ratio_text(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def demand_level(value: float | None) -> tuple[str, str]:
    """(档位码, 中文)。档位码给前端上色，中文给人和 Agent 看。"""
    if not value or value <= 0:
        return "none", "无数据"
    if value < DEMAND_SMALL_USD:
        return "small", "小"
    if value < DEMAND_BIG_USD:
        return "mid", "中"
    return "big", "大"


def ledger_hs6() -> tuple[list[dict], list[dict]]:
    """台账里该去查的 HS6，以及格式不合规的编码。

    两个来源合并，因为「台账有没有 HS」和「这批货实际用什么编码报关」是两件事：

    1. ``SkuCostEntry.hs_code``——逐 SKU 人工填的，最准，能算出覆盖几个 SKU；
    2. ``SkuDutyRate.hs_prefix``——关税表里配过的编码。台账里 HS 还没填、
       但关税表里有，说明这批货确实按这个编码出口，**不能因为前者空着就判定
       「没有商品」**。这类编码的 ``sku_count`` 是 0，页面要标出来源。

    只收 6 位及以上：4 位是章级别，查回来是整章的贸易额，和具体商品没关系。
    """
    catalog = {row["sku"]: row for row in sku_store.load_catalog()}
    costs = sku_store.load_costs()
    buckets: dict[str, dict] = {}
    invalid: list[dict] = []

    def bucket_of(hs6: str) -> dict:
        return buckets.setdefault(hs6, {
            "hs6": hs6, "skus": set(), "series": set(),
            "raw": set(), "duty_markets": set(),
        })

    for sku, entry in costs.items():
        raw = str(entry.get("hs_code") or "").strip()
        if not raw:
            continue
        hs6 = client.normalize_hs6(raw)
        meta = catalog.get(sku) or {}
        if hs6 is None:
            invalid.append({"sku": sku, "raw": raw, "name": meta.get("name", "")})
            continue
        bucket = bucket_of(hs6)
        bucket["skus"].add(sku)
        bucket["raw"].add(raw)
        series = str(meta.get("sub_category") or meta.get("series") or "").strip()
        if series:
            bucket["series"].add(series)

    for row in sku_store.all_duty_prefixes():
        hs6 = client.normalize_hs6(row["prefix"])
        if hs6 is None:
            # 4 位章级前缀：关税能按章配，Comtrade 查章级没有商品意义，跳过
            continue
        bucket = bucket_of(hs6)
        bucket["raw"].add(row["prefix"])
        bucket["duty_markets"].update(row["markets"])

    out = []
    for bucket in buckets.values():
        sku_count = len(bucket["skus"])
        duty_markets = sorted(bucket["duty_markets"])
        out.append({
            "hs6": bucket["hs6"],
            "sku_count": sku_count,
            "skus": sorted(bucket["skus"]),
            "series": sorted(bucket["series"]),
            "raw": sorted(bucket["raw"]),
            "duty_markets": duty_markets,
            "source": "ledger" if sku_count else "duty",
            # 台账写法五花八门（5806.32 / 5806321010），看得出来源才知道取前 6 位对不对
            "normalized": any(value != bucket["hs6"] for value in bucket["raw"]),
        })
    out.sort(key=lambda item: (-item["sku_count"], not item["duty_markets"], item["hs6"]))
    return out, invalid


def _year_values(records: list[dict], reporters: set[int], partner: int) -> dict[int, dict]:
    """按年份汇总某个伙伴口径的值与净重。"""
    buckets: dict[int, dict] = {}
    for record in records:
        if record["reporter_code"] not in reporters:
            continue
        if record["partner_code"] != partner:
            continue
        period = int(record["period"])
        bucket = buckets.setdefault(period, {"value": 0.0, "weight": 0.0, "has_weight": False})
        bucket["value"] += float(record["primary_value"] or 0)
        weight = record.get("net_wgt")
        if weight is not None:
            bucket["weight"] += float(weight)
            bucket["has_weight"] = True
    return buckets


def market_metrics(records: list[dict], market: str) -> dict | None:
    """一个 HS6 在一个市场（可能由多个报告国组成）的需求指标。

    ``records`` 只含同一个 HS6 的行。返回 ``None`` 表示这一格完全没有数据——
    和「有数据但为 0」要分开：前者是还没同步，后者是查过了真没进口。
    """
    reporters = set(client.market_reporters(market))
    if not reporters:
        return None
    world = _year_values(records, reporters, client.PARTNER_WORLD)
    china = _year_values(records, reporters, client.PARTNER_CHINA)
    if not world:
        return None
    # 只看有值的年份：某年上报但值为 0 的，不能当「最近一年」
    years = sorted((year for year, data in world.items() if data["value"] > 0))
    if not years:
        return {
            "market": market,
            "market_name": client.market_label(market),
            "import_value": 0.0,
            "import_value_text": money_text(0),
            "growth": None,
            "growth_text": "—",
            "cn_share": None,
            "cn_share_text": "—",
            "unit_price": None,
            "unit_price_text": "—",
            "level": "none",
            "level_text": "无进口",
            "source_year": max(world),
            "years": [],
            "observations": len(world),
        }
    latest = years[-1]
    value = world[latest]["value"]
    previous = years[-2] if len(years) >= 2 else None
    growth = None
    if previous is not None and world[previous]["value"] > 0:
        growth = round((value - world[previous]["value"]) / world[previous]["value"], 4)
    cn_value = (china.get(latest) or {}).get("value") or 0.0
    cn_share = round(cn_value / value, 4) if value > 0 else None
    weight = world[latest]["weight"]
    unit_price = round(value / weight, 4) if weight > 0 else None
    level, level_text = demand_level(value)
    return {
        "market": market,
        "market_name": client.market_label(market),
        "reporter_count": len([code for code in reporters]),
        "import_value": round(value, 2),
        "import_value_text": money_text(value),
        "growth": growth,
        "growth_text": "—" if growth is None else f"{growth * 100:+.1f}%",
        "cn_value": round(cn_value, 2),
        "cn_share": cn_share,
        "cn_share_text": ratio_text(cn_share),
        "unit_price": unit_price,
        "unit_price_text": "—" if unit_price is None else f"{unit_price:.2f} USD/kg",
        "level": level,
        "level_text": level_text,
        "source_year": latest,
        "years": years,
        "observations": len(world),
    }


def matrix(records: list[dict], hs6_list: list[str], markets: list[str] | None = None) -> list[dict]:
    """HS6 × 市场 的矩阵，供 Comtrade 面板展示。

    排序按「覆盖 SKU 数」而不是编码字典序：台账里 3 个 SKU 共用一个编码的，
    比只有一个 SKU 的更值得先看。
    """
    order = markets or [code for code in market_module.MARKET_ORDER if code != "CN"]
    grouped: dict[str, list[dict]] = {}
    for record in records:
        grouped.setdefault(record["hs6"], []).append(record)
    rows = []
    for hs6 in hs6_list:
        bucket = grouped.get(hs6) or []
        cells = {}
        for market in order:
            metric = market_metrics(bucket, market)
            if metric is not None:
                cells[market] = metric
        years = sorted({int(record["period"]) for record in bucket}, reverse=True)
        rows.append({
            "hs6": hs6,
            "markets": cells,
            "years": years,
            "has_data": bool(cells),
        })
    return rows


def coverage(hs6_list: list[dict], matrix_rows: list[dict]) -> dict:
    """覆盖率：有多少个编码真的拉到了数据。页面顶部的「数据到哪一年」靠它。"""
    total = len(hs6_list)
    filled = sum(1 for row in matrix_rows if row["has_data"])
    years = [year for row in matrix_rows for year in row["years"]]
    return {
        "hs6_total": total,
        "hs6_with_data": filled,
        "hs6_missing": sorted(
            row["hs6"] for row in matrix_rows if not row["has_data"]
        ),
        "latest_year": max(years) if years else None,
        "earliest_year": min(years) if years else None,
    }


def demand_for(hs6: str | None, market: str, matrix_rows: list[dict]) -> dict | None:
    """选品建议用的单格需求。已经算好的矩阵里捞，不重复查库。"""
    if not hs6:
        return None
    for row in matrix_rows:
        if row["hs6"] == hs6:
            return row["markets"].get(market)
    return None


__all__ = [
    "DEMAND_SMALL_USD",
    "DEMAND_BIG_USD",
    "DEMAND_FLOOR_USD",
    "PRICE_GAP_TOLERANCE",
    "demand_level",
    "ledger_hs6",
    "market_metrics",
    "matrix",
    "coverage",
    "demand_for",
]
