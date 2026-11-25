"""市场口径：把「结算币种」升级成「市场」。

为什么要有这一层：同一个 SKU 发到不同国家，**关税率完全不同**（美国有 301 附加税、
欧盟对部分纺织品有反倾销）。关税不能挂在 SKU 上，也不该每单手填——它是
「HS 编码 × 目的国 × 生效期」的规则，见 ``SkuDutyRate`` 表。

这里只放市场的外框：市场决定用哪个币种报价，以及**没有配税率时**的兜底值。
真正的税率由 ``store.duty_rate_for()`` 按 HS 前缀从表里取，取不到才用它。

``default_duty=None`` 是刻意的：表示「这个市场还没配税率，我不知道」。
绝不能填 0 装作知道——那会把毛利算得偏高，比不显示更危险。
"""
from __future__ import annotations

MARKETS = {
    "US": {
        "name": "美国",
        "currency": "USD",
        "default_duty": None,
        "hint": "中国产丝带常见「基础税率 + 301 附加税」，需查 HS 税则后录入",
    },
    "EU": {
        "name": "欧盟",
        "currency": "EUR",
        "default_duty": None,
        "hint": "欧盟对部分纺织品有反倾销税，按 HS 逐条确认",
    },
    "GB": {
        "name": "英国",
        "currency": "GBP",
        "default_duty": None,
        "hint": "英国脱欧后执行本国税则，与欧盟税率不同",
    },
    "JP": {
        "name": "日本",
        "currency": "JPY",
        "default_duty": None,
        "hint": "日本按 HS 计征，另有关税同盟口径差异",
    },
    "AU": {
        "name": "澳大利亚",
        "currency": "AUD",
        "default_duty": None,
        "hint": "中澳自贸协定项下部分商品可享优惠税率，需原产地证",
    },
    "HK": {
        "name": "中国香港",
        "currency": "HKD",
        "default_duty": 0.0,
        "hint": "香港自由港，一般货物零关税（烟酒等除外）",
    },
    "CN": {
        "name": "中国内地",
        "currency": "CNY",
        "default_duty": 0.0,
        "hint": "内销不涉及进口关税",
    },
}

MARKET_ORDER = ["US", "EU", "GB", "JP", "AU", "HK", "CN"]
DEFAULT_MARKET = "US"


def normalize_market(code: object) -> str:
    value = str(code or "").strip().upper()
    return value if value in MARKETS else DEFAULT_MARKET


def is_market(code: object) -> bool:
    return str(code or "").strip().upper() in MARKETS


def market_currency(code: object) -> str:
    return MARKETS[normalize_market(code)]["currency"]


def market_for_currency(currency: object) -> str:
    """按币种反推市场，用于兼容旧接口（只传 currency 不传 market）。"""
    target = str(currency or "").strip().upper()
    for key in MARKET_ORDER:
        if MARKETS[key]["currency"] == target:
            return key
    return DEFAULT_MARKET


def market_name(code: object) -> str:
    return MARKETS[normalize_market(code)]["name"]


def default_duty(code: object) -> float | None:
    return MARKETS[normalize_market(code)]["default_duty"]


def market_table(selected: str | None = None) -> list[dict]:
    """页面用的市场列表，保持声明顺序。"""
    current = normalize_market(selected)
    return [
        {
            "code": key,
            "name": info["name"],
            "currency": info["currency"],
            "default_duty": info["default_duty"],
            "hint": info["hint"],
            "selected": key == current,
        }
        for key in MARKET_ORDER
        for info in (MARKETS[key],)
    ]
