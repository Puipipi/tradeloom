"""SKU 台账的 HTTP 入口。

契约与其它业务一致：
  * 成功 ``{"ok": true, ...}``；
  * 失败 ``{"ok": false, "error_code": "<机器码>"}``，HTTP 状态由码映射，
    **不把中文提示塞进 error 字段**——调用方（将来是官网后台）按码分支，
    文案留给前端翻译。
  * 请求体统一走 ``intake.api._json_object``，自带 content_type 校验、
    体积上限与重复键检测。
"""
from __future__ import annotations

import logging
from functools import wraps

from django.http import HttpRequest, HttpResponse, JsonResponse
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from workbench.intake.api import _json_object

from . import catalog, duty_lookup as duty_lookup_module, fx, market as market_module, service, store

logger = logging.getLogger(__name__)

ERROR_STATUS = {
    "invalid_json": 400,
    "duplicate_json_key": 400,
    "invalid_arguments": 400,
    "empty_content": 400,
    "no_sku_rows": 400,
    "unknown_currency": 400,
    "unknown_market": 400,
    "invalid_hs_prefix": 400,
    "invalid_hs_code": 400,
    "duplicate_hs_prefix": 400,
    "invalid_duty_rate": 400,
    "invalid_month": 400,
    "invalid_amount": 400,
    "item_not_found": 404,
    "fx_unavailable": 502,
    "duty_lookup_failed": 502,
    "duty_not_found": 404,
    "internal": 500,
}

SETTINGS_KEYS = {"market", "currency", "channel", "fx_mode", "rebate", "fixed_fee", "fx"}
CSV_BODY_LIMIT = 2 * 1024 * 1024


def _error(code: str, status: int | None = None) -> JsonResponse:
    return JsonResponse({"ok": False, "error_code": code}, status=status or ERROR_STATUS.get(code, 400))


def _guard(view):
    """把可预期异常翻成 error_code，意外异常记日志后返回 internal。"""
    @wraps(view)
    def wrapper(request: HttpRequest, *args, **kwargs):
        try:
            return view(request, *args, **kwargs)
        except store.StoreError as exc:
            return _error(exc.code, exc.status)
        except catalog.CatalogError:
            return _error("no_sku_rows")
        except ValueError as exc:
            code = str(exc) if str(exc) in ERROR_STATUS else "invalid_arguments"
            return _error(code)
        except Exception:  # noqa: BLE001 — 兜底，避免 500 页面穿透到接口
            logger.exception("SKU 台账接口异常")
            return _error("internal", 500)
    return wrapper


def _state(month: str | None = None) -> dict:
    """整份状态。``month`` 是当前正在看的期间费用月份——不传就按当月。

    每个写接口都把它带回去，否则用户在翻上个月的账时保存一格 SKU，
    期间费用面板会突然跳回本月，看着像数据丢了。
    """
    return dict(store.snapshot(month), ok=True)


def _body(request: HttpRequest, limit: int = 65536) -> dict:
    return _json_object(request, max_bytes=limit)


# ---------------------------------------------------------------- 读

@require_GET
@_guard
def library(request: HttpRequest) -> JsonResponse:
    return JsonResponse(_state(request.GET.get("month")))


@require_GET
@_guard
def catalog_template(request: HttpRequest) -> HttpResponse:
    return HttpResponse(
        catalog.template_csv(),
        content_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="sku-catalog-template.csv"'},
    )


