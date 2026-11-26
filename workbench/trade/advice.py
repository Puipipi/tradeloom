"""选品建议：成本侧 × 需求侧。

从 ``sku/service.py`` 迁出来独立成模块——建议的输入已经不只是「七个市场各算一遍
毛利」，还多了「每个 HS6 在各国的进口额」。它不再属于 SKU 台账，而是一块独立的
判断，所以口径、阈值、文案都放这里。

三条自我约束（沿用原来的，加上第四条）：

1. **只比能算的市场**。没配该 HS 税率就不参与比较——把「未配」当 0 会得出漂亮
   但假的毛利，比不比更糟。
2. **换市场看月毛利差，不看毛利率**。百分比高的市场可能没有量。
3. **不下「该砍掉」的结论**。库存、账期、账号资质都不在数据里。
4. **没有需求数据时不装作有**。某个市场没同步过贸易数据，就标「需求未知」，
   排序上夹在「有量」和「没量」之间，不因为缺数据把它压到最后——
   那是拿没有的信息当坏消息。
"""
from __future__ import annotations

from . import service

ADVICE_SWITCH_MIN = 30.0      # 月毛利差低于这个数不值得提：折腾物流的隐性成本比它高
ADVICE_THIN_MARGIN = 0.15     # 与页面上 sku-low 同一档：15% 以下经不起广告与退货
ADVICE_LIMIT = 8

# 排序档位：有量(3) > 需求未知(2) > 量很小(1) > 查过但没进口(0)。
# 「未知」夹在小量之上是刻意的：没查过不等于坏消息，拿它当负面证据会误导人。
DEMAND_RANK = {"big": 3, "mid": 3, "small": 1, "none": 0}
DEMAND_UNKNOWN = 2


def _money(value) -> str:
    return "—" if value is None else f"{value:,.0f}"


def _ratio(value) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def _aggregate(market: str, hs6s: set[str], demand: dict, scope: str = "per_sku") -> dict | None:
    """一个市场里，本批货对应的 HS6 一共进口多少。

    按 HS6 去重求和：三个 SKU 共用一个编码时，把它们的进口额乘三倍没有意义。
    ``None`` 表示这些编码一个都没同步过——和「同步过但没进口」不是一回事。

    ``scope`` 记录口径：``per_sku`` 是「这些 SKU 各自的编码」，
    ``ledger`` 是「台账里全部编码」——逐 SKU 的 HS 还没填时只能按后者算，
    页面要标明，否则看起来像「这些 SKU 的需求」，其实是整批货的。
    """
    if not hs6s:
        return None
    total = 0.0
    with_data = 0
    years: list[int] = []
    for hs6 in hs6s:
        cell = (demand.get(hs6) or {}).get(market)
        if not cell:
            continue
        with_data += 1
        total += float(cell.get("import_value") or 0)
        if cell.get("source_year"):
            years.append(int(cell["source_year"]))
    if not with_data:
        return None
    level, level_text = service.demand_level(total)
    return {
        "import_value": round(total, 2),
        "import_value_text": service.money_text(total),
        "level": level,
        "level_text": level_text,
        "source_year": max(years) if years else None,
        "hs6_count": len(hs6s),
        "hs6_with_data": with_data,
        "has_demand": total >= service.DEMAND_FLOOR_USD,
        "scope": scope,
    }


def _trade_note(cell: dict | None) -> str:
    """需求侧事实，**不带前后缀**——调用处自己拼「该市场…」。

    只写事实（哪年、多少、涨跌、中国占多少），不下结论。返回空串表示没有数据，
    由调用方决定要不要提「查不到」。
    """
    if not cell:
        return ""
    if cell.get("level") == "none":
        return "该编码查不到进口记录"
    parts = []
    if cell.get("source_year"):
        parts.append(f"{cell['source_year']} 年进口 {cell.get('import_value_text', '—')}")
    if cell.get("growth") is not None:
        parts.append(f"同比 {cell['growth_text']}")
    if cell.get("cn_share") is not None:
        parts.append(f"中国占 {cell['cn_share_text']}")
    return "、".join(parts)


def _sku_trade(hs6: str | None, market: str, demand: dict) -> dict | None:
    if not hs6:
        return None
    return (demand.get(hs6) or {}).get(market)


