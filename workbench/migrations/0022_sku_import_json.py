"""把 JSON 时代（backend/data/sku/*.json）的台账搬进数据库。

JSON 文件保留不删，作为只读备份；本迁移幂等——目标表已有数据就跳过对应 SKU，
重复执行不会覆盖后来在新版里填的成本。

注意旧版售价字段叫 price_usd、语义固定是美元，所以迁移时统一标
price_currency="USD"。若当时设置里选的不是美元，页面会把它们标成
「原售价 X USD 需按 Y 重填」，这正是想要的：宁可让人重填，也不静默算错。
"""
from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from django.conf import settings
from django.db import migrations
from django.utils import timezone

NUMERIC_FIELDS = (
    "duty", "price", "cost_cny", "freight_cny", "length", "width",
    "height", "weight_oz", "units", "commission", "acos",
)
TEXT_FIELDS = ("name", "series", "sub_category", "material", "size")


def _read(path: Path) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _decimal(value):
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value).replace(",", ""))
    except (InvalidOperation, ValueError):
        return None


def _aware(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.get_current_timezone())
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return timezone.make_aware(datetime.strptime(str(value), pattern))
        except ValueError:
            continue
    return None


def forwards(apps, schema_editor):
    SkuCatalogItem = apps.get_model("workbench", "SkuCatalogItem")
    SkuCatalogImport = apps.get_model("workbench", "SkuCatalogImport")
    SkuCostEntry = apps.get_model("workbench", "SkuCostEntry")
    SkuSetting = apps.get_model("workbench", "SkuSetting")
    SkuFxSnapshot = apps.get_model("workbench", "SkuFxSnapshot")

    base = Path(settings.BASE_DIR) / "data" / "sku"
    if not base.exists():
        return

    # ---- 商品清单 ----
    catalog = _read(base / "catalog.json")
    position = 0
    for raw in catalog.get("skus") or []:
        sku = str((raw or {}).get("sku") or "").strip()
        if not sku:
            continue
        position += 1
        if SkuCatalogItem.objects.filter(sku__iexact=sku).exists():
            continue
        SkuCatalogItem.objects.create(
            sku=sku,
            position=position,
            name=str(raw.get("name") or ""),
            series=str(raw.get("series") or ""),
            sub_category=str(raw.get("sub_category") or ""),
            material=str(raw.get("material") or ""),
            size=str(raw.get("size") or ""),
            url=str(raw.get("url") or ""),
            image=str(raw.get("image") or ""),
            active=bool(raw.get("active", True)),
            source=str(catalog.get("source") or "历史导入")[:64],
        )

    total = SkuCatalogItem.objects.count()
    history = list(catalog.get("imports") or [])
    for record in reversed(history):  # 文件里是最新在前，写入按时间正序
        record = record or {}
        entry = SkuCatalogImport.objects.create(
            source=str(record.get("source") or "历史导入")[:64],
            added=int(record.get("added") or 0),
            updated=int(record.get("updated") or 0),
            skipped=int(record.get("skipped") or 0),
            total=int(record.get("total") or total),
        )
        stamp = _aware(record.get("at"))
        if stamp:
            SkuCatalogImport.objects.filter(pk=entry.pk).update(created_at=stamp)

    # ---- 人工成本 ----
    ledger = _read(base / "ledger.json")
    for sku, fields in (ledger.get("rows") or {}).items():
        sku = str(sku or "").strip()
        fields = fields or {}
        if not sku or SkuCostEntry.objects.filter(sku=sku).exists():
            continue
        values = {field: _decimal(fields.get(field)) for field in NUMERIC_FIELDS}
        values["price"] = _decimal(fields.get("price_usd", fields.get("price")))
        price_currency = str(fields.get("price_currency") or fields.get("price_cur") or "").upper()
        values["price_currency"] = price_currency[:3] if values["price"] is not None else ""
        values["hs_code"] = str(fields.get("hs_code") or "")[:40]
        values["sku"] = sku
        SkuCostEntry.objects.create(**values)

    # ---- 口径设置 ----
    raw_settings = ledger.get("settings") or {}
    manual = raw_settings.get("fx_manual")
    manual = dict(manual) if isinstance(manual, dict) else {}
    legacy_fx = _decimal(raw_settings.get("fx"))
    if legacy_fx is not None and "USD" not in manual:
        manual["USD"] = float(legacy_fx)       # 旧版只有一个手填值，语义是美元
    SkuSetting.objects.update_or_create(
        pk=1,
        defaults={
            "currency": str(raw_settings.get("currency") or "USD")[:3].upper(),
            "channel": str(raw_settings.get("channel") or "domestic_wholesale")[:40],
            "fx_mode": "manual" if raw_settings.get("fx_mode") == "manual" else "auto",
            "fx_manual": {code: float(value) for code, value in manual.items() if _decimal(value) is not None},
            "rebate": _decimal(raw_settings.get("rebate")) or Decimal("0"),
            "fixed_fee": _decimal(raw_settings.get("fixed_fee")),
        },
    )

    # ---- 汇率缓存 ----
    fx_data = _read(base / "fx.json")
    rates = fx_data.get("rates")
    if not isinstance(rates, dict) or not rates:
        legacy_rate = _decimal(fx_data.get("rate"))
        rates = {"USD": float(legacy_rate)} if legacy_rate else {}
    if rates:
        SkuFxSnapshot.objects.update_or_create(
            pk=1,
            defaults={
                "base": str(fx_data.get("base") or "USD")[:3],
                "rates": rates,
                "prev_rates": fx_data.get("prev_rates") if isinstance(fx_data.get("prev_rates"), dict) else {},
                "quotes": fx_data.get("quotes") if isinstance(fx_data.get("quotes"), list) else [],
                "sources": fx_data.get("sources") if isinstance(fx_data.get("sources"), dict) else {},
                "source": str(fx_data.get("source") or "")[:64],
                "source_count": int(fx_data.get("source_count") or 0),
                "divergent": bool(fx_data.get("divergent")),
                "spread": _decimal(fx_data.get("spread")) or Decimal("0"),
                "checked_at": _aware(fx_data.get("checked_at")),
            },
        )


class Migration(migrations.Migration):

    dependencies = [
        ("workbench", "0021_sku_ledger"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
