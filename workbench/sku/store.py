"""持久化层：所有数据库读写都收在这里，service 只做计算。

清单与成本分两张表，因为它们的生命周期完全不同：清单可随时从 CSV 或官网后台
重建，成本是人工填的、必须备份。分开才敢放心重导清单而不担心冲掉成本。

写操作一律包在 ``transaction.atomic()`` 里——JSON 文件时代靠一把进程内锁，
多进程/多标签页同时写就丢数据，这是迁到 ORM 的主要原因。
"""
from __future__ import annotations

import re

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from workbench.models import (
    SkuCatalogImport,
    SkuCatalogItem,
    SkuCostEntry,
    SkuDutyRate,
    SkuFxSnapshot,
    SkuPeriodCost,
    SkuSetting,
)

from . import catalog, fx, market, service

CATALOG_FIELDS = ("name", "series", "sub_category", "material", "size")
IMPORT_HISTORY_KEEP = 20
# 选品比较里排除的市场：本地市场不涉及出口关税与跨境头程，放进来会以 0 关税霸榜
ADVICE_SKIP_MARKETS = ("CN",)


class StoreError(ValueError):
    """可预期的数据约束错误，由 api 层翻译成 error_code。"""

    def __init__(self, code: str, message: str = "", status: int = 400) -> None:
        self.code = code
        self.status = status
        super().__init__(message or code)


def short_time(value) -> str:
    if value is None:
        return ""
    return timezone.localtime(value).strftime("%Y-%m-%d %H:%M")


# ---------------------------------------------------------------- 设置

def load_settings() -> dict:
    row, _created = SkuSetting.objects.get_or_create(pk=1)
    # 币种由市场决定，单一口径：市场是目的国，币种只是它的报价单位。
    mk = market.normalize_market(row.market)
    currency = market.market_currency(mk)
    manual = row.fx_manual if isinstance(row.fx_manual, dict) else {}
    hand = fx.as_float(manual.get(currency)) or fx.fallback_rate(currency)
    return {
        "market": mk,
        "currency": currency,
        "channel": row.channel if row.channel in service.CHANNELS else service.DEFAULT_CHANNEL,
        "fx_mode": "manual" if row.fx_mode == "manual" else "auto",
        "fx_manual": {code: fx.as_float(value) for code, value in manual.items() if fx.as_float(value)},
        "rebate": fx.as_float(row.rebate) or 0.0,
        "fixed_fee": fx.as_float(row.fixed_fee),
        "fx": hand,
    }


def save_settings(patch: dict) -> dict:
    if not isinstance(patch, dict):
        raise StoreError("invalid_arguments", "settings 必须是对象")
    with transaction.atomic():
        row, _created = SkuSetting.objects.get_or_create(pk=1)
        if "market" in patch:
            value = patch["market"]
            if not market.is_market(value):
                raise StoreError("unknown_market", f"不支持的市场：{value}")
            row.market = market.normalize_market(value)
        elif "currency" in patch:
            # 兼容只传币种的旧调用：按币种反推市场
            if not fx.is_currency(patch["currency"]):
                raise StoreError("unknown_currency", f"不支持的币种：{patch['currency']}")
            row.market = market.market_for_currency(patch["currency"])
        if "channel" in patch:
            channel = str(patch["channel"] or "")
            if channel not in service.CHANNELS:
                raise StoreError("invalid_arguments", "未知渠道")
            row.channel = channel
        if "fx_mode" in patch:
            row.fx_mode = "manual" if patch["fx_mode"] == "manual" else "auto"
        if "rebate" in patch:
            row.rebate = service.to_decimal(patch["rebate"]) or 0
        if "fixed_fee" in patch:
            row.fixed_fee = service.to_decimal(patch["fixed_fee"])
        # 市场必须与币种一致，避免出现「EUR 市场按 USD 报价」这种错配
        row.currency = market.market_currency(row.market)
        if "fx" in patch:
            # 手填汇率按币种分开存，切市场不会互相覆盖
            manual = dict(row.fx_manual or {})
            value = fx.as_float(patch["fx"])
            if value:
                manual[row.currency] = value
            else:
                manual.pop(row.currency, None)
            row.fx_manual = manual
        row.save()
    return load_settings()


