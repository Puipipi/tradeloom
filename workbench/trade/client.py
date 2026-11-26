"""UN Comtrade 贸易数据客户端。

只做三件事：把 HS 编码规范成 6 位、按「编码 × 年份」发一次请求、把返回行翻成
本地字段名。**业务口径不在这里**——份额、增速、需求量分档见 ``service.py``，
因为那些是「同一批原始行怎么算」的判断，随时会调，不该固化在取数层。

为什么默认走 public preview 端点而不是正式端点：

* preview **不需要 key**，限制是「一次一个 cmdCode、一个 period、500 行」；
* 而我们的查询形状本来就是「一个 HS6 × 一个年份 × 多个报告国」，正好卡在
  这个限制内——单次请求可以带 ``reporterCode=842,276,251,...`` 和
  ``partnerCode=0,156``，一次拿回全部市场与「世界合计 / 中国」两行；
* 14 个 HS6 × 2 年 = 28 次请求，免费档 500 次/天绰绰有余。

填了 key 才走 ``/data/v1/get``：可以一次多年份多编码，也不受 500 行限制。
两条路径返回的字段名一致，上层不用分支。
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

logger = logging.getLogger(__name__)

BASE = "https://comtradeapi.un.org"
PREVIEW_PATH = "/public/v1/preview/C/A/HS"
SUBSCRIPTION_PATH = "/data/v1/get/C/A/HS"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
TIMEOUT = 25
# 免费档限制 1 次/秒；留一点余量，否则连发两次会被 429 打回
MIN_INTERVAL = 1.05
PREVIEW_ROW_LIMIT = 500
RETRIES = 2

PARTNER_WORLD = 0
PARTNER_CHINA = 156

# 市场 → Comtrade 报告国代码。
#
# 欧盟**不是一个报告方**：Comtrade 里没有「EU 作为一个进口国」的年度商品数据，
# 只有各成员国。所以按五个主要进口国聚合，并在标签里写明——
# 让人知道这里的「欧盟」是德法意西荷之和，不是全部 27 国。
#
# 法国是 **251** 不是 250：UN M49 里 250 是「France, Monaco」这个历史条目，
# Comtrade 的 Reporters.json 根本没有它，查回来永远 0 行（曾因此让欧盟少算一国）。
MARKET_REPORTERS: dict[str, tuple[int, ...]] = {
    "US": (842,),
    "EU": (276, 251, 380, 724, 528),
    "GB": (826,),
    "JP": (392,),
    "AU": (36,),
    "HK": (344,),
    "CN": (156,),
}

EU_CORE = (276, 251, 380, 724, 528)

REPORTER_LABEL: dict[int, str] = {
    842: "美国",
    276: "德国",
    251: "法国",
    380: "意大利",
    724: "西班牙",
    528: "荷兰",
    826: "英国",
    392: "日本",
    36: "澳大利亚",
    344: "中国香港",
    156: "中国",
}


class TradeError(Exception):
    """取数失败。``code`` 给前端分支用，``detail`` 只进日志。"""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


def normalize_hs6(raw: object) -> str | None:
    """把台账里的 HS 编码规范成 6 位。

    台账允许写 ``5806.32``（带点）、``5806321010``（10 位国内税则）、``5806 32``。
    Comtrade 只认 HS6，所以统一去掉非数字取前 6 位。
    不足 6 位的（比如只填到章 ``58``）返回 ``None``——拿 2 位编码去查会得到
    「整个章节的贸易额」，和这个 SKU 没关系，属于看着有数其实没意义。
    """
    digits = re.sub(r"\D", "", str(raw or ""))
    if len(digits) < 6:
        return None
    return digits[:6]


def market_reporters(code: str) -> tuple[int, ...]:
    return MARKET_REPORTERS.get(str(code or "").upper(), ())


def market_label(code: str) -> str:
    """市场在 Comtrade 面板里的显示名。欧盟要标口径，不能只写「欧盟」。"""
    key = str(code or "").upper()
    if key == "EU":
        return "欧盟（德法意西荷）"
    reporters = MARKET_REPORTERS.get(key) or ()
    if len(reporters) == 1:
        return REPORTER_LABEL.get(reporters[0], key)
    return key


def default_years(lookback: int, today: date | None = None) -> list[int]:
    """默认回看年份，**从去年开始**。

    Comtrade 的年度数据滞后 1–2 年：今年能查到的最新完整年度通常是去年，
    再新的年份即使能返回也可能是残缺月份累计。从 ``今年-1`` 往前数，
    避免把「今年还没发布」误读成「今年没贸易」。
    """
    latest = (today or date.today()).year - 1
    count = max(1, min(int(lookback or 3), 10))
    return [latest - offset for offset in range(count)]


# ---------------------------------------------------------------- HTTP

_lock = threading.Lock()
_last_call = 0.0


def _throttle() -> None:
    """全局串行 + 最小间隔。多线程同时同步会把 1 次/秒的额度瞬间打满。"""
    global _last_call
    with _lock:
        wait = MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()


def _get(url: str, api_key: str = "") -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if api_key:
        headers["Ocp-Apim-Subscription-Key"] = api_key
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            raw = response.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as exc:
        # 401/403 是 key 无效，429 是限流，其余按上游故障
        if exc.code in (401, 403):
            raise TradeError("trade_key_rejected", f"HTTP {exc.code}") from exc
        if exc.code == 429:
            raise TradeError("trade_rate_limited", "HTTP 429") from exc
        if exc.code == 400:
            raise TradeError("trade_bad_request", "HTTP 400") from exc
        raise TradeError("trade_unavailable", f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise TradeError("trade_unavailable", f"{type(exc).__name__}: {exc}") from exc
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise TradeError("trade_unavailable", "返回不是 JSON") from exc
    if not isinstance(payload, dict):
        raise TradeError("trade_unavailable", "返回结构异常")
    return payload


def _query(**params: object) -> str:
    clean = {key: value for key, value in params.items() if value not in (None, "", ())}
    return urllib.parse.urlencode(clean, safe=",")


def fetch(
    hs6: str,
    year: int,
    reporters: tuple[int, ...],
    partners: tuple[int, ...] = (PARTNER_WORLD, PARTNER_CHINA),
    flow: str = "M",
    api_key: str = "",
) -> list[dict]:
    """取一个 HS6、一个年份的观测行。

    一次请求带全部报告国与「世界 / 中国」两个伙伴，返回行数最多
    ``len(reporters) * len(partners)``（欧盟 5 国就是 10 行），远低于 500 行上限。
    """
    if not reporters:
        return []
    query = _query(
        reporterCode=",".join(str(code) for code in reporters),
        period=int(year),
        partnerCode=",".join(str(code) for code in partners),
        cmdCode=hs6,
        flowCode=flow,
        # 固定按「报告国申报版本」取：混用 H5/H6 会让跨年比较口径漂移
        clCode="HS",
    )
    path = SUBSCRIPTION_PATH if api_key else PREVIEW_PATH
    url = f"{BASE}{path}?{query}"

    last_error: TradeError | None = None
    for attempt in range(RETRIES + 1):
        _throttle()
        try:
            payload = _get(url, api_key)
            break
        except TradeError as exc:
            last_error = exc
            # 只有限流和上游故障值得重试；key 无效重试多少次都一样
            if exc.code not in ("trade_rate_limited", "trade_unavailable"):
                raise
            if attempt < RETRIES:
                time.sleep(1.5 * (attempt + 1))
    else:
        raise last_error or TradeError("trade_unavailable", "重试耗尽")

    rows = payload.get("data") or []
    if not isinstance(rows, list):
        return []
    if not api_key and len(rows) >= PREVIEW_ROW_LIMIT:
        # 命中 preview 上限：说明这个查询形状超了（通常是多报告国 × 多伙伴打满）。
        # 不当成错误——拿到的 500 行仍然可用，但要在流水里留一句，免得以为数据完整。
        logger.warning("Comtrade preview 命中行数上限：%s / %s", hs6, year)
    return [_row(item, hs6, flow) for item in rows if isinstance(item, dict)]


def _num(value: object) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _row(item: dict, hs6: str, flow: str) -> dict:
    """把 Comtrade 的一行翻成模型字段。

    ``cmdCode`` 可能是 ``TOTAL`` 或 4 位（上游按聚合层返回），只收我们查的那个
    6 位编码：混进章节合计会让需求量翻好几倍。
    """
    cmd = str(item.get("cmdCode") or "")
    if cmd and cmd != hs6:
        return {}
    reporter = item.get("reporterCode")
    partner = item.get("partnerCode")
    try:
        reporter_code = int(reporter)
    except (TypeError, ValueError):
        return {}
    try:
        partner_code = int(partner) if partner is not None else 0
    except (TypeError, ValueError):
        partner_code = 0
    period = item.get("period")
    try:
        period_code = int(str(period)[:4])
    except (TypeError, ValueError):
        return {}
    value = _num(item.get("primaryValue")) or 0.0
    return {
        "hs6": hs6,
        "reporter_code": reporter_code,
        "reporter_name": REPORTER_LABEL.get(reporter_code, str(item.get("reporterDesc") or "")),
        "partner_code": partner_code,
        "partner_name": "世界" if partner_code == PARTNER_WORLD else (
            "中国" if partner_code == PARTNER_CHINA else str(item.get("partnerDesc") or "")
        ),
        "flow": str(item.get("flowCode") or flow).upper(),
        "period": period_code,
        "primary_value": round(value, 2),
        "net_wgt": _num(item.get("netWgt")),
        "qty": _num(item.get("qty")),
        "qty_unit": str(item.get("qtyUnitAbbr") or ""),
        "source": "UN Comtrade",
    }


__all__ = [
    "TradeError",
    "MARKET_REPORTERS",
    "REPORTER_LABEL",
    "PARTNER_WORLD",
    "PARTNER_CHINA",
    "normalize_hs6",
    "market_reporters",
    "market_label",
    "default_years",
    "fetch",
]
