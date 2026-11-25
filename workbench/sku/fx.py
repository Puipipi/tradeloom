"""汇率：币种口径与三源交叉校验。

口径只有一条：**rate 永远是「1 单位外币兑 CNY」**。日元牌价按 100 显示只是
读数习惯（``per``），计算时绝不乘 100——历史上单位错算比汇率波动坑得多。

三个源都给 USD 基准的全币种表，本模块统一折成 CNY 口径，再逐币种取中位数。
任一源失败不影响其它源；全部失败时抛 ``FxUnavailable``，由上层回退缓存。
"""
from __future__ import annotations

import json
import statistics
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

# 支持的结算币种。per = 报价习惯；sane = 1 单位（或 per 单位）兑人民币的合理区间，
# 越界的源直接丢弃，避免把「100 JPY」当成「1 JPY」这类单位错漏折进成本。
CURRENCIES = {
    "USD": {"name": "美元", "symbol": "US$", "per": 1, "sane": (5.0, 9.0), "fallback": 6.68},
    "EUR": {"name": "欧元", "symbol": "€", "per": 1, "sane": (6.0, 10.5), "fallback": 7.75},
    "JPY": {"name": "日元", "symbol": "JP¥", "per": 100, "sane": (3.0, 9.5), "fallback": 4.45},
    "HKD": {"name": "港币", "symbol": "HK$", "per": 1, "sane": (0.70, 1.30), "fallback": 0.855},
    "AUD": {"name": "澳元", "symbol": "A$", "per": 1, "sane": (3.50, 6.50), "fallback": 4.40},
    "GBP": {"name": "英镑", "symbol": "£", "per": 1, "sane": (7.00, 12.00), "fallback": 9.10},
    # 本币：汇率恒为 1，不参与抓取与交叉校验，只为让「中国内地」市场能自洽报价。
    "CNY": {"name": "人民币", "symbol": "¥", "per": 1, "sane": (0.99, 1.01), "fallback": 1.0},
}
CURRENCY_ORDER = ["USD", "EUR", "JPY", "HKD", "AUD", "GBP", "CNY"]
DEFAULT_CURRENCY = "USD"

FX_SOURCES = (
    ("open.er-api.com",
     "https://open.er-api.com/v6/latest/USD", ("rates",)),
    ("frankfurter.app",
     "https://api.frankfurter.app/latest?from=USD&to=CNY,EUR,JPY,HKD,AUD,GBP", ("rates",)),
    ("fawazahmed0/cdn",
     "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
     ("usd",)),
)

FX_TTL_SECONDS = 30 * 60
DIVERGE_LIMIT = 0.015
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class FxUnavailable(RuntimeError):
    """所有汇率源都没取到可用数据。"""


def normalize_currency(code: object) -> str:
    value = str(code or "").strip().upper()
    return value if value in CURRENCIES else DEFAULT_CURRENCY


def is_currency(code: object) -> bool:
    return str(code or "").strip().upper() in CURRENCIES


def fallback_rate(code: str) -> float:
    return CURRENCIES[normalize_currency(code)]["fallback"]


def fallback_rates() -> dict[str, float]:
    return {code: CURRENCIES[code]["fallback"] for code in CURRENCY_ORDER}


def display_rate(code: str, per_unit: float | None) -> float | None:
    """按报价习惯换算成给人看的数（日元 ×100）。仅用于展示。"""
    if per_unit is None:
        return None
    return per_unit * CURRENCIES[normalize_currency(code)]["per"]


def as_float(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    try:
        return float(str(value).strip().replace(",", ""))
    except (TypeError, ValueError):
        return None


def _sane(code: str, per_unit: float) -> bool:
    low, high = CURRENCIES[code]["sane"]
    return low < per_unit * CURRENCIES[code]["per"] < high


def _http_json(url: str, timeout: int = 8) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "ignore"))