def _filter_rows(rows: list[dict], params) -> list[dict]:
    """按页面上的筛选条件过滤行——口径必须和前端 ``applyFilter`` 一模一样。

    两边各写一套筛选最容易出现「筛了 12 行，导出 144 行」这种看着像 bug 的事，
    所以这里逐条对应：关键字比 SKU + 商品名称，系列比「子系列优先」的显示值，
    状态只有三档（可算 / 待补 / 亏损）。
    """
    keyword = str(params.get("q") or "").strip().lower()
    series = str(params.get("series") or "").strip()
    state = str(params.get("state") or "").strip()
    picked = []
    for row in rows:
        if keyword:
            haystack = f"{row.get('sku', '')} {row.get('name', '')}".lower()
            if keyword not in haystack:
                continue
        if series and (row.get("sub") or row.get("series") or "").strip() != series:
            continue
        if state == "ok" and row.get("status") != "可算":
            continue
        if state == "pend" and row.get("status") != "待补":
            continue
        if state == "loss" and not row.get("is_loss"):
            continue
        picked.append(row)
    return picked


@require_GET
@_guard
def export_csv(request: HttpRequest) -> HttpResponse:
    """导出当前视图：带上筛选、市场与月份，导出的就是屏幕上那批行。

    以前固定导全量，用户筛了「仅亏损」结果拿到 144 行，还得在 Excel 里再筛一遍。
    """
    state = store.snapshot(request.GET.get("month"))
    rows = _filter_rows(state["rows"], request.GET)
    payload = service.export_csv_bytes(rows, state["currency"])
    response = HttpResponse(payload, content_type="text/csv; charset=utf-8")
    # 文件名不带月份：汇率改成只用当前牌价后，导出的内容与月份无关，
    # 再缀一个 "-2026-11" 会让人以为拿到的是那个月的快照。
    response["Content-Disposition"] = 'attachment; filename="sku-cost-ledger.csv"'
    return response


# ---------------------------------------------------------------- 写

@require_POST
@_guard
def rows_update(request: HttpRequest) -> JsonResponse:
    body = _body(request)
    patch = body.get("patch")
    if not isinstance(patch, dict):
        return _error("invalid_arguments")
    store.update_costs(patch, store.load_settings()["currency"])
    return JsonResponse(_state(body.get("month")))


@require_GET
@_guard
def advice(request: HttpRequest) -> JsonResponse:
    """选品建议：把同一批 SKU 放到每个出口市场各算一遍（中国内地不参与），只输出「该做什么」。

    不做的两件事，免得看起来像自动决策：
      1. 不猜未配税率的市场——那会把「没查」算成「零关税」，得出假的高毛利；
      2. 不给「建议下架」——下不下架取决于库存和供应链，不属于成本台账的判断。
    """
    month = store.normalize_month(request.GET.get("month"))
    return JsonResponse({"ok": True, "advice": service.advice(store.advice_inputs(month))})


@require_POST
@_guard
def settings_update(request: HttpRequest) -> JsonResponse:
    body = _body(request)
    patch = body.get("settings")
    if not isinstance(patch, dict) or set(patch) - SETTINGS_KEYS:
        return _error("invalid_arguments")
    store.save_settings(patch)
    return JsonResponse(_state(body.get("month")))


@require_POST
@_guard
def catalog_import(request: HttpRequest) -> JsonResponse:
    body = _body(request, CSV_BODY_LIMIT)
    text = body.get("csv")
    if not isinstance(text, str) or not text.strip():
        return _error("empty_content")
    records, skipped = catalog.parse_csv(text)
    result = store.import_catalog(records, source="CSV 导入")
    if skipped:
        result["skipped"] = result.get("skipped", 0) + skipped
    return JsonResponse({"ok": True, "result": result, "state": _state(body.get("month"))})


@require_POST
@_guard
def catalog_push(request: HttpRequest) -> JsonResponse:
    """官网后台直连入口：POST {"items": [{sku, name, series, sub_category, size, material, active}]}。"""
    body = _body(request, CSV_BODY_LIMIT)
    items = body.get("items")
    if not isinstance(items, list) or not items:
        return _error("invalid_arguments")
    result = store.import_catalog(items, source="官网后台")
    return JsonResponse({"ok": True, "result": result, "state": _state(body.get("month"))})


