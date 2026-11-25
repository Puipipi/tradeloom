"""关税查询：按 HS 编码从官方税则接口取现行税率，基础与附加分开给。

先写死四条前提，免得后面被当成 bug：

1. **税率是「HS × 目的国 × 原产地 × 生效期」的函数**。原产地固定中国（导出方
   视角）。本模块不判断自贸协定优惠税率——那要凭原产地证，自动填进去会让毛利
   虚高。真要按 RCEP/ChAFTA 报，人工改「优惠%」那一栏。
2. **只查有稳定公开接口的市场**：美国（USITC HTS）、英国（UK Trade Tariff）、
   欧盟（TARIC）。日本/澳洲/香港没有机读接口，明确返回 ``supported=False`` 加
   官方查询链接，**不猜数**——猜出来的税率比空白危险。
3. **基础与附加分两个 slot 返回**，前端据此分别填「基础%」「附加%」：
   - 欧盟：TARIC 的 measures 里 Third country duty → base，anti-dumping /
     countervailing / additional duty → extra。**按编码可精确取到**。
   - 英国：Third country duty（ERGA OMNES）→ base；measure type 里
     anti-dumping / countervailing / additional duties → extra，只认地理区域为
     China 或 ERGA OMNES 的那些；同一类型多档（按出口商分档）取最高值并在 note
     里说明。**按编码可精确取到**。
   - 美国：HTS 只给 basic 列（Column 1 General）→ base。301 与对华加征在
     Chapter 99（9903.88 / 9903.01），条款本身能拉到费率，但**无法按商品码判定
     本商品落在哪份清单**，所以 extra 候选只列「现行对华加征条款 + 费率」，
     note 标明需核对清单，由人点选，不做自动匹配。
4. **一个 HS 可能同时有基础与附加两条候选**。用户先把基础填进「基础%」，再点
   附加候选填「附加%」，两栏相加才是实际税负——任何一栏空着都表示「没查」，
   不等于零。

对外只有一个 ``lookup(hs, market)``，返回结构：
``{market, hs, supported, source, source_url, fetched_at, candidates[], warnings[]}``。
每个候选 ``{code, desc, slot, base_rate, extra_rate, raw, specific, note}``，
``slot`` 为 ``"base"`` 或 ``"extra"``，``base_rate`` 为百分数（6.0 表示 6%），
附加候选的 ``base_rate`` 放的是附加费率（沿用同一字段，方便前端填格），
无法换算成从价税时为 ``None``。
"""
from __future__ import annotations

import html as html_module
import http.cookiejar
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
# 税则一天变不了几次；欧盟那次两步查询要十几秒，缓存给长一点。
CACHE_TTL = 10 * 60
CACHE_TTL_BY_MARKET = {"EU": 6 * 3600}
TIMEOUT = 8

OFFICIAL = {
    "US": ("USITC HTS", "https://hts.usitc.gov/search?keyword={q}"),
    "GB": ("UK Trade Tariff", "https://www.trade-tariff.service.gov.uk/commodities/{q}"),
    "EU": ("EU TARIC", "https://ec.europa.eu/taxation_customs/dds2/taric/taric_consultation.jsp?Lang=en"),
    "JP": ("Japan Customs", "https://www.customs.go.jp/english/tariff/2026_1/index.htm"),
    "AU": ("ABF Tariff", "https://www.abf.gov.au/importing-exporting-and-manufacturing/tariff-classification"),
    "HK": ("Hong Kong Customs", "https://www.customs.gov.hk/en/service-enforcement-information/trade-facilitation/index.html"),
    "CN": ("中国海关税则", "https://www.customs.gov.cn/"),
}

_PERCENT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_SPECIFIC_RE = re.compile(r"[¢€£$¥]|/\s*(kg|m2|m²|pcs|pair|litre|liter)", re.IGNORECASE)
_DIGITS_RE = re.compile(r"\D+")

_cache: dict[tuple[str, str], tuple[float, dict]] = {}
_cache_lock = threading.Lock()