# ---------------------------------------------------------------- 关税税率

def load_duty_map(mk: str) -> dict[str, float]:
    """当前市场的 ``{HS前缀: 有效税率}``，有效税率 = 基础 + 附加。

    只放匹配用的数字；展示用的明细走 ``list_duty_rates``。
    """
    market_code = market.normalize_market(mk)
    out: dict[str, float] = {}
    for rate in SkuDutyRate.objects.filter(market=market_code):
        prefix = (rate.hs_prefix or "").strip()
        if not prefix:
            continue
        out[prefix] = float(rate.base_rate or 0) + float(rate.extra_rate or 0)
    return out


def load_preferred_map(mk: str) -> dict[str, float]:
    """当前市场的 ``{HS前缀: 优惠税率}``，只收真填了优惠税率的行。

    单独一张映射而不是并进 ``load_duty_map``：优惠税率不进成本计算，
    放一起早晚会被误当有效税率用掉。
    """
    market_code = market.normalize_market(mk)
    out: dict[str, float] = {}
    for rate in SkuDutyRate.objects.filter(market=market_code):
        prefix = (rate.hs_prefix or "").strip()
        if prefix and rate.preferred_rate is not None:
            out[prefix] = float(rate.preferred_rate)
    return out


def all_duty_prefixes() -> list[dict]:
    """所有市场配过的 HS 前缀（去重）。

    这些编码是**这批货真实报关用过的**——台账里逐 SKU 填的 hs_code 可能还没填，
    但关税表里有就说明确实按这个编码出口。UN Comtrade 面板用它兜底，
    否则「没填 HS」会被误判成「没有商品」。
    """
    seen: dict[str, dict] = {}
    for rate in SkuDutyRate.objects.all().order_by("hs_prefix", "market"):
        prefix = str(rate.hs_prefix or "").strip()
        if not prefix:
            continue
        item = seen.setdefault(prefix, {"prefix": prefix, "markets": []})
        if rate.market not in item["markets"]:
            item["markets"].append(rate.market)
    return list(seen.values())


def list_duty_rates(mk: str) -> list[dict]:
    market_code = market.normalize_market(mk)
    rows = []
    for rate in SkuDutyRate.objects.filter(market=market_code):
        base = float(rate.base_rate or 0)
        extra = float(rate.extra_rate or 0)
        preferred = None if rate.preferred_rate is None else float(rate.preferred_rate)
        rows.append({
            "hs_prefix": rate.hs_prefix,
            "base_rate": base,
            "extra_rate": extra,
            "preferred_rate": preferred,
            "rate": base + extra,
            "rate_text": f"{(base + extra) * 100:.2f}%",
            "preferred_text": "" if preferred is None else f"{preferred * 100:.2f}%",
            "note": rate.note or "",
        })
    return rows


