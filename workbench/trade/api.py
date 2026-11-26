"""UN Comtrade 面板与选品建议的 HTTP 入口。

契约沿用 SKU 台账那一套：成功 ``{"ok": true, ...}``，失败
``{"ok": false, "error_code": "<机器码>"}``，中文提示留给前端翻译。
"""
from __future__ import annotations

import logging
from functools import wraps

from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET, require_POST

from workbench.intake.api import _json_object
from workbench.sku import store as sku_store

from . import advice as advice_module, client, service, store

logger = logging.getLogger(__name__)

ERROR_STATUS = {
    "invalid_json": 400,
    "duplicate_json_key": 400,
    "invalid_arguments": 400,
    "no_hs6": 400,
    "trade_bad_request": 400,
    "trade_unavailable": 502,
    "trade_rate_limited": 429,
    "trade_key_rejected": 403,
    "internal": 500,
}

SETTING_KEYS = {"api_key", "lookback_years"}


def _error(code: str, status: int | None = None) -> JsonResponse:
    return JsonResponse({"ok": False, "error_code": code}, status=status or ERROR_STATUS.get(code, 400))


def _guard(view):
    @wraps(view)
    def wrapper(request: HttpRequest, *args, **kwargs):
        try:
            return view(request, *args, **kwargs)
        except client.TradeError as exc:
            logger.warning("Comtrade 接口失败：%s %s", exc.code, exc.detail)
            return _error(exc.code)
        except ValueError as exc:
            code = str(exc) if str(exc) in ERROR_STATUS else "invalid_arguments"
            return _error(code)
        except Exception:  # noqa: BLE001 — 兜底，别让 500 页面穿透到接口
            logger.exception("Comtrade 接口异常")
            return _error("internal", 500)
    return wrapper


def _hs6_entries() -> tuple[list[dict], list[dict]]:
    return service.ledger_hs6()


def _matrix(codes: list[str]) -> tuple[list[dict], dict]:
    records = store.load_records(codes) if codes else []
    rows = service.matrix(records, codes)
    demand = {row["hs6"]: row["markets"] for row in rows}
    return rows, demand


# ---------------------------------------------------------------- 面板

@require_GET
@_guard
def state(request: HttpRequest) -> JsonResponse:
    entries, invalid = _hs6_entries()
    payload = store.state(entries, invalid)
    payload["ok"] = True
    return JsonResponse(payload)


@require_POST
@_guard
def sync(request: HttpRequest) -> JsonResponse:
    """分批拉取。前端按返回的 ``done`` 决定是否带着 ``offset`` 再来一次。

    为什么不在服务端一次拉完：42 次上游请求、1 次/秒节流就是 40 秒以上，
    同步视图必然超时，中间也没有任何进度可显示。
    """
    body = _json_object(request, max_bytes=8192)
    offset = body.get("offset") or 0
    max_calls = body.get("max_calls") or store.SYNC_BATCH
    entries, _invalid = _hs6_entries()
    if not entries:
        return _error("no_hs6")
    settings = store.load_settings()
    years = client.default_years(settings["lookback_years"])
    result = store.sync(
        hs6_list=[entry["hs6"] for entry in entries],
        years=years,
        offset=offset,
        max_calls=max_calls,
    )
    result["ok"] = True
    result["years"] = years
    return JsonResponse(result)


@require_POST
@_guard
def settings_update(request: HttpRequest) -> JsonResponse:
    body = _json_object(request, max_bytes=8192)
    patch = body.get("settings")
    if not isinstance(patch, dict) or set(patch) - SETTING_KEYS:
        return _error("invalid_arguments")
    store.save_settings(patch)
    entries, invalid = _hs6_entries()
    payload = store.state(entries, invalid)
    payload["ok"] = True
    return JsonResponse(payload)


@require_POST
@_guard
def clear(request: HttpRequest) -> JsonResponse:
    body = _json_object(request, max_bytes=4096)
    hs6 = str(body.get("hs6") or "").strip() or None
    removed = store.clear(hs6)
    return JsonResponse({"ok": True, "removed": removed})


# ---------------------------------------------------------------- 选品建议

@require_GET
@_guard
def advice(request: HttpRequest) -> JsonResponse:
    """选品建议 = 成本侧（各市场毛利）× 需求侧（HS6 各国进口额）。

    没有贸易数据时退化成原来的成本侧结论，不因为缺数据把市场判成「没量」。
    """
    month = sku_store.normalize_month(request.GET.get("month"))
    inputs = sku_store.advice_inputs(month)
    entries, _invalid = _hs6_entries()
    codes = [entry["hs6"] for entry in entries]
    matrix_rows, demand = _matrix(codes)
    hs6_by_sku = {sku: entry["hs6"] for entry in entries for sku in entry["skus"]}
    payload = advice_module.build_advice(inputs, demand, hs6_by_sku, codes)
    payload["coverage"] = service.coverage(entries, matrix_rows)
    return JsonResponse({"ok": True, "advice": payload})


__all__ = ["state", "sync", "settings_update", "clear", "advice", "ERROR_STATUS"]