class DutyLookupError(RuntimeError):
    """查询失败（网络、对方接口变更、编码查不到）。"""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def normalize_code(raw: object) -> str:
    """只留数字。``5806.32`` / ``5806 32 10`` / ``5806321000`` 都归一成数字串。

    HS 至少 4 位（品目）、常见 6 位（子目）、美英到 10 位（本国税则号）。
    """
    digits = _DIGITS_RE.sub("", str(raw or ""))
    if not 4 <= len(digits) <= 10:
        raise DutyLookupError("invalid_hs_code", digits[:20])
    return digits


def dotted(digits: str) -> str:
    """HS 数字串 → 带点的税则号（美国习惯写法 5806.32.10）。"""
    if len(digits) >= 10:
        return f"{digits[:4]}.{digits[4:6]}.{digits[6:8]}.{digits[8:]}"
    if len(digits) >= 8:
        return f"{digits[:4]}.{digits[4:6]}.{digits[6:8]}"
    if len(digits) >= 6:
        return f"{digits[:4]}.{digits[4:6]}"
    return digits


def parse_percent(text: object) -> tuple[float | None, bool]:
    """税则原文 → (百分数, 是否含从量/复合税)。

    ``"6%"`` → (6.0, False)；``"Free"`` → (0.0, False)；
    ``"1.4¢/kg + 4.5%"`` → (4.5, True) —— 从量部分没法折成百分比，
    标出来让人自己算，不装作只有 4.5%。
    """
    raw = str(text or "").strip()
    if not raw:
        return None, False
    lowered = raw.lower()
    if lowered in {"free", "exempt", "0", "0.0", "0%"}:
        return 0.0, False
    specific = bool(_SPECIFIC_RE.search(raw))
    found = _PERCENT_RE.findall(raw)
    if not found:
        return None, specific
    return round(sum(float(item) for item in found), 4), specific