def build_advice(
    inputs: dict,
    demand: dict | None = None,
    hs6_by_sku: dict | None = None,
    ledger_hs6: list[str] | None = None,
) -> dict:
    """``demand``: ``{hs6: {market: 指标}}``；``hs6_by_sku``: ``{sku: hs6}``。

    ``ledger_hs6`` 是兜底：逐 SKU 的 HS 还没填时，用「台账里全部编码」算市场容量，
    并在结果里标 ``scope=ledger``。三者都为空时行为与改造前完全一致——
    没有贸易数据不应该让建议消失或变差。
    """
    demand = demand or {}
    hs6_by_sku = hs6_by_sku or {}
    ledger_hs6 = ledger_hs6 or []
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
        hs6s = {
            hs6_by_sku.get(row["sku"])
            for row in entry.get("rows") or []
        }
        hs6s.discard(None)
        scope = "per_sku"
        if not hs6s:
            hs6s = set(ledger_hs6)
            scope = "ledger"
        aggregate = _aggregate(code, hs6s, demand, scope)
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
            "trade": aggregate,
            "demand_flag": DEMAND_UNKNOWN if aggregate is None else DEMAND_RANK.get(aggregate["level"], DEMAND_UNKNOWN),
            "demand_text": aggregate["import_value_text"] if aggregate else "—",
            "demand_level": aggregate["level"] if aggregate else "unknown",
            "demand_level_text": aggregate["level_text"] if aggregate else "需求未知",
        })

    name_of = {item["code"]: item["name"] for item in stats}
    stat_of = {item["code"]: item for item in stats}
    # 默认零关税的市场不当「最佳去处」：那是没查过税则的假设值，照它建议换市场等于劝人踩坑
    zero_markets = {item["code"] for item in stats if item["assumed_zero"]}
    current_name = name_of.get(current, current)
    switches: list[dict] = []
    losses: list[dict] = []
    thins: list[dict] = []
    starved: list[dict] = []
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
        best_stat = stat_of.get(best_code) or {}
        units = best.get("units") or (base or {}).get("units") or 0
        hs6 = hs6_by_sku.get(sku)
        base_trade = _sku_trade(hs6, current, demand)

        if base is None:
            # 当前市场算不出（多半缺税率），别处能算：这是「欠配置」，不是建议
            if (best.get("profit") or 0) > 0:
                switches.append({
                    "kind": "fill",
                    "sku": sku, "name": meta.get("name", ""),
                    "market": best_code, "market_name": best_name,
                    "profit": best.get("profit"),
                    "delta_unit": None, "delta_month": 0.0,
                    "trade": _sku_trade(hs6, best_code, demand),
                    "text": f"{current_name}还缺这个 HS 的税率，算不出；在{best_name}"
                            f"每件毛利 {best['profit']:.2f} 元。补齐税率才谈得上比较。",
                })
            continue

        base_profit = base.get("profit")
        if base_profit is None:
            continue

        # 「毛利最高但没量」单独成一类：这是需求侧唯一能推翻成本结论的场景，
        # 不给它一个独立类型，用户只会照着毛利最高的那条去铺货。
        # 判断用 has_demand（低于需求下限）而不是档位：档位里的「小」仍然算有量，
        # 真正该劝阻的是连下限都够不着的那种。
        best_trade = best_stat.get("trade")
        if (best_trade and not best_trade.get("has_demand") and best_code != current
                and (best.get("profit") or 0) > 0):
            best_cell = _sku_trade(hs6, best_code, demand)
            starved.append({
                "kind": "no_demand",
                "sku": sku, "name": meta.get("name", ""),
                "market": best_code, "market_name": best_name,
                "profit": best.get("profit"),
                "delta_unit": None, "delta_month": 0.0,
                "trade": best_cell,
                "text": f"{best_name}每件毛利最高（{best['profit']:.2f} 元），但该市场"
                        f"{_trade_note(best_cell) or '查不到贸易数据'}，量太小——"
                        f"换过去可能只是把库存挪个地方。先在那边小批试单，别一次压货。",
            })
            continue

        if best_code != current and best.get("profit") is not None:
            delta_unit = (best.get("profit") or 0) - base_profit
            delta_month = delta_unit * units
            if delta_unit > 0 and (delta_month >= ADVICE_SWITCH_MIN or units <= 0):
                trade_cell = _sku_trade(hs6, best_code, demand)
                note = _trade_note(trade_cell)
                switches.append({
                    "kind": "switch",
                    "sku": sku, "name": meta.get("name", ""),
                    "market": best_code, "market_name": best_name,
                    "profit": best.get("profit"),
                    "delta_unit": round(delta_unit, 2),
                    "delta_month": round(delta_month, 2),
                    "trade": trade_cell,
                    "text": f"同样的成本，在{best_name}每件毛利 {best['profit']:.2f} 元，"
                            f"比{current_name}多 {delta_unit:.2f} 元"
                            + (f"；按月销 {units:g} 件，每月多 {_money(delta_month)} 元。" if units else "。")
                            + (f"该市场{note}。" if note else ""),
                })
        if base_profit < 0:
            base_note = _trade_note(base_trade)
            losses.append({
                "kind": "loss",
                "sku": sku, "name": meta.get("name", ""),
                "market": current, "market_name": current_name,
                "profit": base_profit,
                "delta_month": round(base_profit * units, 2),
                "trade": base_trade,
                "text": f"{current_name}每件亏 {abs(base_profit):.2f} 元"
                        + (f"（月销 {units:g} 件，每月亏 {_money(abs(base_profit * units))} 元）" if units else "")
                        + (f"；保本价 {base['bep_price']:.2f}，现价 {base['price']:g}。" if base.get("bep_price") and base.get("price") else "。")
                        + (f"该市场{base_note}。" if base_note else ""),
            })
        elif base.get("margin") is not None and base["margin"] < ADVICE_THIN_MARGIN:
            base_note = _trade_note(base_trade)
            thins.append({
                "kind": "thin",
                "sku": sku, "name": meta.get("name", ""),
                "market": current, "market_name": current_name,
                "margin": base.get("margin"), "margin_text": _ratio(base.get("margin")),
                "delta_month": 0.0,
                "trade": base_trade,
                "text": f"{current_name}毛利率 {_ratio(base['margin'])}，扣完广告与退货基本不剩"
                        + (f"（保本价 {base['bep_price']:.2f}，现价 {base['price']:g}）。" if base.get("bep_price") and base.get("price") else "。")
                        + (f"该市场{base_note}。" if base_note else ""),
            })

    switches.sort(key=lambda item: -abs(item.get("delta_month") or 0))
    losses.sort(key=lambda item: item.get("delta_month") or 0)      # 亏得多的在前
    thins.sort(key=lambda item: item.get("margin") or 0)
    starved.sort(key=lambda item: -(item.get("profit") or 0))

    ranked = sorted(
        [item for item in stats if item["ready"]],
        # 分档顺序：先看关税是不是真有数据，再看有没有量，最后比毛利率。
        # 为什么需求夹在中间——零关税是「假设 vs 事实」的问题，需求是「有没有量」，
        # 两者都不能被利润率盖过去；但没配税率的市场连毛利率都不可信，所以垫底。
        key=lambda item: (not item["assumed_zero"],
                          item["demand_flag"],
                          item["avg_margin"] if item["avg_margin"] is not None else -9,
                          item["ready"]),
        reverse=True,
    )
    assumed = [item for item in ranked if item["assumed_zero"]]

    head = ""
    if ranked:
        top = ranked[0]
        head = (f"{top['name']}的平均商品毛利率最高（{top['avg_margin_text']}，"
                f"{top['ready']}/{top['total']} 个 SKU 可算）")
        if top.get("trade"):
            head += f"，那批编码在该市场最近一年进口 {top['trade']['import_value_text']}"
        head += "。"
    head += f"这轮比了 {len(ranked)} 个市场、{len(skus)} 个 SKU。"
    if assumed:
        head += "、".join(item["name"] for item in assumed) + "按默认零关税算，没有查过税则，只作参考。"
    if blocked:
        head += f"另有 {blocked} 个 SKU 在所有市场都算不出（缺税率或缺成本），没进比较。"

    hint = ""
    known_demand = [item for item in stats if item.get("trade")]
    if len([item for item in ranked if not item["assumed_zero"]]) == 0:
        hint = ("各市场都还没有实测税率（现在按市场默认 0 算），跨市场比较只能看个方向。"
                "切到目标市场 → 「关税率…」把 HS 税率配一遍，这里才会给换市场建议。")
    elif blocked:
        hint = f"{blocked} 个 SKU 在各市场都缺税率，先把编码配齐，比较结果才有意义。"
    elif not known_demand:
        hint = ("还没有贸易需求数据，现在只按毛利排序。切到「UN Comtrade」同步一遍，"
                "「毛利高但没量」的市场会被压下去。")
    elif len(known_demand) < len([item for item in stats if item["ready"]]):
        hint = ("部分市场还没有贸易数据，那几个市场的排序只看毛利，没有考虑需求量。")

    return {
        "month": month,
        "current_market": current,
        "current_name": current_name,
        "headline": head,
        "hint": hint,
        "has_demand": bool(known_demand),
        "markets": ranked + [item for item in stats if not item["ready"]],
        "suggestions": (
            starved[:ADVICE_LIMIT] + switches[:ADVICE_LIMIT]
            + losses[:ADVICE_LIMIT] + thins[:4]
        ),
    }


__all__ = [
    "ADVICE_SWITCH_MIN",
    "ADVICE_THIN_MARGIN",
    "ADVICE_LIMIT",
    "build_advice",
]