def replace_duty_rates(mk: str, rows: list[dict]) -> list[dict]:
    """整表覆盖某个市场的税率（页面那个小表格就是这么保存的）。

    整表覆盖而不是逐行增删：税率表本来就短，整体替换比算差集简单可靠，
    也避免删到一半失败留下残缺规则。
    """
    market_code = market.normalize_market(mk)
    if not isinstance(rows, list):
        raise StoreError("invalid_arguments", "duty 必须是数组")
    cleaned: list[SkuDutyRate] = []
    seen: set[str] = set()
    for item in rows:
        if not isinstance(item, dict):
            continue
        prefix = str(item.get("hs_prefix") or "").strip()
        if not prefix:
            continue
        if not all(ch.isdigit() or ch in ".-" for ch in prefix):
            raise StoreError("invalid_hs_prefix", f"HS 前缀只能含数字、点和短横线：{prefix}")
        if prefix in seen:
            raise StoreError("duplicate_hs_prefix", f"HS 前缀重复：{prefix}")
        seen.add(prefix)
        base = service.percent(item.get("base_rate"))
        extra = service.percent(item.get("extra_rate"))
        preferred = service.percent(item.get("preferred_rate"))
        if base is not None and not (0 <= base <= 3):
            raise StoreError("invalid_duty_rate", f"基础税率超出合理范围：{item.get('base_rate')}")
        if extra is not None and not (0 <= extra <= 3):
            raise StoreError("invalid_duty_rate", f"附加税率超出合理范围：{item.get('extra_rate')}")
        if preferred is not None and not (0 <= preferred <= 3):
            raise StoreError("invalid_duty_rate", f"优惠税率超出合理范围：{item.get('preferred_rate')}")
        cleaned.append(SkuDutyRate(
            market=market_code,
            hs_prefix=prefix,
            base_rate=service.to_decimal(base) or 0,
            extra_rate=service.to_decimal(extra) or 0,
            preferred_rate=service.to_decimal(preferred),
            note=str(item.get("note") or "").strip()[:200],
        ))
    with transaction.atomic():
        SkuDutyRate.objects.filter(market=market_code).delete()
        if cleaned:
            SkuDutyRate.objects.bulk_create(cleaned)
    return list_duty_rates(market_code)


# ---------------------------------------------------------------- 清单

def _catalog_dict(item: SkuCatalogItem) -> dict:
    return {
        "sku": item.sku,
        "name": item.name,
        "series": item.series,
        "sub_category": item.sub_category,
        "material": item.material,
        "size": item.size,
        "url": item.url,
        "image": item.image,
        "active": item.active,
    }


def load_catalog() -> list[dict]:
    return [_catalog_dict(item) for item in SkuCatalogItem.objects.all()]


def import_catalog(records: list[dict], source: str = "导入") -> dict:
    """按 SKU 合并清单。新 SKU 追加；已存在的只覆盖非空字段，空单元格不抹原值。"""
    if not records:
        raise StoreError("empty_content", "没有可导入的行")
    created: list[str] = []
    updated: list[str] = []
    skipped = 0
    with transaction.atomic():
        existing = {item.sku.lower(): item for item in SkuCatalogItem.objects.all()}
        position = SkuCatalogItem.objects.aggregate(top=Max("position"))["top"] or 0
        for raw in records:
            data = catalog.normalize_record(raw)
            sku = data["sku"]
            if not sku:
                skipped += 1
                continue
            key = sku.lower()
            item = existing.get(key)
            if item is None:
                position += 1
                item = SkuCatalogItem(sku=sku, position=position, source=source)
                for field in CATALOG_FIELDS:
                    setattr(item, field, data[field] or "")
                item.active = True if data["active"] is None else data["active"]
                item.save()
                existing[key] = item
                created.append(sku)
            else:
                changed = False
                for field in CATALOG_FIELDS:
                    value = data[field]
                    if value:
                        setattr(item, field, value)
                        changed = True
                if data["active"] is not None and item.active != data["active"]:
                    item.active = data["active"]
                    changed = True
                if item.source != source:
                    item.source = source
                    changed = True
                if changed:
                    item.save()
                updated.append(item.sku)
        total = SkuCatalogItem.objects.count()
        SkuCatalogImport.objects.create(
            source=source, added=len(created), updated=len(updated), skipped=skipped, total=total,
        )
        _trim_import_history()
    return {
        "added": len(created),
        "added_skus": created[:30],
        "updated": len(updated),
        "skipped": skipped,
        "total": total,
        "source": source,
    }