def _http_json(url: str) -> dict | list:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8", "ignore"))
    except urllib.error.HTTPError as exc:
        raise DutyLookupError("duty_lookup_failed", f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise DutyLookupError("duty_lookup_failed", f"{type(exc).__name__}: {exc}") from exc
    except ValueError as exc:
        raise DutyLookupError("duty_lookup_failed", "返回不是 JSON") from exc


# ---------------------------------------------------------------- 美国

# Chapter 99 里对华加征的两族条款：301（9903.88，按 USTR 清单）与 9903.01。
# 每族一次拉回几十条，变不了几次，进程内缓存一天。
US_EXTRA_FAMILIES = (
    ("9903.88", "301 清单"),
    ("9903.01", "对华加征"),
)
US_EXTRA_TTL = 12 * 3600
# 「+ 25%」「plus 25%」两种写法都有
_EXTRA_RATE_RE = re.compile(r"(?:\+|plus)\s*(\d+(?:\.\d+)?)\s*%", re.IGNORECASE)
_us_extra_cache: tuple[float, list[dict]] | None = None
_us_extra_lock = threading.Lock()


def _us_extra_rows(family: str) -> list[dict]:
    """拉一个族（9903.88 / 9903.01）下所有条款，解析出对华附加费率。

    HTS 的 general 列写成「The duty provided in the applicable subheading +
    25%」，附加额就是这个 25。description 里没有 China 的（对墨西哥、加拿大、
    白俄等）一律丢掉——中国原产用不上。
    """
    url = (
        "https://hts.usitc.gov/reststop/exportList"
        f"?from={family}.01&to={family}.99&format=JSON&styles=false"
    )
    payload = _http_json(url)
    rows = payload if isinstance(payload, list) else []
    found: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = str(row.get("htsno") or "").strip()
        general = str(row.get("general") or "")
        desc = str(row.get("description") or "")
        if not code or "china" not in desc.lower():
            continue
        match = _EXTRA_RATE_RE.search(general)
        if not match:
            continue
        rate = float(match.group(1))
        if rate <= 0:
            continue
        found.append({"code": code, "rate": rate, "general": general.strip()[:60]})
    return found


def _us_extras() -> tuple[list[dict], list[str]]:
    """对华附加候选：按「族 + 费率」合并，同费率的几条并成一条。

    9903.88.01/02/03/04 都是 25%（分属 301 清单 1/2/3/4A），对成本没差别，
    拆成四条只会让人挑花眼。同一费率合并后 note 里列出全部条款号，报关行照着核。
    """
    global _us_extra_cache
    with _us_extra_lock:
        if _us_extra_cache and time.time() - _us_extra_cache[0] < US_EXTRA_TTL:
            return _us_extra_cache[1], []

    candidates: list[dict] = []
    warnings: list[str] = []
    for family, label in US_EXTRA_FAMILIES:
        try:
            rows = _us_extra_rows(family)
        except DutyLookupError as exc:
            warnings.append(f"{label}（{family}）条款没取到：{exc.detail or exc.code}")
            continue
        grouped: dict[float, list[str]] = {}
        for row in rows:
            grouped.setdefault(row["rate"], []).append(row["code"])
        for rate, codes in sorted(grouped.items(), reverse=True):
            candidates.append({
                "code": codes[0] if len(codes) == 1 else f"{codes[0]} 等 {len(codes)} 条",
                "desc": f"{label} +{rate:g}%",
                "slot": "extra",
                "base_rate": rate,
                "extra_rate": None,
                "raw": f"+{rate:g}%",
                "specific": False,
                "special": "",
                "note": "条款 " + "、".join(codes) + "；需确认本商品在该清单内",
            })
    with _us_extra_lock:
        _us_extra_cache = (time.time(), candidates)
    return candidates, warnings


def _us_candidates(query: str) -> list[dict]:
    payload = _http_json(f"https://hts.usitc.gov/reststop/search?keyword={urllib.parse.quote(query)}")
    rows = payload if isinstance(payload, list) else []
    found = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = str(row.get("htsno") or "").strip()
        general = str(row.get("general") or "").strip()
        if not code or not general or code in seen:
            continue
        seen.add(code)
        base, specific = parse_percent(general)
        if base is None and not specific:
            continue
        found.append({
            "code": code,
            "desc": str(row.get("description") or "").strip()[:80],
            "slot": "base",
            "base_rate": base,
            "extra_rate": None,
            "raw": general,
            "specific": specific,
            "special": str(row.get("special") or "").strip()[:120],
            "note": "",
        })
    return found


def _lookup_us(digits: str) -> dict:
    url = OFFICIAL["US"][1].format(q=urllib.parse.quote(dotted(digits)))
    candidates: list[dict] = []
    # 10 位统计号（5806.32.10.00）常常自己没有税率，税率挂在上一级 5806.32.10。
    # 逐级往上退，直到有人认领这一档；同一编码只留第一次的结果。
    tried = []
    lengths = {len(digits)}
    if len(digits) > 8:
        lengths.add(8)
    if len(digits) > 6:
        lengths.add(6)
    for length in sorted(lengths, reverse=True):
        query = dotted(digits[:length])
        if query in tried:
            continue
        tried.append(query)
        candidates = _us_candidates(query)
        if candidates:
            break
    if not candidates:
        raise DutyLookupError("duty_not_found", dotted(digits))
    extras, extra_warnings = _us_extras()
    return {
        "candidates": candidates + extras,
        "source": OFFICIAL["US"][0],
        "source_url": url,
        "warnings": [
            "基础列取 Column 1 General（最惠国）；附加候选来自 Chapter 99 现行对华加征条款，"
            "HTS 不按商品码给清单归属，请对照 USTR 清单或问报关行确认后点选填入。",
            "Column 2（与美无正常贸易关系）税率不适用于中国原产，未列。",
            *extra_warnings,
        ],
    }


# ---------------------------------------------------------------- 英国

def _uk_index(payload: dict) -> dict:
    return {
        f"{item.get('type')}:{item.get('id')}": item
        for item in payload.get("included") or []
        if isinstance(item, dict)
    }


def _uk_related(index: dict, obj: dict, name: str) -> dict | None:
    data = ((obj.get("relationships") or {}).get(name) or {}).get("data")
    if isinstance(data, dict):
        return index.get(f"{data.get('type')}:{data.get('id')}")
    return None


# 英国对华附加措施：measure type 名里带这些词的是「附加」（反倾销/反补贴/加征）
UK_EXTRA_KINDS = ("anti-dumping", "countervailing", "additional dut", "safeguard")
# 只认这两类地理区域：明确写 China 的，以及对全体国家（ERGA OMNES）的。
# 白俄、朝鲜那些措施对中国原产用不上，留下只会让人错填。
UK_EXTRA_ORIGINS = ("china", "erga omnes")


def _uk_commodity(digits: str) -> list[dict]:
    """一个英国 10 位税则号 → 候选列表（1 条基础 + 若干条附加）。

    与 HTS 不同，英国税则把每一项措施都列成 measure，反倾销也在里面，
    所以这里能按编码精确区到「中国原产 + 反倾销 48.5%」这一档。
    同一 measure type 会出多条（按出口商分档，有的档没写税率），
    合并成一条、取最高档，note 里说清有几档。
    """
    payload = _http_json(
        f"https://www.trade-tariff.service.gov.uk/api/v2/commodities/{digits}"
    )
    if not isinstance(payload, dict) or not payload.get("data"):
        raise DutyLookupError("duty_not_found", digits)
    index = _uk_index(payload)
    node = payload["data"]
    label = str((node.get("attributes") or {}).get("description") or "").strip()

    base = None
    raw = ""
    vat = None
    extras: dict[str, dict] = {}
    for item in payload.get("included") or []:
        if not isinstance(item, dict) or item.get("type") != "measure":
            continue
        attrs = item.get("attributes") or {}
        mtype = _uk_related(index, item, "measure_type")
        mname = str(((mtype or {}).get("attributes") or {}).get("description") or "")
        geo = _uk_related(index, item, "geographical_area")
        gname = str(((geo or {}).get("attributes") or {}).get("description") or "")
        expr = _uk_related(index, item, "duty_expression")
        text = str(((expr or {}).get("attributes") or {}).get("base") or "").strip()
        if attrs.get("vat") and text:
            vat = text
            continue
        if mname.startswith("Third country duty") and gname.upper().startswith("ERGA"):
            if base is None and text:
                raw = text
                base, _specific = parse_percent(text)
            continue
        lowered = mname.lower()
        if not any(kind in lowered for kind in UK_EXTRA_KINDS):
            continue
        if not any(origin in gname.lower() for origin in UK_EXTRA_ORIGINS):
            continue
        bucket = extras.setdefault(lowered, {"name": mname, "rates": [], "blank": 0, "start": ""})
        rate = parse_percent(text)[0] if text else None
        if rate is None:
            bucket["blank"] += 1
        else:
            bucket["rates"].append(rate)
        started = str(attrs.get("effective_start_date") or "")[:10]
        if started and not bucket["start"]:
            bucket["start"] = started

    if base is None and not raw:
        raise DutyLookupError("duty_not_found", digits)

    out = [{
        "code": digits,
        "desc": label[:80],
        "slot": "base",
        "base_rate": base,
        "extra_rate": None,
        "raw": raw,
        "specific": parse_percent(raw)[1],
        "special": "",
        "note": f"进口 VAT {vat}（可抵扣，不计入成本）" if vat else "",
    }]
    for bucket in extras.values():
        if not bucket["rates"]:
            continue
        top = max(bucket["rates"])
        bits = [bucket["name"]]
        if len(bucket["rates"]) > 1:
            bits.append(f"{len(bucket['rates'])} 档最高 {top:g}%")
        if bucket["blank"]:
            bits.append(f"另 {bucket['blank']} 档按出口商另定")
        if bucket["start"]:
            bits.append(f"{bucket['start']} 起")
        out.append({
            "code": digits,
            "desc": bucket["name"][:80],
            "slot": "extra",
            "base_rate": top,
            "extra_rate": None,
            "raw": f"{top:g}%",
            "specific": False,
            "special": "",
            "note": " · ".join(bits),
        })
    return out


def _uk_leaves(prefix: str) -> list[str]:
    """把一个前缀（6/8/10 位）展开成本国可报关的 10 位税则号。

    ``8712 00 30`` 这种 8 位「父级」在税则里是存在的，但 commodities 接口对
    它返回 404 —— 真正能报关的是它下面的 8712003010/020/090。所以查不到时
    按品目展开，别直接告诉人「没这一档」。
    """
    heading = _http_json(
        f"https://www.trade-tariff.service.gov.uk/api/v2/headings/{prefix[:4]}"
    )
    # 10 位码回退时按前 8 位比：8712003000 的子目是 8712003010/020/090，
    # 拿 10 位去 startswith 一个都匹配不上。
    stem = prefix[:8] if len(prefix) >= 10 else prefix
    leaves: list[str] = []
    if isinstance(heading, dict):
        for item in heading.get("included") or []:
            if not isinstance(item, dict) or item.get("type") != "commodity":
                continue
            code = str((item.get("attributes") or {}).get("goods_nomenclature_item_id") or "")
            if code.startswith(stem) and len(code) == 10 and code != prefix and code not in leaves:
                leaves.append(code)
    return leaves[:6]


def _lookup_uk(digits: str) -> dict:
    url = OFFICIAL["GB"][1].format(q=digits)
    warnings = [
        "取 Third country duty（ERGA OMNES，最惠国）作基础；附加取 measure 里"
        "反倾销/反补贴/加征，且只认 China 或 ERGA OMNES 两项地理区域。",
        "英国对部分国家有 Tariff preference，中国原产目前不适用，需办证才谈得上。",
    ]
    found: list[dict] = []
    if len(digits) >= 10:
        try:
            found = _uk_commodity(digits)
        except DutyLookupError:
            # 8 位父级码（8712003000）不可报关，展开到子目
            leaves = _uk_leaves(digits)
            if not leaves:
                raise
            with ThreadPoolExecutor(max_workers=len(leaves)) as pool:
                results = list(pool.map(_guard_commodity, leaves))
            found = [item for group in results if group for item in group]
            if found:
                first = next((c["code"] for c in found if c["slot"] == "base"), leaves[0])
                warnings.append(
                    f"{digits} 本身不可报关，已展开到 {first} 等 {len(leaves)} 个子目，按实际口径选一条。"
                )
    else:
        leaves = _uk_leaves(digits)
        if not leaves:
            raise DutyLookupError("duty_not_found", digits)
        with ThreadPoolExecutor(max_workers=len(leaves)) as pool:
            results = list(pool.map(_guard_commodity, leaves))
        found = [item for group in results if group for item in group]
    if not found:
        raise DutyLookupError("duty_not_found", digits)
    return {
        "candidates": found,
        "source": OFFICIAL["GB"][0],
        "source_url": url,
        "warnings": warnings,
    }


def _guard_commodity(code: str) -> list[dict] | None:
    try:
        return _uk_commodity(code)
    except DutyLookupError:
        return None


# ---------------------------------------------------------------- 欧盟

EU_BASE = "https://ec.europa.eu/taxation_customs/dds2/taric/"
EU_LIST = (
    EU_BASE + "measures.jsp?Lang=en&SimDate={date}&Area={area}&Taric={code}&Offset=0&OpCode=1"
)
# 原产地固定中国：用户是出口方，查的就是「中国原产发往欧盟」那一栏。
# 换成别的原产地（比如走越南转口）要改这里，别静默按 CN 算。
EU_ORIGIN = "CN"
# 措施名一律小写比较：TARIC 写的是「Definitive anti-dumping duty」，大小写不统一
EU_EXTRA_KINDS = ("anti-dumping", "countervailing", "additional dut")
EU_NOISY_SKIP = ("low-value", "handling fee")          # 按票计，值得提一句
EU_QUIET_SKIP = ("suspension", "airworthiness", "quota", "restriction", "import control", "export")

EU_TIMEOUT = 14
EU_MAX_FRAMES = 2


def _eu_opener():
    """TARIC 的结果页要带同一会话的 Sid 才能取到：先开 cookie 罐，再两步走。"""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [
        ("User-Agent", USER_AGENT),
        ("Accept-Language", "en-US,en;q=0.9"),
    ]
    return opener


def _eu_get(opener, url: str, timeout: int = TIMEOUT) -> str:
    try:
        with opener.open(url, timeout=timeout) as response:
            return response.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as exc:
        raise DutyLookupError("duty_lookup_failed", f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise DutyLookupError("duty_lookup_failed", f"{type(exc).__name__}: {exc}") from exc


def _clean(html_text: str) -> str:
    text = re.sub(r"<span[^>]*>.*?</span>", " ", html_text, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_module.unescape(text).replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def _eu_measures(page: str) -> list[dict]:
    """把措施明细页切成一条条「措施名 + 税率 + 法规号」。

    TARIC 没有 JSON，只能解析 HTML；但每块的骨架是稳定的：
    ``td_measure_description`` 里一个 ``<td>措施名</td><td><span class="duty_rate">税率</span>``，
    右侧 ``td_measure_regulation`` 里是法规号（R2658/87 之类）。
    """
    blocks = re.split(r'class="td_measure_description', page)[1:]
    measures = []
    for block in blocks:
        name_match = re.search(r"<table><tr[^>]*><td>(.*?)</td>", block, re.S)
        name = _clean(name_match.group(1)) if name_match else ""
        rate_match = re.search(r'class="duty_rate">([^<]+)<', block)
        rate_text = html_module.unescape(rate_match.group(1)).strip() if rate_match else ""
        dates = re.search(r"<span>\(([^)]*)\)</span>", block)
        reg = re.search(r'class="regulation_link"[^>]*>([^<]+)<', block)
        if not name:
            continue
        measures.append({
            "name": name,
            "rate_text": re.sub(r"\s+", " ", rate_text),
            "dates": _clean(dates.group(1)).replace("-", "–") if dates else "",
            "regulation": html_module.unescape(reg.group(1)).strip() if reg else "",
        })
    return measures


def _eu_code_text(digits: str) -> str:
    parts = [digits[:4], digits[4:6], digits[6:8], digits[8:10]]
    return " ".join(part for part in parts if part)


def _eu_frames(page: str) -> list[str]:
    """从结果页里挑出「措施明细」的框架地址，按税则号去重。

    这块 URL 带一次性 Sid，必须原样拼回去；只把 ``&amp;`` 复原成 ``&``。
    """
    urls = re.findall(r"measures_details\.jsp\?[^'\"]+", page)
    picked: list[str] = []
    seen: set[str] = set()
    for raw in urls:
        url = raw.replace("&amp;", "&")
        code = re.search(r"FrameId=taric_(\d+)_", url)
        key = code.group(1) if code else url
        if key in seen:
            continue
        seen.add(key)
        picked.append(url)
    return picked


def _eu_start_date(dates: str) -> str:
    """TARIC 的日期是 ``15-09-1994 - `` 这种区间，取起始日转成 ``1994-09-15``。"""
    match = re.search(r"(\d{2})-(\d{2})-(\d{4})", dates)
    return f"{match.group(3)}-{match.group(2)}-{match.group(1)}" if match else ""


def _eu_frame_measures(opener, frame: str, digits: str) -> dict:
    """取一个「本级子目」的措施明细。返回 ``{candidates, noisy}``。"""
    code_match = re.search(r"FrameId=taric_(\d+)_", frame)
    code = code_match.group(1) if code_match else digits
    detail = _eu_get(opener, EU_BASE + frame, EU_TIMEOUT)
    candidates = []
    noisy = []
    for measure in _eu_measures(detail):
        name = measure["name"]
        lowered = name.lower()
        if name.startswith("Third country duty"):
            slot = "base"
        elif any(kind in lowered for kind in EU_EXTRA_KINDS):
            slot = "extra"
        else:
            # 「低值包裹关税」「联盟处理费」这类按票计的钱，折不成百分比，
            # 但卖家必须知道它会加在每票上，所以单独提一句。
            if any(kind in lowered for kind in EU_NOISY_SKIP):
                noisy.append(f"{name}（{measure['rate_text'] or '—'}）")
            continue
        rate, specific = parse_percent(measure["rate_text"])
        if rate is None and not specific:
            continue
        started = _eu_start_date(measure["dates"])
        candidates.append({
            "code": _eu_code_text(code),
            "desc": name[:80],
            "slot": slot,
            "base_rate": rate,
            "extra_rate": None,
            "raw": measure["rate_text"],
            "specific": specific,
            "special": "",
            "note": " · ".join(part for part in (
                measure["regulation"], f"{started} 起" if started else "",
            ) if part),
        })
    return {"candidates": candidates, "noisy": noisy}


def _lookup_eu(digits: str) -> dict:
    opener = _eu_opener()
    date = time.strftime("%Y%m%d")
    page = _eu_get(opener, EU_LIST.format(date=date, area=EU_ORIGIN, code=digits), EU_TIMEOUT)
    frames = _eu_frames(page)[:EU_MAX_FRAMES]
    if not frames:
        raise DutyLookupError("duty_not_found", digits)

    # TARIC 单次响应常常 5–30 秒，串行两个框架就是半分钟；并行取，总时长由慢的那个决定。
    candidates: list[dict] = []
    noisy: list[str] = []
    failed = 0
    with ThreadPoolExecutor(max_workers=len(frames)) as pool:
        futures = [pool.submit(_eu_frame_measures, opener, frame, digits) for frame in frames]
        for future in futures:
            try:
                result = future.result()
            except DutyLookupError:
                failed += 1
                continue
            candidates.extend(result["candidates"])
            noisy.extend(result["noisy"])

    # 同一档会在多个框架里重复出现（6 位码查出「真边 / 其他」两条子目），去重
    unique: dict[tuple, dict] = {}
    for item in candidates:
        unique.setdefault((item["code"], item["desc"], item["raw"]), item)
    candidates = list(unique.values())

    if not any(item["slot"] == "base" for item in candidates):
        raise DutyLookupError("duty_not_found", digits)

    warnings = [
        "按中国原产查（TARIC Area=CN）。基础是 Third country duty，反倾销/反补贴单列在「附加」，"
        "两条都填才是实际税负。",
    ]
    if any(item["slot"] == "extra" for item in candidates):
        warnings.append("查到反倾销/反补贴措施，填报前请按税则号确认适用范围（部分只对特定厂商税率）。")
    if noisy:
        warnings.append("另有按票计的费用未折成百分比：" + "、".join(dict.fromkeys(noisy))[:120])
    if failed:
        warnings.append(f"有 {failed} 个子目没取到（TARIC 超时），结果可能不全。")
    return {
        "candidates": candidates,
        "source": OFFICIAL["EU"][0],
        "source_url": EU_LIST.format(date=date, area=EU_ORIGIN, code=digits),
        "warnings": warnings,
    }


# ---------------------------------------------------------------- 对外

ADAPTERS = {"US": _lookup_us, "GB": _lookup_uk, "EU": _lookup_eu}


def lookup(hs: object, market: str, use_cache: bool = True) -> dict:
    digits = normalize_code(hs)
    market_code = str(market or "").strip().upper()
    label, template = OFFICIAL.get(market_code, ("官方税则", ""))
    official_url = template.format(q=digits) if template else ""
    now_text = time.strftime("%Y-%m-%d %H:%M")

    adapter = ADAPTERS.get(market_code)
    if not adapter:
        return {
            "market": market_code,
            "hs": dotted(digits),
            "supported": False,
            "source": label,
            "source_url": official_url,
            "fetched_at": now_text,
            "candidates": [],
            "warnings": [
                f"{label} 没有稳定的公开查询接口（页面要交互才能出结果），基础和附加都只能手工填。"
                "点下面的链接到官网按编码查，查到后把基础税率填「基础%」，"
                "反倾销/加征等填「附加%」。",
            ],
        }

    key = (market_code, digits)
    ttl = CACHE_TTL_BY_MARKET.get(market_code, CACHE_TTL)
    if use_cache:
        with _cache_lock:
            hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return dict(hit[1], cached=True)

    result = adapter(digits)
    payload = {
        "market": market_code,
        "hs": dotted(digits),
        "supported": True,
        "source": result["source"],
        "source_url": result["source_url"],
        "fetched_at": now_text,
        "candidates": result["candidates"],
        "warnings": result.get("warnings") or [],
    }
    with _cache_lock:
        _cache[key] = (time.time(), payload)
    return payload


__all__ = ["DutyLookupError", "lookup", "normalize_code", "parse_percent", "dotted"]
