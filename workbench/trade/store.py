"""Comtrade 快照的存取与同步编排。

同步是**分批**的：一次 HTTP 请求只跑 ``max_calls`` 个「编码 × 年份」，把游标交回
前端再续。原因很实在——14 个 HS6 × 3 年就是 42 次上游请求、按 1 次/秒节流要
四十多秒，塞进一个请求里必然被网关掐断，前端还看不到进度。

写库用 upsert 而不是先删后插：中途失败时旧数据还在，页面不会突然变成空白。
"""
from __future__ import annotations

import logging

from django.db import transaction
from django.utils import timezone

from workbench.models import SkuTradeRun, SkuTradeSetting, SkuTradeSnapshot

from . import client, service

logger = logging.getLogger(__name__)

SYNC_BATCH = 6          # 单次 HTTP 内最多发几个上游请求
MAX_BATCH = 20          # 前端一次最多要多少，防手改参数把请求拖死
EXPORT_MARKETS = ("US", "EU", "GB", "JP", "AU", "HK")


def load_settings() -> dict:
    row, _created = SkuTradeSetting.objects.get_or_create(pk=1)
    return {"api_key": row.api_key or "", "lookback_years": row.lookback_years or 3}


def save_settings(patch: dict) -> dict:
    row, _created = SkuTradeSetting.objects.get_or_create(pk=1)
    if "api_key" in patch:
        row.api_key = str(patch.get("api_key") or "").strip()[:120]
    if "lookback_years" in patch:
        try:
            value = int(patch.get("lookback_years"))
        except (TypeError, ValueError):
            value = 3
        row.lookback_years = max(1, min(value, 10))
    row.save()
    return load_settings()


def save_records(rows: list[dict]) -> int:
    """写入观测行。同一 (编码, 报告国, 伙伴国, 流向, 年份) 覆盖旧值。"""
    if not rows:
        return 0
    now = timezone.now()
    objects = [
        SkuTradeSnapshot(
            hs6=row["hs6"],
            reporter_code=row["reporter_code"],
            reporter_name=row.get("reporter_name", ""),
            partner_code=row["partner_code"],
            partner_name=row.get("partner_name", ""),
            flow=row.get("flow", "M"),
            period=row["period"],
            primary_value=row.get("primary_value") or 0,
            net_wgt=row.get("net_wgt"),
            qty=row.get("qty"),
            qty_unit=row.get("qty_unit", ""),
            source=row.get("source", "UN Comtrade"),
            fetched_at=now,
        )
        for row in rows
    ]
    with transaction.atomic():
        SkuTradeSnapshot.objects.bulk_create(
            objects,
            update_conflicts=True,
            unique_fields=["hs6", "reporter_code", "partner_code", "flow", "period"],
            update_fields=[
                "reporter_name", "partner_name", "primary_value",
                "net_wgt", "qty", "qty_unit", "source", "fetched_at",
            ],
        )
    return len(objects)


def load_records(hs6_list: list[str] | None = None) -> list[dict]:
    """按编码取观测行。不传就全取——数据量是「编码 × 国家 × 年份」，很小。"""
    queryset = SkuTradeSnapshot.objects.all()
    if hs6_list:
        queryset = queryset.filter(hs6__in=list(hs6_list))
    return list(
        queryset.values(
            "hs6", "reporter_code", "partner_code", "flow", "period",
            "primary_value", "net_wgt", "qty", "qty_unit",
        )
    )


def plan(hs6_list: list[str], years: list[int]) -> list[tuple[str, int]]:
    return [(hs6, year) for hs6 in hs6_list for year in years]