def _cny_per_unit(usd_base: dict) -> dict[str, float]:
    """把 USD 基准表折成「1 外币 = ? CNY」。缺 CNY 直接判该源无效。

    本币 CNY 恒为 1，不参与折算——它是基准，抓回来的表里本来也没有「CNY 兑 CNY」。
    """
    cny = as_float(usd_base.get("CNY") or usd_base.get("cny"))
    if not cny or cny <= 0:
        raise ValueError("返回里没有 CNY")
    rates: dict[str, float] = {"CNY": 1.0}
    for code in CURRENCY_ORDER:
        if code == "CNY":
            continue
        raw = as_float(usd_base.get(code) if usd_base.get(code) is not None else usd_base.get(code.lower()))
        if not raw or raw <= 0:
            continue
        per_unit = cny / raw
        if _sane(code, per_unit):
            rates[code] = per_unit
    rates.setdefault("USD", cny)
    return rates


def fetch_rates() -> dict:
    """三源并行抓取，逐币种取中位数。返回符合 store 字段名的 dict。"""
    def fetch(source: tuple) -> dict:
        name, url, path = source
        try:
            payload = _http_json(url)
            for key in path:
                payload = payload[key]
            if not isinstance(payload, dict):
                raise ValueError("字段不是对象")
            return {"source": name, "rates": _cny_per_unit(payload)}
        except Exception as exc:  # noqa: BLE001 — 单源失败不该拖垮整体
            return {"source": name, "error": f"{type(exc).__name__}: {exc}"[:120]}

    with ThreadPoolExecutor(max_workers=len(FX_SOURCES)) as pool:
        quotes = list(pool.map(fetch, FX_SOURCES))

    rates: dict[str, float] = {}
    winners: dict[str, list[str]] = {}
    spreads: list[float] = []
    for code in CURRENCY_ORDER:
        values = [q["rates"][code] for q in quotes if code in (q.get("rates") or {})]
        if not values:
            continue
        median = statistics.median(values)
        rates[code] = median
        winners[code] = [q["source"] for q in quotes
                         if code in (q.get("rates") or {})
                         and abs(q["rates"][code] - median) < median * 1e-9] or ["中位数"]
        if len(values) > 1:
            spreads.append((max(values) - min(values)) / median)
    if not rates:
        messages = "; ".join(f"{q['source']}: {q.get('error', '无数据')}" for q in quotes)
        raise FxUnavailable(messages or "汇率源全部失败")

    spread = max(spreads) if spreads else 0.0
    usable = [q for q in quotes if q.get("rates")]
    return {
        "base": "USD",
        "rates": {code: round(value, 6) for code, value in rates.items()},
        "sources": winners,
        "quotes": quotes,
        "source": usable[0]["source"] if usable else "",
        "source_count": len(usable),
        "divergent": spread > DIVERGE_LIMIT,
        "spread": round(spread, 6),
    }


def with_change(rates: dict, previous: dict | None) -> dict[str, float]:
    previous = previous or {}
    out: dict[str, float] = {}
    for code, value in (rates or {}).items():
        before = as_float(previous.get(code))
        if before:
            out[code] = round((float(value) - before) / before, 6)
    return out


def currency_table(rates: dict | None, changes: dict | None, keep: str) -> list[dict]:
    """页面用的六行牌价。keep = 当前选中的结算币种。"""
    rates = rates or {}
    changes = changes or {}
    rows = []
    for code in CURRENCY_ORDER:
        info = CURRENCIES[code]
        per_unit = as_float(rates.get(code))
        if per_unit is None and code == "CNY":
            # 本币恒为 1：旧快照里没有 CNY（抓取表是 USD 基准，没有「CNY 兑 CNY」）
            per_unit = 1.0
        shown = None if per_unit is None else per_unit * info["per"]
        change = as_float(changes.get(code))
        rows.append({
            "code": code,
            "name": info["name"],
            "symbol": info["symbol"],
            "per": info["per"],
            "rate": per_unit,
            "shown": shown,
            "shown_text": "" if shown is None else f"{shown:.4f}",
            "unit_text": f"{info['per']} {code}" if info["per"] != 1 else code,
            "change": change,
            "change_text": "" if change is None else f"{change * 100:+.2f}%",
            "dir": "" if not change else ("up" if change > 0 else "down"),
            "selected": code == normalize_currency(keep),
        })
    return rows