@require_POST
@_guard
def import_csv(request: HttpRequest) -> JsonResponse:
    body = _body(request, CSV_BODY_LIMIT)
    text = body.get("csv")
    if not isinstance(text, str) or not text.strip():
        return _error("empty_content")
    known = {row["sku"] for row in store.load_catalog()}
    parsed = service.parse_cost_csv(text, known)
    if parsed["patch"]:
        store.update_costs(parsed["patch"], store.load_settings()["currency"])
    return JsonResponse({
        "ok": True,
        "result": {
            "matched": len(parsed["patch"]),
            "empty_rows": parsed["empty_rows"],
            "unknown_count": len(parsed["unknown"]),
            "unknown_sku": parsed["unknown"][:20],
        },
        "state": _state(body.get("month")),
    })


@require_http_methods(["GET", "POST"])
@_guard
def fx_rates(request: HttpRequest) -> JsonResponse:
    force = request.method == "POST"
    month = None
    if request.method == "POST":
        month = _body(request).get("month")
    else:
        month = request.GET.get("month")
        if request.GET.get("force") in ("1", "true"):
            force = True
    try:
        data = store.current_fx(force=force)
    except Exception:  # noqa: BLE001 — current_fx 已兜底，这里只兜极端情况
        logger.exception("汇率取用失败")
        return _error("fx_unavailable")
    return JsonResponse({"ok": True, "fx": data, "state": _state(month)})


def _duty_payload(month: str | None) -> dict:
    """弹窗要的三样：本市场已配的规则行、本市场在用的 HS 分组、整份状态。

    分组是「不同商品不同关税」的关键：没有它，用户面对空白表格得自己回忆有哪几个
    编码；有了它，未配的编码会带着「覆盖多少 SKU」排在最前面，照着填就行。
    """
    state = _state(month)
    return {
        "ok": True,
        "market": state["market"],
        "market_name": state["market_name"],
        "rows": state["duties"],
        "groups": state["duty_groups"],
        "duty_missing_text": state["duty_missing_text"],
        "state": state,
    }


@require_http_methods(["GET", "POST"])
@_guard
def duty_rates(request: HttpRequest) -> JsonResponse:
    """关税税率表。GET 读当前市场；POST 用 ``{"market": "US", "rows": [...]}`` 整表覆盖。

    rows 每项 ``{hs_prefix, base_rate, extra_rate, note}``，税率可写 ``0.125`` 或 ``"12.5%"``。
    整表覆盖而非逐行增删：表短，整体替换比算差集可靠，也不会留半套规则。
    """
    if request.method == "GET":
        return JsonResponse(_duty_payload(request.GET.get("month")))
    body = _body(request)
    rows = body.get("rows")
    if rows is None:
        # 前端统一用 POST 发请求，没带 rows 就当成「读一下当前市场」
        return JsonResponse(_duty_payload(body.get("month")))
    if not isinstance(rows, list):
        return _error("invalid_arguments")
    market_code = body.get("market") or store.load_settings()["market"]
    store.replace_duty_rates(market_code, rows)
    return JsonResponse({"ok": True, "state": _state(body.get("month"))})