def _trim_import_history() -> None:
    stale = list(SkuCatalogImport.objects.values_list("id", flat=True)[IMPORT_HISTORY_KEEP:])
    if stale:
        SkuCatalogImport.objects.filter(id__in=stale).delete()


def catalog_meta() -> dict:
    latest = SkuCatalogImport.objects.first()
    return {
        "generated_at": short_time(latest.created_at) if latest else "",
        "source": latest.source if latest else "",
        "sku_total": SkuCatalogItem.objects.filter(active=True).count(),
        "sku_total_all": SkuCatalogItem.objects.count(),
        "last_import": {
            "at": short_time(latest.created_at),
            "source": latest.source,
            "added": latest.added,
            "updated": latest.updated,
            "skipped": latest.skipped,
            "total": latest.total,
        } if latest else {},
        "import_count": SkuCatalogImport.objects.count(),
    }


# ---------------------------------------------------------------- 成本

def load_costs() -> dict[str, dict]:
    """Decimal 转 float 再交出去：接口与模板都按数字用，JSON 里不该出现 "10.000000" 这种字符串。"""
    costs: dict[str, dict] = {}
    for entry in SkuCostEntry.objects.all():
        item = {"hs_code": entry.hs_code or "", "price_currency": entry.price_currency or ""}
        for field in service.FILLABLE:
            if field == "hs_code":
                continue
            value = getattr(entry, field)
            item[field] = None if value is None else float(value)
        costs[entry.sku] = item
    return costs


def update_costs(patch: dict, currency: str) -> None:
    """patch: {sku: {字段: 值}}。空值 = 清除该格；整行空则删行，不留空壳。"""
    if not isinstance(patch, dict):
        raise StoreError("invalid_arguments", "patch 必须是 {sku: {字段: 值}}")
    with transaction.atomic():
        for sku, fields in patch.items():
            sku = str(sku or "").strip()
            if not sku or not isinstance(fields, dict):
                continue
            entry, _created = SkuCostEntry.objects.get_or_create(sku=sku)
            for field, value in fields.items():
                if field not in service.FILLABLE:
                    continue
                if field in service.TEXT_FILLABLE:
                    setattr(entry, field, str(value or "").strip())
                else:
                    setattr(entry, field, service.to_decimal(value))
            if "price" in fields:
                entry.price_currency = "" if entry.price is None else currency
            if _is_blank(entry):
                entry.delete()
            else:
                entry.save()


def _is_blank(entry: SkuCostEntry) -> bool:
    if (entry.hs_code or "").strip():
        return False
    return all(getattr(entry, field) is None for field in service.FILLABLE if field != "hs_code")


# ---------------------------------------------------------------- HS 批量设置

HS_CHARS = set("0123456789.-")