def sync(
    *,
    hs6_list: list[str],
    years: list[int],
    offset: int = 0,
    max_calls: int = SYNC_BATCH,
) -> dict:
    """跑一批。返回游标与进度，前端按 ``done`` 决定是否继续。"""
    settings = load_settings()
    api_key = settings["api_key"]
    allowed: set[int] = set()
    for code in EXPORT_MARKETS:
        allowed.update(client.market_reporters(code))
    all_reporters = tuple(sorted(allowed))

    steps = plan(hs6_list, years)
    total = len(steps)
    offset = max(0, min(int(offset or 0), total))
    limit = max(1, min(int(max_calls or SYNC_BATCH), MAX_BATCH))
    batch = steps[offset: offset + limit]

    fetched = 0
    observations = 0
    failed: list[dict] = []
    empty: list[dict] = []
    for hs6, year in batch:
        try:
            rows = client.fetch(hs6, year, all_reporters, api_key=api_key)
        except client.TradeError as exc:
            logger.warning("Comtrade 取数失败 %s %s：%s", hs6, year, exc.code)
            failed.append({"hs6": hs6, "year": year, "code": exc.code})
            continue
        # 上游可能返回我们没问的报告国（比如 TOTAL 行），只留台账关心的
        rows = [row for row in rows if row["reporter_code"] in allowed]
        if not rows:
            empty.append({"hs6": hs6, "year": year})
            continue
        observations += save_records(rows)
        fetched += 1

    next_offset = offset + len(batch)
    done = next_offset >= total
    if failed or empty:
        SkuTradeRun.objects.create(
            mode="subscription" if api_key else "preview",
            years=",".join(str(year) for year in years),
            requested=len(batch),
            fetched=fetched,
            observations=observations,
            failed=failed,
            note=("; ".join(f"{item['hs6']}/{item['year']} 无数据" for item in empty))[:300],
        )
    elif done and fetched:
        SkuTradeRun.objects.create(
            mode="subscription" if api_key else "preview",
            years=",".join(str(year) for year in years),
            requested=len(batch),
            fetched=fetched,
            observations=observations,
        )
    return {
        "mode": "subscription" if api_key else "preview",
        "total": total,
        "offset": offset,
        "next_offset": next_offset,
        "done": done,
        "fetched": fetched,
        "observations": observations,
        "failed": failed,
        "empty": empty,
    }


def recent_runs(limit: int = 5) -> list[dict]:
    rows = SkuTradeRun.objects.all()[:limit]
    return [
        {
            "mode": row.mode,
            "years": row.years,
            "requested": row.requested,
            "fetched": row.fetched,
            "observations": row.observations,
            "failed": row.failed or [],
            "note": row.note,
            "created_at": row.created_at.strftime("%Y-%m-%d %H:%M") if row.created_at else "",
        }
        for row in rows
    ]


def clear(hs6: str | None = None) -> int:
    """清缓存。传编码只清那一个——重拉前想剔除错口径时用。"""
    queryset = SkuTradeSnapshot.objects.all()
    if hs6:
        queryset = queryset.filter(hs6=hs6)
    deleted, _detail = queryset.delete()
    return deleted


def state(hs6_entries: list[dict], invalid: list[dict]) -> dict:
    """Comtrade 面板与选品建议共用的整份状态。"""
    settings = load_settings()
    codes = [entry["hs6"] for entry in hs6_entries]
    records = load_records(codes) if codes else []
    matrix_rows = service.matrix(records, codes)
    coverage = service.coverage(hs6_entries, matrix_rows)
    by_hs6 = {entry["hs6"]: entry for entry in hs6_entries}
    for row in matrix_rows:
        entry = by_hs6.get(row["hs6"]) or {}
        row["sku_count"] = entry.get("sku_count", 0)
        row["series"] = entry.get("series", [])
        # source / duty_markets 要带出来：编码来自关税表时页面要标一下，
        # 否则「覆盖 0 个 SKU」看着像数据错，其实是台账还没填 HS
        row["source"] = entry.get("source", "ledger")
        row["duty_markets"] = entry.get("duty_markets", [])
    return {
        "settings": {"has_key": bool(settings["api_key"]), "lookback_years": settings["lookback_years"]},
        "years": client.default_years(settings["lookback_years"]),
        "hs6": hs6_entries,
        "invalid": invalid,
        "matrix": matrix_rows,
        "coverage": coverage,
        "runs": recent_runs(),
        "markets": [
            {
                "code": code,
                # 短名给表头（「欧盟」），长名给 tooltip——把「德法意西荷」
                # 塞进表头会把整列撑到两倍宽，而这张表有六列
                "name": code if code == "EU" else client.market_label(code),
                "full_name": client.market_label(code),
                "reporters": len(client.market_reporters(code)),
            }
            for code in EXPORT_MARKETS
        ],
        "row_count": SkuTradeSnapshot.objects.count(),
        "synced_at": (
            SkuTradeSnapshot.objects.order_by("-fetched_at")
            .values_list("fetched_at", flat=True).first()
        ),
    }


__all__ = [
    "SYNC_BATCH",
    "EXPORT_MARKETS",
    "load_settings",
    "save_settings",
    "save_records",
    "load_records",
    "sync",
    "recent_runs",
    "clear",
    "state",
]