@require_http_methods(["GET", "POST"])
@_guard
def duty_lookup(request: HttpRequest) -> JsonResponse:
    """按 HS 编码向官方税则查现行税率（GET ``?hs=&market=``，POST ``{"hs","market"}``）。

    返回**基础 + 附加**两类候选，靠每条候选的 ``slot``（``base`` / ``extra``）区分，
    前端据此分别填「基础%」「附加%」。欧盟、英国能按编码精确取到反倾销/反补贴；
    美国的 301 与对华加征只能给「现行条款 + 费率」清单，落哪份清单要人核对。
    优惠税率（凭原产地证）一律不代填。查不到就留空——空着表示「没查」，
    填 0 表示「确认零关税」，两者不能混。
    不支持自动查的市场（日本/澳洲/香港等）返回 ``supported=false`` 与官网链接，
    前端据此给一个「去官网查」的出口，而不是报错。
    """
    if request.method == "GET":
        hs = request.GET.get("hs")
        market = request.GET.get("market")
    else:
        body = _body(request)
        hs = body.get("hs")
        market = body.get("market")
    raw_market = str(market or "").strip().upper()
    if raw_market and not market_module.is_market(raw_market):
        return _error("unknown_market")
    market_code = market_module.normalize_market(raw_market or store.load_settings()["market"])
    try:
        payload = duty_lookup_module.lookup(hs, market_code)
    except duty_lookup_module.DutyLookupError as exc:
        if exc.code == "duty_not_found":
            return JsonResponse({"ok": False, "error_code": "duty_not_found"}, status=404)
        if exc.code == "invalid_hs_code":
            return _error("invalid_hs_code")
        logger.warning("关税查询失败：%s %s", exc.code, exc.detail)
        return JsonResponse(
            {"ok": False, "error_code": "duty_lookup_failed", "detail": exc.detail[:160]},
            status=502,
        )
    # 基础与附加各自留量：美国一个 6 位码能查出十几档基础，一刀切 [:12]
    # 会把附加候选挤掉，而附加恰恰是要补的东西。
    all_rows = payload["candidates"]
    bases = [item for item in all_rows if item.get("slot") != "extra"][:8]
    extras = [item for item in all_rows if item.get("slot") == "extra"][:6]
    return JsonResponse({
        "ok": True,
        "market": market_code,
        "market_name": market_module.MARKETS.get(market_code, {}).get("name", market_code),
        "hs": payload["hs"],
        "supported": payload["supported"],
        "source": payload["source"],
        "source_url": payload["source_url"],
        "fetched_at": payload["fetched_at"],
        "cached": payload.get("cached", False),
        "candidates": bases + extras,
        "warnings": payload["warnings"],
    })


@require_POST
@_guard
def hs_bulk(request: HttpRequest) -> JsonResponse:
    """按子系列（或整个系列）批量写 HS 编码。

    body: ``{"items": [{"sub": "Velvet Ribbon", "series": "", "hs_code": "5806.32"}],
    "only_empty": true}``。默认只补空白的，不覆盖人工改过的行。
    """
    body = _body(request)
    items = body.get("items")
    if not isinstance(items, list):
        return _error("invalid_arguments")
    only_empty = body.get("only_empty", True)
    result = store.apply_hs_bulk(items, only_empty is not False)
    return JsonResponse({"ok": True, "touched": result["touched"], "state": _state(body.get("month"))})


@require_http_methods(["GET", "POST"])
@_guard
def period_cost(request: HttpRequest) -> JsonResponse:
    """期间费用（广告/退货/店铺月费/其他）的登记入口。

    GET 读当前市场当月；POST ``{"month": "2026-11", "patch": {...}}`` 写。
    带 month 但不带 patch 的 POST 是「切到那个月」——前端统一用 POST，
    不必为同一份数据维护两套请求方式。

    这些费用**不进 SKU 行**：它们逐单逐月都不同，摊进单件成本只会得到一个
    解释不了的均值。这里只登记实际发生额，和商品毛利在汇总层相加。
    """
    settings = store.load_settings()
    if request.method == "GET":
        month = store.normalize_month(request.GET.get("month"))
        return JsonResponse({"ok": True, "state": store.snapshot(month)})

    body = _body(request)
    month = store.normalize_month(body.get("month"))
    patch = body.get("patch")
    if patch is None:
        # 只切月份，不动数据
        return JsonResponse({"ok": True, "state": store.snapshot(month)})
    if not isinstance(patch, dict):
        return _error("invalid_arguments")
    store.save_period(settings["market"], month, patch)
    return JsonResponse({"ok": True, "state": store.snapshot(month)})


__all__ = [
    "library", "catalog_template", "export_csv", "rows_update", "settings_update",
    "catalog_import", "catalog_push", "import_csv", "fx_rates", "duty_rates",
    "duty_lookup", "hs_bulk", "period_cost", "advice", "ERROR_STATUS",
]