def apply_hs_bulk(items: list[dict], only_empty: bool = True) -> dict:
    """按子系列（或整个系列）批量写 HS 编码。

    144 个 SKU 里同一个编码可能要填 90 次，逐行敲既慢又容易错一个字符——错一位就
    命中不到税率，到岸成本凭空少一截。所以按页面上已有的「子系列」这个维度批量写。

    ``only_empty=True``（默认）只补空白，不动已经人工改过的行：批量操作永远不该
    静默覆盖人工判断。想全量重刷就显式传 False。
    """
    if not isinstance(items, list):
        raise StoreError("invalid_arguments", "items 必须是数组")
    catalog_rows = load_catalog()
    plan: list[tuple[list[str], str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        sub = str(item.get("sub") or "").strip()
        series = str(item.get("series") or "").strip()
        hs = str(item.get("hs_code") or "").strip()
        if not sub and not series:
            continue
        bad = [ch for ch in hs if ch not in HS_CHARS]
        if bad:
            raise StoreError("invalid_hs_code", f"HS 编码只能含数字、点和短横线：{hs}")
        if len(hs) > 40:
            raise StoreError("invalid_hs_code", f"HS 编码过长：{hs}")
        if not hs and only_empty:
            continue                    # 空值 + 只填空白 = 什么都不做
        if sub:
            matched = [
                row["sku"] for row in catalog_rows
                if (row.get("sub_category") or "") == sub
            ]
            # 子系列写错（或清单里没有这个子系列）时退回整个系列，避免默默写 0 个
            if not matched and series:
                matched = [
                    row["sku"] for row in catalog_rows
                    if (row.get("series") or "") == series
                ]
        else:
            matched = [
                row["sku"] for row in catalog_rows
                if (row.get("series") or "") == series
            ]
        plan.append((matched, hs))

    touched = 0
    with transaction.atomic():
        for skus, hs in plan:
            for sku in skus:
                entry, _created = SkuCostEntry.objects.get_or_create(sku=sku)
                if only_empty and (entry.hs_code or "").strip():
                    continue
                if (entry.hs_code or "").strip() == hs:
                    continue
                entry.hs_code = hs
                if _is_blank(entry):
                    entry.delete()      # 清空后没有别的字段就删壳
                    continue
                entry.save(update_fields=["hs_code", "updated_at"])
                touched += 1
    return {"touched": touched}


# ---------------------------------------------------------------- 期间费用

MONTH_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def current_month() -> str:
    return timezone.localdate().strftime("%Y-%m")


def normalize_month(value) -> str:
    text = str(value or "").strip()
    if not text:
        return current_month()
    if not MONTH_PATTERN.match(text):
        raise StoreError("invalid_month", f"月份格式应为 YYYY-MM：{text}")
    return text


def _amount_text(value) -> str:
    """金额回填成 1200 而不是 1200.0——输入框里那个 .0 只是浮点数的尾巴，不是精度。"""
    if value is None:
        return ""
    return f"{float(value):.2f}".rstrip("0").rstrip(".")


def _period_dict(row: SkuPeriodCost | None, market_code: str, month: str) -> dict:
    data: dict = {"market": market_code, "month": month, "note": "", "updated_at": ""}
    for field in service.PERIOD_FIELDS:
        data[field] = None
    if row is not None:
        for field in service.PERIOD_FIELDS:
            value = getattr(row, field)
            # Decimal 必须转 float，否则 JsonResponse 会给出 "1200.00" 这种字符串
            data[field] = None if value is None else float(value)
        data["note"] = row.note or ""
        data["updated_at"] = short_time(row.updated_at)
    # 模板回填用的文本：数字给前端算，文本给页面写
    data["text"] = {field: _amount_text(data[field]) for field in service.PERIOD_FIELDS}
    return data


def load_period(market_code: str, month: str | None = None) -> dict:
    month = normalize_month(month)
    code = market.normalize_market(market_code)
    row = SkuPeriodCost.objects.filter(market=code, month=month).first()
    return _period_dict(row, code, month)


def list_period_months(market_code: str) -> list[str]:
    code = market.normalize_market(market_code)
    return list(
        SkuPeriodCost.objects.filter(market=code)
        .values_list("month", flat=True)
        .order_by("-month")
    )


def save_period(market_code: str, month: str, patch: dict) -> dict:
    """登记某市场某月的期间费用。四项全空且无备注就删行，不留空壳。"""
    if not isinstance(patch, dict):
        raise StoreError("invalid_arguments", "patch 必须是对象")
    unknown = set(patch) - set(service.PERIOD_FIELDS) - {"note"}
    if unknown:
        raise StoreError("invalid_arguments", f"不认识的字段：{'、'.join(sorted(unknown))}")
    code = market.normalize_market(market_code)
    month = normalize_month(month)
    with transaction.atomic():
        row, _created = SkuPeriodCost.objects.get_or_create(market=code, month=month)
        for field in service.PERIOD_FIELDS:
            if field not in patch:
                continue
            value = service.num(patch[field])
            if value is not None and value < 0:
                raise StoreError("invalid_amount", f"{service.PERIOD_LABELS[field]}不能是负数")
            setattr(row, field, service.to_decimal(value))
        if "note" in patch:
            row.note = str(patch["note"] or "").strip()[:200]
        blank = all(getattr(row, field) is None for field in service.PERIOD_FIELDS) and not row.note
        if blank:
            row.delete()
        else:
            row.save()
    return load_period(code, month)


def shop_fee_hint(settings: dict, fx_rate: float) -> float | None:
    """店铺月费的参考值：手填优先，其次渠道默认（美元按当前汇率折成人民币）。

    只作为输入框的占位提示，不参与任何计算——月租是实际付了多少才算数。
    """
    manual = fx.as_float(settings.get("fixed_fee"))
    if manual is not None:
        return manual
    channel = service.CHANNELS.get(settings.get("channel")) or service.CHANNELS[service.DEFAULT_CHANNEL]
    if channel.get("shop_fee_cny") is not None:
        return float(channel["shop_fee_cny"])
    usd = channel.get("shop_fee_usd")
    return None if usd is None else round(float(usd) * fx_rate, 2)


# ---------------------------------------------------------------- 汇率

def _fx_dict(row: SkuFxSnapshot) -> dict:
    rates = row.rates if isinstance(row.rates, dict) else {}
    previous = row.prev_rates if isinstance(row.prev_rates, dict) else {}
    return {
        "base": row.base or "USD",
        "rates": rates,
        "prev_rates": previous,
        "change": fx.with_change(rates, previous),
        "quotes": row.quotes if isinstance(row.quotes, list) else [],
        "sources": row.sources if isinstance(row.sources, dict) else {},
        "source": row.source or "",
        "source_count": row.source_count or 0,
        "divergent": row.divergent,
        "spread": fx.as_float(row.spread) or 0.0,
        "checked_at": short_time(row.checked_at),
    }


def load_fx() -> dict | None:
    row = SkuFxSnapshot.objects.filter(pk=1).first()
    return _fx_dict(row) if row else None


def save_fx(data: dict) -> dict:
    with transaction.atomic():
        row, _created = SkuFxSnapshot.objects.get_or_create(pk=1)
        row.prev_rates = row.rates if isinstance(row.rates, dict) else {}
        row.base = data.get("base") or "USD"
        row.rates = data.get("rates") or {}
        row.quotes = data.get("quotes") or []
        row.sources = data.get("sources") or {}
        row.source = data.get("source") or ""
        row.source_count = int(data.get("source_count") or 0)
        row.divergent = bool(data.get("divergent"))
        row.spread = service.to_decimal(data.get("spread")) or 0
        row.checked_at = timezone.now()
        row.save()
        return _fx_dict(row)


def current_fx(force: bool = False) -> dict:
    """取汇率快照：缓存未过期直接用，过期才联网；联网失败回退旧值并标 stale。"""
    cached = load_fx()
    if cached and not force and cached.get("checked_at"):
        row = SkuFxSnapshot.objects.filter(pk=1).first()
        age = (timezone.now() - row.checked_at).total_seconds() if row and row.checked_at else None
        if age is not None and age < fx.FX_TTL_SECONDS:
            return dict(cached, stale=False)
    try:
        return dict(save_fx(fx.fetch_rates()), stale=False)
    except Exception as exc:  # noqa: BLE001 — 汇率取不到不该让整个台账不可用
        if cached:
            return dict(cached, stale=True, error=str(exc)[:200])
        return {
            "base": "USD",
            "rates": fx.fallback_rates(),
            "prev_rates": {},
            "change": {},
            "quotes": [],
            "sources": {},
            "source": "内置兜底",
            "source_count": 0,
            "divergent": False,
            "spread": 0.0,
            "checked_at": "",
            "stale": True,
            "error": str(exc)[:200],
        }


# ---------------------------------------------------------------- 组装

def effective_rate(settings: dict, snapshot: dict | None) -> tuple[float, bool]:
    """返回 (生效汇率, 是否用缓存)。auto 用实时值，manual 用手填值。"""
    currency = settings["currency"]
    if settings["fx_mode"] == "auto" and snapshot:
        live = fx.as_float((snapshot.get("rates") or {}).get(currency))
        if live:
            return live, bool(snapshot.get("stale"))
    return fx.as_float(settings["fx"]) or fx.fallback_rate(currency), bool((snapshot or {}).get("stale"))


def advice_inputs(month: str | None = None) -> dict:
    """把「同一批 SKU 放到每个市场各算一遍」要的材料准备好。

    售价的币种是个绕不开的假设：台账里的售价按**当前结算币种**录入，换市场就
    对不上。真要让人把 7 个市场各填一遍价，这个功能永远不会有数据。所以这里
    按「同一件货在各市场卖等值价格」折算，把当前币种售价乘 (当前汇率 ÷ 目标汇率)
    换成目标市场币种，并在返回值里标明这是假设——它是「铺不铺这个市场」的判断依据，
    不是「这个市场该定多少钱」的答案。
    """
    settings = load_settings()
    month_code = normalize_month(month)
    costs = load_costs()
    catalog_rows = load_catalog()
    fx_snapshot = load_fx() or {}
    current_market = settings["market"]
    base_currency = settings["currency"]

    def rate_for(code: str) -> float:
        meta = market.MARKETS[code]
        mk_settings = dict(settings, market=code, currency=meta["currency"])
        live, _stale = effective_rate(mk_settings, fx_snapshot)
        return live

    base_rate = rate_for(current_market)
    markets_out = []
    for code in market.MARKET_ORDER:
        # 中国内地是本地市场：不涉及出口关税与跨境头程，放进「选品」比较里
        # 会永远以 0 关税拿第一，把真正的出口市场全压下去。
        if code in ADVICE_SKIP_MARKETS:
            continue
        meta = market.MARKETS[code]
        rate = rate_for(code)
        mk_settings = dict(settings, market=code, currency=meta["currency"])
        if code == current_market or not base_rate or not rate:
            market_costs = costs
        else:
            # 同一件货卖等值价：当前币种金额 × (当前市场汇率 ÷ 目标市场汇率)
            factor = base_rate / rate
            market_costs = {}
            for sku, entry in costs.items():
                clone = dict(entry)
                if clone.get("price") is not None:
                    clone["price"] = round(float(clone["price"]) * factor, 4)
                    clone["price_currency"] = meta["currency"]
                market_costs[sku] = clone
        rows = service.build_rows(catalog_rows, market_costs, mk_settings, rate, load_duty_map(code))
        markets_out.append({
            "code": code,
            "name": meta["name"],
            "currency": meta["currency"],
            "rate": rate,
            # 市场默认关税为 0 且税率表空着：这份「零关税」是模型假设，不是查过的税则
            "assumed_zero": market.default_duty(code) == 0 and not load_duty_map(code),
            "rows": rows,
        })
    return {
        "month": month_code,
        "current_market": current_market,
        "base_currency": base_currency,
        "skus": [
            {"sku": row["sku"], "name": row.get("name", ""), "active": row.get("active", True)}
            for row in catalog_rows
        ],
        "markets": markets_out,
    }


def snapshot(month: str | None = None) -> dict:
    """页面与接口共用的完整状态。views 与 api 都调它，避免两处各拼一份。"""
    settings = load_settings()
    costs = load_costs()
    fx_snapshot = load_fx() or {}
    market_code = settings["market"]
    live_rate, stale = effective_rate(settings, fx_snapshot)
    period_month = normalize_month(month)
    # 汇率就用当前牌价：按月的记账汇率已经下线——一个月里往往有好几笔订单、
    # 每笔汇率各不相同，锁一档月汇率反而会跟真实成交价对不上。
    rate = live_rate
    duty_map = load_duty_map(market_code)
    catalog_rows = load_catalog()
    rows = service.build_rows(catalog_rows, costs, settings, rate, duty_map)
    # 本市场实际用到的 HS 编码清单：关税弹窗按它列待填行，缺项提示也按它算
    groups = service.duty_groups(
        catalog_rows, costs, duty_map, market_code, preferred_map=load_preferred_map(market_code),
    )
    groups_missing = [group for group in groups if not group["configured"]]
    currency = settings["currency"]
    period = load_period(market_code, period_month)

    # 市场条要同时显示「哪个币种、什么牌价、税率配了没有」，把两份数据合起来给前端
    quote_by_currency = {
        item["code"]: item
        for item in fx.currency_table(fx_snapshot.get("rates"), fx_snapshot.get("change"), currency)
    }
    configured_markets = set(
        SkuDutyRate.objects.values_list("market", flat=True).distinct()
    )
    markets = []
    for item in market.market_table(market_code):
        quote = quote_by_currency.get(item["currency"]) or {}
        markets.append({
            **item,
            "rate": quote.get("rate"),
            "shown_text": quote.get("shown_text", ""),
            "unit_text": quote.get("unit_text", item["currency"]),
            "change_text": quote.get("change_text", ""),
            "dir": quote.get("dir", ""),
            "duty_configured": item["code"] in configured_markets or item["default_duty"] is not None,
        })

    return {
        "meta": catalog_meta(),
        "settings": dict(settings, fx=rate),
        "currency": currency,
        "market": market_code,
        "market_name": market.market_name(market_code),
        "price_label": service.price_label(currency),
        "markets": markets,
        "duties": list_duty_rates(market_code),
        "duty_groups": groups,
        "duty_missing": groups_missing,
        "duty_missing_text": "、".join(
            f"{group['hs_text']}（{group['sku_count']} 个 SKU）" for group in groups_missing
        ),
        # 只有「本市场用到的每个编码都能查到税率」才算配齐。以前是「表里有任意一行」
        # 就算配了，于是配了 5806 之后 6307 那些 SKU 一直待补，横幅却已经不提示了。
        "duty_ready": not groups_missing if groups
        else bool(duty_map) or market.default_duty(market_code) is not None,
        "currencies": list(quote_by_currency.values()),
        "channels": {key: value["name"] for key, value in service.CHANNELS.items()},
        "fx_meta": {
            "rate": rate,
            "shown": fx.display_rate(currency, rate),
            "currency": currency,
            "per": fx.CURRENCIES[currency]["per"],
            "label": service.price_label(currency),
            "mode": settings["fx_mode"],
            # 当前核算月份只用来切期间费用；汇率不再按月锁定
            "month": period_month,
            "live": fx.as_float((fx_snapshot.get("rates") or {}).get(currency)),
            "source": fx_snapshot.get("source") or "",
            "sources": (fx_snapshot.get("sources") or {}).get(currency) or [],
            "source_count": fx_snapshot.get("source_count") or 0,
            "checked_at": fx_snapshot.get("checked_at") or "",
            "divergent": bool(fx_snapshot.get("divergent")),
            "spread": fx_snapshot.get("spread"),
            "stale": stale,
            "change": (fx_snapshot.get("change") or {}).get(currency),
            "quotes": fx_snapshot.get("quotes") or [],
        },
        "summary": service.summary(rows),
        # 期间费用与 SKU 行分开给：商品毛利在 rows 里，经营净利要两者相加，
        # 前端各自渲染，不把期间费用摊回每行。
        "period": {
            "month": period_month,
            "months": list_period_months(market_code),
            "data": period,
            "summary": service.period_summary(rows, period),
            "shop_fee_hint": shop_fee_hint(settings, rate),
            "labels": service.PERIOD_LABELS,
        },
        "rows": rows,
    }
