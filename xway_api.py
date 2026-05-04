#!/usr/bin/env python3
import copy
import csv
import io
import json
import math
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path
from time import monotonic
from threading import RLock, Thread
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

import requests


DEFAULT_STORAGE_STATE = Path(__file__).with_name("xway_storage_state.json")
PRODUCT_DAILY_STATS_CHUNK_DAYS = 30
WEEKDAYS: Tuple[Tuple[str, str], ...] = (
    ("Monday", "Пн"),
    ("Tuesday", "Вт"),
    ("Wednesday", "Ср"),
    ("Thursday", "Чт"),
    ("Friday", "Пт"),
    ("Saturday", "Сб"),
    ("Sunday", "Вс"),
)
SCHEDULE_DAY_ORDER = {day: index for index, (day, _) in enumerate(WEEKDAYS)}
DATE_FMT = "%Y-%m-%d"
BID_HISTORY_FMT = "%d-%m-%Y %H:%M:%S"
DEFAULT_RANGE_DAYS = 7
STATUS_MP_HISTORY_PAGE_LIMIT = 120
STATUS_MP_HISTORY_MAX_PAGES = 50
STATUS_PAUSE_HISTORY_INITIAL_LIMIT = 120
STATUS_PAUSE_HISTORY_MAX_LIMIT = 5000
STATUS_MP_HISTORY_CREATION_MAX_PAGES = 200
STATUS_PAUSE_HISTORY_CREATION_MAX_LIMIT = 20000
CATALOG_CACHE_TTL_SECONDS = 180
CATALOG_CACHE_MAX_ENTRIES = 10
_CATALOG_CACHE: Dict[Tuple[str, str, str, str], Tuple[float, Dict[str, Any]]] = {}
PRODUCTS_CACHE_TTL_SECONDS = 180
PRODUCTS_CACHE_MAX_ENTRIES = 40
_PRODUCTS_CACHE: Dict[
    Tuple[str, str, str, str, Tuple[str, ...], Tuple[str, ...]],
    Tuple[float, Dict[str, Any]],
] = {}
ARTICLE_SHEET_SOURCE_URL = "https://docs.google.com/spreadsheets/d/1c_SiDJRHFsV5_3Hd0oHuTsR1uLHiI5UfxEu1-HeXNLU/edit?usp=sharing"
ARTICLE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1c_SiDJRHFsV5_3Hd0oHuTsR1uLHiI5UfxEu1-HeXNLU/gviz/tq?tqx=out:csv&sheet=Tab"
ARTICLE_SHEET_NAME = "Tab"
ARTICLE_SHEET_CACHE_TTL_SECONDS = 300
ARTICLE_SHEET_CACHE_STALE_SECONDS = 21600
ARTICLE_SHEET_FETCH_TIMEOUT_SECONDS = 6
ARTICLE_SHEET_ERROR_TTL_SECONDS = 60
_ARTICLE_SHEET_CACHE: Dict[str, Tuple[float, Dict[str, List[Dict[str, Any]]]]] = {}
_ARTICLE_SHEET_ERROR_CACHE: Dict[str, Tuple[float, str]] = {}
_ARTICLE_SHEET_REFRESH_IN_FLIGHT: Set[str] = set()
SHOP_LISTING_CACHE_TTL_SECONDS = 120
SHOP_LISTING_CACHE_MAX_ENTRIES = 50
_SHOP_LISTING_CACHE: Dict[Tuple[str, str, str, int], Tuple[float, Dict[str, Any]]] = {}
SHOP_LIST_CACHE_TTL_SECONDS = 120
SHOP_LIST_CACHE_MAX_ENTRIES = 10
_SHOP_LIST_CACHE: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
_CACHE_LOCK = RLock()
DAILY_SUM_FIELDS: Tuple[str, ...] = (
    "ordered_total",
    "ordered_sum_total",
    "rel_sum_price",
    "rel_shks",
    "rel_atbs",
    "views",
    "clicks",
    "expense_sum",
    "atbs",
    "orders",
    "sum_price",
)
CATALOG_CAMPAIGN_FIELD_ORDER: Tuple[str, ...] = (
    "unified",
    "manual_search",
    "manual_recom",
    "cpc",
)
CATALOG_CAMPAIGN_FIELD_META: Dict[str, Dict[str, str]] = {
    "unified": {"label": "Единая ставка", "short_label": "Ед. CPM"},
    "manual_search": {"label": "Поиск", "short_label": "CPM Поиск"},
    "manual_recom": {"label": "Рекомендации", "short_label": "CPM Реком"},
    "cpc": {"label": "Оплата за клики", "short_label": "CPC"},
}
CATALOG_CHART_CAMPAIGN_TYPE_META: Dict[str, Dict[str, Any]] = {
    "cpm-manual": {"label": "CPM · Ручная", "color": "#2ea36f", "order": 1},
    "cpm-unified": {"label": "CPM · Единая", "color": "#4b7bff", "order": 2},
    "cpc": {"label": "CPC", "color": "#8b64f6", "order": 3},
}
SHOP_DETAIL_SAFE_FIELDS: Tuple[str, ...] = (
    "id",
    "name",
    "marketplace",
    "tariff_code",
    "products_count",
    "created",
    "expired",
    "expired_days",
    "expire_date",
    "expire_in",
    "only_api",
    "recurrent_shop",
    "new_flow",
    "jam_status",
    "has_limit",
    "limit_q",
    "fact_q",
    "requests_num",
    "balance",
    "bonus",
    "cashback",
    "use_cashback",
    "account",
    "selected_contract",
    "selected_contract_secondary",
    "contracts",
    "tariffs",
    "top_up_balance_type",
    "top_up_balance_type_code",
    "top_up_balance_type_secondary",
    "top_up_balance_type_secondary_code",
)
SHOP_PRODUCT_SAFE_FIELDS: Tuple[str, ...] = (
    "id",
    "external_id",
    "name",
    "name_custom",
    "brand",
    "vendor_code",
    "category_keyword",
    "subject_id",
    "group",
    "disp_version",
    "progress_bar",
    "dispatcher_enabled",
    "dispatcher_errors",
    "enabled",
    "is_active",
    "ab_test_active",
    "ab_tests",
    "seo_sets",
    "tags",
    "main_image_url",
    "spend_limits",
    "stocks_rule",
    "campaigns_data",
)
SHOP_STAT_SAFE_FIELDS: Tuple[str, ...] = (
    "id",
    "budget",
    "day_budget",
    "campaigns_count",
    "stock",
    "ordered_report",
    "ordered_sum_report",
    "ordered_dynamics_report",
    "dynamics",
    "spend",
    "stat",
    "spend_limits",
    "dispatcher_enabled",
)
ARTICLE_SHEET_FIELD_MAP: Dict[str, str] = {
    "Дата": "day",
    "CRM_ID": "crm_id",
    "Название товара по CRM": "crm_name",
    "МП": "marketplace",
    "Артикул": "article",
    "Ссылка на товар": "product_url",
    "На день Факт Цена (до СПП)": "price_before_spp",
    "На день Факт Цена (после СПП)": "price_after_spp",
    "На день Факт СПП": "spp",
    "На день Факт Остаток товара FBO": "stock_fbo",
    "На день Факт Оборачиваемость товара FBO": "turnover_fbo",
    "На день Факт Остаток товара FBS": "stock_fbs",
    "На день Факт Оборачиваемость товара FBS": "turnover_fbs",
    "На день План Дневной план заказов (по ПП месяца)": "orders_plan",
    "На день Факт Факт заказов": "orders_fact",
    "На день Факт Расход рекламный": "ad_spend",
    "На день Факт Выручка": "revenue",
    "На день Факт Маржа": "margin",
    "На день Факт ДРР": "drr",
    "На день План ДРР плановый (по ПП месяца)": "drr_plan",
    "На день Факт Маржинальность (до РК)": "margin_before_ads",
    "На день Факт Маржинальность (после РК)": "margin_after_ads",
}
ARTICLE_SHEET_INT_FIELDS: Set[str] = {
    "crm_id",
    "stock_fbo",
    "turnover_fbo",
    "stock_fbs",
    "turnover_fbs",
    "orders_plan",
    "orders_fact",
}
ARTICLE_SHEET_FLOAT_FIELDS: Set[str] = {
    "price_before_spp",
    "price_after_spp",
    "spp",
    "ad_spend",
    "revenue",
    "margin",
    "drr",
    "drr_plan",
    "margin_before_ads",
    "margin_after_ads",
}


def _parse_iso_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    return date.fromisoformat(value)


def _iter_iso_days(start: Optional[str], end: Optional[str]) -> List[str]:
    start_date = _parse_iso_date(start)
    end_date = _parse_iso_date(end)
    if not start_date or not end_date or start_date > end_date:
        return []
    current = start_date
    days: List[str] = []
    while current <= end_date:
        days.append(current.isoformat())
        current += timedelta(days=1)
    return days


def _split_iso_date_range(start: Optional[str], end: Optional[str], chunk_days: int = PRODUCT_DAILY_STATS_CHUNK_DAYS) -> List[Tuple[str, str]]:
    start_date = _parse_iso_date(start)
    end_date = _parse_iso_date(end)
    if not start_date or not end_date or start_date > end_date:
        return []
    ranges: List[Tuple[str, str]] = []
    current = start_date
    while current <= end_date:
        chunk_end = min(current + timedelta(days=max(1, chunk_days) - 1), end_date)
        ranges.append((current.isoformat(), chunk_end.isoformat()))
        current = chunk_end + timedelta(days=1)
    return ranges


def _build_stat_dyn_referer(base_referer: str, start: str, end: str) -> str:
    start_date = _parse_iso_date(start)
    end_date = _parse_iso_date(end)
    if not start_date or not end_date or start_date > end_date:
        return base_referer
    span_days = (end_date - start_date).days + 1
    dyn_end = start_date - timedelta(days=1)
    dyn_start = dyn_end - timedelta(days=span_days - 1)
    return f"{base_referer}?stat={start}..{end}&dyn={dyn_start.isoformat()}..{dyn_end.isoformat()}"


def _parse_flexible_datetime(value: Any) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None

    normalized = text.replace("Z", "+00:00")
    candidates = [normalized]
    if " " in normalized and "T" not in normalized:
        candidates.append(normalized.replace(" ", "T", 1))

    for candidate in candidates:
        try:
            return datetime.fromisoformat(candidate)
        except Exception:
            continue

    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d.%m.%Y, %H:%M", "%d.%m.%Y"):
        try:
            return datetime.strptime(text, fmt)
        except Exception:
            continue
    return None


def _parse_decimal_number(value: Any) -> Optional[float]:
    text = str(value or "").strip()
    if not text:
        return None
    normalized = (
        text.replace("\u00a0", "")
        .replace(" ", "")
        .replace("%", "")
        .replace(",", ".")
    )
    try:
        return float(normalized)
    except (TypeError, ValueError):
        return None


def _parse_decimal_int(value: Any) -> Optional[int]:
    parsed = _parse_decimal_number(value)
    if parsed is None:
        return None
    try:
        return int(round(parsed))
    except (TypeError, ValueError):
        return None


def _normalize_article_sheet_row(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    article = str(row.get("Артикул") or "").strip()
    if not article:
        return None

    normalized: Dict[str, Any] = {
        "article": article,
        "source_url": ARTICLE_SHEET_SOURCE_URL,
        "sheet_name": ARTICLE_SHEET_NAME,
    }
    for source_key, target_key in ARTICLE_SHEET_FIELD_MAP.items():
        if target_key == "article":
            continue
        raw_value = row.get(source_key)
        if target_key == "day":
            parsed = _parse_flexible_datetime(raw_value)
            normalized[target_key] = parsed.date().isoformat() if parsed is not None else str(raw_value or "").strip()
        elif target_key in ARTICLE_SHEET_INT_FIELDS:
            normalized[target_key] = _parse_decimal_int(raw_value)
        elif target_key in ARTICLE_SHEET_FLOAT_FIELDS:
            normalized[target_key] = _parse_decimal_number(raw_value)
        else:
            text = str(raw_value or "").strip()
            normalized[target_key] = text or None
    return normalized


def _get_cached_article_sheet_rows(allow_stale: bool = False) -> Optional[Dict[str, List[Dict[str, Any]]]]:
    with _CACHE_LOCK:
        entry = _ARTICLE_SHEET_CACHE.get(ARTICLE_SHEET_CSV_URL)
        if entry is None:
            return None
        cached_at, payload = entry
        age = monotonic() - cached_at
        if age <= ARTICLE_SHEET_CACHE_TTL_SECONDS:
            return copy.deepcopy(payload)
        if allow_stale and age <= ARTICLE_SHEET_CACHE_STALE_SECONDS:
            return copy.deepcopy(payload)
        if age > ARTICLE_SHEET_CACHE_STALE_SECONDS:
            _ARTICLE_SHEET_CACHE.pop(ARTICLE_SHEET_CSV_URL, None)
            return None
        return None


def _set_cached_article_sheet_rows(payload: Dict[str, List[Dict[str, Any]]]) -> None:
    with _CACHE_LOCK:
        _ARTICLE_SHEET_CACHE[ARTICLE_SHEET_CSV_URL] = (monotonic(), copy.deepcopy(payload))
        _ARTICLE_SHEET_ERROR_CACHE.pop(ARTICLE_SHEET_CSV_URL, None)


def _get_cached_article_sheet_error() -> Optional[str]:
    with _CACHE_LOCK:
        entry = _ARTICLE_SHEET_ERROR_CACHE.get(ARTICLE_SHEET_CSV_URL)
        if entry is None:
            return None
        cached_at, message = entry
        if monotonic() - cached_at > ARTICLE_SHEET_ERROR_TTL_SECONDS:
            _ARTICLE_SHEET_ERROR_CACHE.pop(ARTICLE_SHEET_CSV_URL, None)
            return None
        return message


def _set_cached_article_sheet_error(message: str) -> None:
    with _CACHE_LOCK:
        _ARTICLE_SHEET_ERROR_CACHE[ARTICLE_SHEET_CSV_URL] = (monotonic(), str(message))


def _fetch_article_sheet_rows_by_article() -> Dict[str, List[Dict[str, Any]]]:
    response = requests.get(
        ARTICLE_SHEET_CSV_URL,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "text/csv,text/plain;q=0.9,*/*;q=0.8",
        },
        timeout=ARTICLE_SHEET_FETCH_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    decoded = response.content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(decoded))
    rows_by_article: Dict[str, List[Dict[str, Any]]] = {}
    for raw_row in reader:
        normalized_row = _normalize_article_sheet_row(raw_row)
        if normalized_row is None:
            continue
        rows_by_article.setdefault(normalized_row["article"], []).append(normalized_row)

    for article_rows in rows_by_article.values():
        article_rows.sort(key=lambda row: row.get("day") or "")
    return rows_by_article


def _refresh_article_sheet_rows_in_background() -> None:
    with _CACHE_LOCK:
        if ARTICLE_SHEET_CSV_URL in _ARTICLE_SHEET_REFRESH_IN_FLIGHT:
            return
        _ARTICLE_SHEET_REFRESH_IN_FLIGHT.add(ARTICLE_SHEET_CSV_URL)

    def _worker() -> None:
        try:
            payload = _fetch_article_sheet_rows_by_article()
            _set_cached_article_sheet_rows(payload)
        except Exception as exc:
            _set_cached_article_sheet_error(str(exc))
        finally:
            with _CACHE_LOCK:
                _ARTICLE_SHEET_REFRESH_IN_FLIGHT.discard(ARTICLE_SHEET_CSV_URL)

    Thread(target=_worker, daemon=True).start()


def _load_article_sheet_rows_by_article() -> Dict[str, List[Dict[str, Any]]]:
    cached = _get_cached_article_sheet_rows()
    if cached is not None:
        return cached

    stale = _get_cached_article_sheet_rows(allow_stale=True)
    if stale is not None:
        _refresh_article_sheet_rows_in_background()
        return stale

    recent_error = _get_cached_article_sheet_error()
    if not recent_error:
        _refresh_article_sheet_rows_in_background()
    return {}


def _filter_article_sheet_rows(
    rows: List[Dict[str, Any]],
    start: Optional[str],
    end: Optional[str],
) -> List[Dict[str, Any]]:
    allowed_days = set(_iter_iso_days(start, end))
    if not allowed_days:
        return copy.deepcopy(rows)
    return [copy.deepcopy(row) for row in rows if str(row.get("day") or "").strip() in allowed_days]


def _sum_article_sheet_field(rows: List[Dict[str, Any]], field: str) -> Optional[float]:
    values = [float(row[field]) for row in rows if row.get(field) is not None]
    if not values:
        return None
    return sum(values)


def _build_article_sheet_payload(
    rows: List[Dict[str, Any]],
    error: Optional[str] = None,
) -> Dict[str, Any]:
    latest_row = rows[-1] if rows else None
    return {
        "available": bool(rows),
        "source_url": ARTICLE_SHEET_SOURCE_URL,
        "sheet_name": ARTICLE_SHEET_NAME,
        "rows": rows,
        "latest": copy.deepcopy(latest_row) if latest_row else None,
        "totals": {
            "orders_plan": _sum_article_sheet_field(rows, "orders_plan"),
            "orders_fact": _sum_article_sheet_field(rows, "orders_fact"),
            "ad_spend": _sum_article_sheet_field(rows, "ad_spend"),
            "revenue": _sum_article_sheet_field(rows, "revenue"),
            "margin": _sum_article_sheet_field(rows, "margin"),
        },
        "error": error,
    }


def _resolve_campaign_history_fetch_start(campaign: Optional[Dict[str, Any]]) -> Optional[str]:
    candidates: List[date] = []
    for value in [(campaign or {}).get("wb_created"), (campaign or {}).get("created")]:
        parsed = _parse_flexible_datetime(value)
        if parsed is not None:
            candidates.append(parsed.date())
    return min(candidates).isoformat() if candidates else None


def _status_mp_history_reached_start(rows: Optional[List[Dict[str, Any]]], start: Optional[str]) -> bool:
    target_date = _parse_iso_date(start)
    if target_date is None:
        return False
    parsed_days = [
        parsed.date()
        for parsed in (_parse_flexible_datetime((row or {}).get("timestamp")) for row in (rows or []))
        if parsed is not None
    ]
    return bool(parsed_days) and min(parsed_days) <= target_date


def _status_pause_history_reached_start(payload: Optional[Dict[str, Any]], start: Optional[str]) -> bool:
    target_date = _parse_iso_date(start)
    if target_date is None:
        return False
    parsed_days = [
        parsed.date()
        for parsed in (
            _parse_flexible_datetime((row or {}).get("startDate") or (row or {}).get("endDate"))
            for row in ((payload or {}).get("tooltips") or [])
        )
        if parsed is not None
    ]
    return bool(parsed_days) and min(parsed_days) <= target_date


def _snapshot_fields(payload: Optional[Dict[str, Any]], fields: Iterable[str]) -> Dict[str, Any]:
    source = payload or {}
    snapshot: Dict[str, Any] = {}
    for field in fields:
        if field in source:
            snapshot[field] = copy.deepcopy(source[field])
    return snapshot


def resolve_range(
    start: Optional[str] = None,
    end: Optional[str] = None,
    reference_date: Optional[date] = None,
    default_days: int = DEFAULT_RANGE_DAYS,
) -> Dict[str, Any]:
    today = reference_date or date.today()
    end_date = _parse_iso_date(end) or today
    start_date = _parse_iso_date(start) or (end_date - timedelta(days=default_days - 1))
    if start_date > end_date:
        raise ValueError("start date must not be after end date")

    span_days = (end_date - start_date).days + 1
    compare_end = start_date - timedelta(days=1)
    compare_start = compare_end - timedelta(days=span_days - 1)

    return {
        "current_start": start_date.isoformat(),
        "current_end": end_date.isoformat(),
        "compare_start": compare_start.isoformat(),
        "compare_end": compare_end.isoformat(),
        "span_days": span_days,
    }


def load_session(storage_state_path: str) -> requests.Session:
    state = json.loads(Path(storage_state_path).read_text())
    session = requests.Session()
    for cookie in state["cookies"]:
        session.cookies.set(
            cookie["name"],
            cookie["value"],
            domain=cookie["domain"],
            path=cookie["path"],
        )
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json, text/plain, */*",
        }
    )
    return session


class XwayApi:
    def __init__(
        self,
        storage_state_path: str,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ):
        self.storage_state_path = storage_state_path
        self.session = load_session(storage_state_path)
        self._shop_list_cache: Optional[List[Dict[str, Any]]] = None
        self._shop_listing_cache: Dict[int, Dict[str, Any]] = {}
        self._shop_details_cache: Dict[int, Dict[str, Any]] = {}
        self._product_stata_cache: Dict[Tuple[int, int, str, str], Dict[str, Any]] = {}
        self._product_daily_stats_cache: Dict[Tuple[int, int, str, str], List[Dict[str, Any]]] = {}
        self.range = resolve_range(start=start, end=end)

    @property
    def csrf_token(self) -> Optional[str]:
        return self.session.cookies.get("csrftoken_v2") or self.session.cookies.get("csrftoken")

    def _request_json(
        self,
        method: str,
        url: str,
        referer: Optional[str] = None,
        csrf: bool = False,
        **kwargs: Any,
    ) -> Any:
        headers = {}
        if referer:
            headers["Referer"] = referer
        if csrf and self.csrf_token:
            headers["X-CSRFToken"] = self.csrf_token
            headers["X-Requested-With"] = "XMLHttpRequest"
        response = self.session.request(method.upper(), url, headers=headers, timeout=60, **kwargs)
        response.raise_for_status()
        if response.status_code == 204 or not response.text:
            return None
        return response.json()

    def _get_json(self, url: str, referer: Optional[str] = None, **kwargs: Any) -> Any:
        return self._request_json("GET", url, referer=referer, **kwargs)

    def list_shops(self) -> List[Dict[str, Any]]:
        cached = _get_cached_shop_list(self.storage_state_path)
        if cached is not None:
            self._shop_list_cache = cached
        if self._shop_list_cache is None:
            self._shop_list_cache = self._get_json("https://am.xway.ru/api/adv/shop/list?query=")
            _set_cached_shop_list(self.storage_state_path, self._shop_list_cache)
        return self._shop_list_cache

    def shop_details(self, shop_id: int) -> Dict[str, Any]:
        if shop_id not in self._shop_details_cache:
            self._shop_details_cache[shop_id] = self._get_json(
                f"https://am.xway.ru/api/adv/shop/{shop_id}",
                referer=f"https://am.xway.ru/wb/shop/{shop_id}",
            )
        return self._shop_details_cache[shop_id]

    def shop_listing(self, shop_id: int) -> Dict[str, Any]:
        if shop_id in self._shop_listing_cache:
            return self._shop_listing_cache[shop_id]

        cached = _get_cached_shop_listing(self.storage_state_path, self.range["current_start"], self.range["current_end"], shop_id)
        if cached is not None:
            self._shop_listing_cache[shop_id] = cached
            return cached

        query = (
            f"start={self.range['current_start']}"
            f"&end={self.range['current_end']}"
            f"&is_active=1&enabled=1"
        )
        referer = f"https://am.xway.ru/wb/shop/{shop_id}"

        endpoints = (
            (
                "list_wo",
                f"https://am.xway.ru/api/adv/shop/{shop_id}/product/list-wo-stat?{query}",
            ),
            (
                "list_stat",
                f"https://am.xway.ru/api/adv/shop/{shop_id}/product/list-stat?{query}",
            ),
        )

        results: Dict[str, Any] = {}
        failures: List[Exception] = []
        with ThreadPoolExecutor(max_workers=2) as executor:
            future_by_key = {
                executor.submit(self._get_json, url, referer=referer): key for key, url in endpoints
            }
            for future in as_completed(future_by_key):
                key = future_by_key[future]
                try:
                    results[key] = future.result()
                except Exception as exc:  # pragma: no cover - defensive path
                    failures.append(exc)
                    results[key] = {"products_wb": []}
                    if key == "list_stat":
                        results[key] = {"products_wb": {}}

        if len(failures) == len(endpoints):
            raise RuntimeError("Failed to load shop listing endpoints")

        list_wo = results.get("list_wo") or {"products_wb": []}
        list_stat = results.get("list_stat") or {"products_wb": {}}
        result = {"list_wo": list_wo, "list_stat": list_stat}
        self._shop_listing_cache[shop_id] = result
        _set_cached_shop_listing(
            self.storage_state_path,
            self.range["current_start"],
            self.range["current_end"],
            shop_id,
            result,
        )
        return result

    def find_articles(self, article_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
        targets = {str(article_id) for article_id in article_ids}
        found: Dict[str, Dict[str, Any]] = {}
        for shop in self.list_shops():
            shop_id = shop["id"]
            listing = self.shop_listing(shop_id)
            products = listing["list_wo"].get("products_wb", [])
            product_stat_map = listing["list_stat"].get("products_wb", {})
            for product in products:
                article = str(product.get("external_id"))
                if article not in targets or article in found:
                    continue
                product_id = product["id"]
                found[article] = {
                    "shop": shop,
                    "product": product,
                    "stat_item": product_stat_map.get(str(product_id), {}),
                }
            if len(found) == len(targets):
                break
        return found

    def product_info(self, shop_id: int, product_id: int) -> Dict[str, Any]:
        return self._get_json(
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/info",
            referer=f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
        )

    def product_dynamics(self, shop_id: int, product_id: int) -> Dict[str, Any]:
        r = self.range
        return self._get_json(
            "https://am.xway.ru/api/adv/shop/"
            f"{shop_id}/product/{product_id}/dynamics-totals"
            f"?filter_start={r['current_start']}"
            f"&filter_end={r['current_end']}"
            f"&dynamics_start={r['compare_start']}"
            f"&dynamics_end={r['compare_end']}"
            "&is_active=0",
            referer=f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
        )

    def product_stocks_rule(self, shop_id: int, product_id: int) -> Dict[str, Any]:
        return self._get_json(
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/stocks-rule",
            referer=f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
        )

    def product_stata(self, shop_id: int, product_id: int) -> Dict[str, Any]:
        r = self.range
        return self.product_stata_range(shop_id, product_id, r["current_start"], r["current_end"])

    def product_stata_range(
        self,
        shop_id: int,
        product_id: int,
        start: str,
        end: str,
    ) -> Dict[str, Any]:
        cache_key = (int(shop_id), int(product_id), str(start), str(end))
        cached = self._product_stata_cache.get(cache_key)
        if cached is not None:
            return cached
        payload = self._get_json(
            "https://am.xway.ru/api/adv/shop/"
            f"{shop_id}/product/{product_id}/stata"
            f"?is_active=0&start={start}&end={end}&tags&active_camps=1",
            referer=f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
        )
        self._product_stata_cache[cache_key] = payload
        return payload

    def campaign_daily_exact(
        self,
        shop_id: int,
        product_id: int,
        campaign_ids: Iterable[int],
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> Dict[str, List[Dict[str, Any]]]:
        normalized_ids = [str(campaign_id) for campaign_id in campaign_ids if campaign_id is not None]
        result: Dict[str, List[Dict[str, Any]]] = {campaign_id: [] for campaign_id in normalized_ids}
        if not normalized_ids:
            return result

        range_start = start or self.range["current_start"]
        range_end = end or self.range["current_end"]
        days = _iter_iso_days(range_start, range_end)
        day_stata_payloads: Dict[str, Dict[str, Any]] = {}
        if days:
            max_workers = min(7, max(1, len(days)))
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                future_by_day = {
                    executor.submit(self.product_stata_range, shop_id, product_id, day, day): day
                    for day in days
                }
                for future in as_completed(future_by_day):
                    day_stata_payloads[future_by_day[future]] = future.result()

        for day in days:
            stata = day_stata_payloads.get(day) or {}
            campaign_map = {
                str(campaign.get("id")): campaign
                for campaign in (stata.get("campaign_wb") or [])
                if campaign.get("id") is not None
            }
            for campaign_id in normalized_ids:
                stat = (campaign_map.get(campaign_id) or {}).get("stat") or {}
                result[campaign_id].append(
                    {
                        "day": day,
                        "views": stat.get("views"),
                        "clicks": stat.get("clicks"),
                        "atbs": stat.get("atbs"),
                        "orders": stat.get("orders"),
                        "shks": stat.get("shks"),
                        "rel_shks": stat.get("rel_shks"),
                        "expense_sum": stat.get("sum"),
                        "sum_price": stat.get("sum_price"),
                        "rel_sum_price": stat.get("rel_sum_price"),
                        "CTR": stat.get("CTR"),
                        "CPC": stat.get("CPC"),
                        "CR": stat.get("CR"),
                        "CPO": stat.get("CPO"),
                        "CPO_with_rel": stat.get("CPO_with_rel"),
                    }
                )
        return result

    def product_stats_by_day(
        self,
        shop_id: int,
        product_id: int,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        range_start = start or self.range["current_start"]
        range_end = end or self.range["current_end"]
        cache_key = (int(shop_id), int(product_id), str(range_start), str(range_end))
        cached = self._product_daily_stats_cache.get(cache_key)
        if cached is not None:
            return copy.deepcopy(cached)

        ranges = _split_iso_date_range(range_start, range_end)
        if len(ranges) > 1:
            rows_by_day: Dict[str, Dict[str, Any]] = {}
            for chunk_start, chunk_end in ranges:
                for row in self.product_stats_by_day(shop_id, product_id, chunk_start, chunk_end):
                    day = str(row.get("day") or "").strip()
                    if day:
                        rows_by_day[day] = row
            payload = [copy.deepcopy(rows_by_day[day]) for day in sorted(rows_by_day)]
            self._product_daily_stats_cache[cache_key] = payload
            return copy.deepcopy(payload)

        chunk_start, chunk_end = ranges[0] if ranges else (range_start, range_end)
        payload = self._get_json(
            "https://am.xway.ru/api/adv/shop/"
            f"{shop_id}/product/{product_id}/stats-by-day"
            f"?start={chunk_start}&end={chunk_end}",
            referer=_build_stat_dyn_referer(
                f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
                chunk_start,
                chunk_end,
            ),
        )
        self._product_daily_stats_cache[cache_key] = payload
        return copy.deepcopy(payload)

    def product_heat_map(
        self,
        shop_id: int,
        product_id: int,
        campaign_ids: Iterable[int],
    ) -> Any:
        campaigns = ",".join(str(campaign_id) for campaign_id in campaign_ids)
        if not campaigns:
            return None
        r = self.range
        return self._get_json(
            "https://am.xway.ru/api/adv/shop/"
            f"{shop_id}/product/{product_id}/heat-map"
            f"?campaigns={campaigns}&from={r['current_start']}&to={r['current_end']}",
            referer=f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
        )

    def product_orders_heat_map(self, shop_id: int, product_id: int) -> Any:
        r = self.range
        return self._get_json(
            "https://am.xway.ru/api/adv/shop/"
            f"{shop_id}/product/{product_id}/orders-heat-map"
            f"?from={r['current_start']}&to={r['current_end']}",
            referer=f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
        )

    def campaign_schedule(self, shop_id: int, product_id: int, campaign_id: int) -> Dict[str, Any]:
        stat = f"{self.range['current_start']}..{self.range['current_end']}"
        return self._get_json(
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/campaign/{campaign_id}/schedule-get",
            referer=(
                f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}"
                f"/campaign/{campaign_id}/new-flow?stat={stat}"
            ),
        )

    def campaign_bid_history(self, shop_id: int, product_id: int, campaign_id: int) -> List[Dict[str, Any]]:
        stat = f"{self.range['current_start']}..{self.range['current_end']}"
        return self._get_json(
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/campaign/{campaign_id}/bid-history",
            referer=(
                f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}"
                f"/campaign/{campaign_id}/new-flow?stat={stat}"
            ),
        )

    def campaign_budget_history(self, shop_id: int, product_id: int, campaign_id: int) -> List[Dict[str, Any]]:
        stat = f"{self.range['current_start']}..{self.range['current_end']}"
        return self._get_json(
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/campaign/{campaign_id}/budget-history",
            referer=(
                f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}"
                f"/campaign/{campaign_id}/new-flow?stat={stat}"
            ),
        )

    def campaign_status_mp_history(
        self,
        shop_id: int,
        product_id: int,
        campaign_id: int,
        offset: int = 0,
        limit: int = 40,
    ) -> Dict[str, Any]:
        return self._get_json(
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/campaign/{campaign_id}/status-mp-history",
            referer=f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
            params={"offset": offset, "limit": limit},
        )

    def campaign_status_mp_history_full(
        self,
        shop_id: int,
        product_id: int,
        campaign_id: int,
        page_limit: int = STATUS_MP_HISTORY_PAGE_LIMIT,
        max_pages: int = STATUS_MP_HISTORY_MAX_PAGES,
        target_start: Optional[str] = None,
    ) -> Dict[str, Any]:
        safe_limit = max(1, int(page_limit or STATUS_MP_HISTORY_PAGE_LIMIT))
        safe_max_pages = max(1, int(max_pages or STATUS_MP_HISTORY_MAX_PAGES))
        if target_start:
            safe_max_pages = max(safe_max_pages, STATUS_MP_HISTORY_CREATION_MAX_PAGES)
        offset = 0
        result: List[Dict[str, Any]] = []
        next_page = False

        for _ in range(safe_max_pages):
            payload = self.campaign_status_mp_history(
                shop_id,
                product_id,
                campaign_id,
                offset=offset,
                limit=safe_limit,
            ) or {}
            page_rows = payload.get("result") or []
            result.extend(page_rows)
            next_page = bool(payload.get("next_page"))
            covers_target_start = _status_mp_history_reached_start(result, target_start)
            if covers_target_start:
                next_page = False
                break
            if not next_page or not page_rows or len(page_rows) < safe_limit:
                next_page = False
                break
            offset += safe_limit

        return {
            "result": result,
            "next_page": next_page,
        }

    def campaign_status_pause_history(
        self,
        shop_id: int,
        product_id: int,
        campaign_id: int,
        limit: int = 24,
    ) -> Dict[str, Any]:
        return self._request_json(
            "POST",
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/campaign/{campaign_id}/status-pause-history",
            referer=f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
            csrf=True,
            json={"limit": limit},
        )

    def campaign_status_pause_history_full(
        self,
        shop_id: int,
        product_id: int,
        campaign_id: int,
        initial_limit: int = STATUS_PAUSE_HISTORY_INITIAL_LIMIT,
        max_limit: int = STATUS_PAUSE_HISTORY_MAX_LIMIT,
        target_start: Optional[str] = None,
    ) -> Dict[str, Any]:
        safe_limit = max(1, int(initial_limit or STATUS_PAUSE_HISTORY_INITIAL_LIMIT))
        safe_max_limit = max(safe_limit, int(max_limit or STATUS_PAUSE_HISTORY_MAX_LIMIT))
        if target_start:
            safe_max_limit = max(safe_max_limit, STATUS_PAUSE_HISTORY_CREATION_MAX_LIMIT)
        payload: Dict[str, Any] = {}

        while True:
            payload = self.campaign_status_pause_history(
                shop_id,
                product_id,
                campaign_id,
                limit=safe_limit,
            ) or {}
            if _status_pause_history_reached_start(payload, target_start):
                return payload
            next_page = payload.get("next_page") or {}
            if not next_page.get("has_next") or safe_limit >= safe_max_limit:
                return payload
            requested_limit = next_page.get("limit") or safe_limit
            requested_limit = max(safe_limit, int(requested_limit))
            safe_limit = min(safe_max_limit, max(requested_limit + 120, safe_limit * 2))

    def campaign_normquery_stats(self, shop_id: int, product_id: int, campaign_id: int) -> Dict[str, Any]:
        r = self.range
        jam_start = (_parse_iso_date(r["current_end"]) - timedelta(days=30)).isoformat()
        return self._get_json(
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/campaign/{campaign_id}/normquery-stats",
            referer=(
                f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}"
                f"/campaign/{campaign_id}/new-flow?stat={r['current_start']}..{r['current_end']}"
            ),
            params={
                "search_mode": "cluster",
                "search_part": "cluster",
                "excludes": "",
                "includes": "",
                "exact_match": "0",
                "start": r["current_start"],
                "end": r["current_end"],
                "dynamics_start": r["compare_start"],
                "dynamics_end": r["compare_end"],
                "for_jam_start": jam_start,
                "for_jam_end": r["current_end"],
                "with_stats_only": "1",
                "init": "1",
            },
        )

    def product_normqueries_positions(
        self,
        shop_id: int,
        product_id: int,
        normquery_ids: Iterable[int],
    ) -> Dict[str, Any]:
        ids = [int(normquery_id) for normquery_id in normquery_ids if normquery_id is not None]
        if not ids:
            return {}
        return self._request_json(
            "POST",
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/normqueries-positions",
            referer=f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
            csrf=True,
            json={"normquery_ids": ids},
        )

    def campaign_additional_stats_for_normqueries(
        self,
        shop_id: int,
        product_id: int,
        campaign_id: int,
        normquery_ids: Iterable[int],
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> Dict[str, Any]:
        ids = [int(normquery_id) for normquery_id in normquery_ids if normquery_id is not None]
        if not ids:
            return {}
        return self._request_json(
            "POST",
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/campaign/{campaign_id}/additional-stats-for-normqueries",
            referer=(
                f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}"
                f"/campaign/{campaign_id}/new-flow?stat={self.range['current_start']}..{self.range['current_end']}"
            ),
            csrf=True,
            json={
                "normquery_ids": ids,
                "start": start or self.range["current_start"],
                "end": end or self.range["current_end"],
            },
        )

    def campaign_normquery_history(
        self,
        shop_id: int,
        product_id: int,
        campaign_id: int,
        normquery_id: int,
    ) -> List[Dict[str, Any]]:
        return self._get_json(
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/campaign/{campaign_id}/normquery-history",
            referer=(
                f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}"
                f"/campaign/{campaign_id}/new-flow?stat={self.range['current_start']}..{self.range['current_end']}"
            ),
            params={"normquery_id": normquery_id},
        )

    def campaign_normquery_bid_history(
        self,
        shop_id: int,
        product_id: int,
        campaign_id: int,
        normquery_id: int,
    ) -> List[Dict[str, Any]]:
        return self._get_json(
            f"https://am.xway.ru/api/adv/shop/{shop_id}/product/{product_id}/campaign/{campaign_id}/normquery-bid-history",
            referer=(
                f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}"
                f"/campaign/{campaign_id}/new-flow?stat={self.range['current_start']}..{self.range['current_end']}"
            ),
            params={"normquery_id": normquery_id},
        )


def _safe_call(func: Callable[[], Any], default: Any) -> Tuple[Any, Optional[str]]:
    try:
        return func(), None
    except Exception as exc:  # pragma: no cover - defensive path
        return default, str(exc)


def _run_parallel_safe_calls(
    tasks: Dict[str, Tuple[Callable[[], Any], Any]],
    max_workers: int = 4,
) -> Tuple[Dict[str, Any], Dict[str, Optional[str]]]:
    if not tasks:
        return {}, {}
    values: Dict[str, Any] = {}
    errors: Dict[str, Optional[str]] = {}
    with ThreadPoolExecutor(max_workers=min(max_workers, max(1, len(tasks)))) as executor:
        future_by_key = {
            executor.submit(_safe_call, call, default): key
            for key, (call, default) in tasks.items()
        }
        for future in as_completed(future_by_key):
            key = future_by_key[future]
            value, error = future.result()
            values[key] = value
            errors[key] = error
    return values, errors


def _collect_campaign_heavy_payload(
    storage_state_path: str,
    start: Optional[str],
    end: Optional[str],
    shop_id: int,
    product_id: int,
    campaign_id: int,
    campaign_history_start: Optional[str] = None,
) -> Dict[str, Any]:
    api = XwayApi(storage_state_path, start=start, end=end)
    primary_values, primary_errors = _run_parallel_safe_calls(
        {
            "schedule": (
                lambda: api.campaign_schedule(shop_id, product_id, campaign_id),
                {},
            ),
            "bid_history": (
                lambda: api.campaign_bid_history(shop_id, product_id, campaign_id),
                [],
            ),
            "budget_history": (
                lambda: api.campaign_budget_history(shop_id, product_id, campaign_id),
                [],
            ),
            "status_mp": (
                lambda: api.campaign_status_mp_history_full(
                    shop_id,
                    product_id,
                    campaign_id,
                    page_limit=STATUS_MP_HISTORY_PAGE_LIMIT,
                    target_start=campaign_history_start,
                ),
                {},
            ),
            "status_pause": (
                lambda: api.campaign_status_pause_history_full(
                    shop_id,
                    product_id,
                    campaign_id,
                    initial_limit=STATUS_PAUSE_HISTORY_INITIAL_LIMIT,
                    target_start=campaign_history_start,
                ),
                {},
            ),
            "cluster_stats": (
                lambda: api.campaign_normquery_stats(shop_id, product_id, campaign_id),
                {},
            ),
        },
        max_workers=6,
    )

    cluster_stats_payload = primary_values.get("cluster_stats") or {}
    cluster_ids = [
        item.get("normquery_id")
        for item in (cluster_stats_payload.get("normqueries") or [])
        if item.get("normquery_id") is not None
    ]

    secondary_values = {
        "cluster_positions": {},
        "cluster_additional": {},
        "cluster_history": {},
    }
    secondary_errors: Dict[str, Optional[str]] = {
        "cluster_positions": None,
        "cluster_additional": None,
        "cluster_history": None,
    }
    if cluster_ids:
        secondary_values, secondary_errors = _run_parallel_safe_calls(
            {
                "cluster_positions": (
                    lambda: api.product_normqueries_positions(shop_id, product_id, cluster_ids),
                    {},
                ),
                "cluster_additional": (
                    lambda: api.campaign_additional_stats_for_normqueries(
                        shop_id,
                        product_id,
                        campaign_id,
                        cluster_ids,
                        start=_additional_stats_start(api.range),
                        end=api.range["current_end"],
                    ),
                    {},
                ),
                "cluster_history": (
                    lambda: {
                        str(normquery_id): _safe_call(
                            lambda normquery_id=normquery_id: api.campaign_normquery_history(
                                shop_id,
                                product_id,
                                campaign_id,
                                normquery_id,
                            ),
                            [],
                        )[0]
                        or []
                        for normquery_id in cluster_ids
                    },
                    {},
                ),
            },
            max_workers=3,
        )

    return {
        "schedule_payload": primary_values.get("schedule") or {},
        "bid_history_payload": primary_values.get("bid_history") or [],
        "budget_history_payload": primary_values.get("budget_history") or [],
        "status_mp_payload": primary_values.get("status_mp") or {},
        "status_pause_payload": primary_values.get("status_pause") or {},
        "cluster_stats_payload": cluster_stats_payload,
        "cluster_positions_payload": secondary_values.get("cluster_positions") or {},
        "cluster_additional_payload": secondary_values.get("cluster_additional") or {},
        "cluster_history_payload": secondary_values.get("cluster_history") or {},
        "errors": {
            "schedule": primary_errors.get("schedule"),
            "bid_history": primary_errors.get("bid_history"),
            "budget_history": primary_errors.get("budget_history"),
            "status_mp": primary_errors.get("status_mp"),
            "status_pause": primary_errors.get("status_pause"),
            "cluster_stats": primary_errors.get("cluster_stats"),
            "cluster_positions": secondary_errors.get("cluster_positions"),
            "cluster_additional": secondary_errors.get("cluster_additional"),
            "cluster_history": secondary_errors.get("cluster_history"),
        },
    }


def _format_day(day: str) -> str:
    return datetime.strptime(day, DATE_FMT).strftime("%d.%m.%Y")


def _normalize_daily_stats(
    rows: Optional[List[Dict[str, Any]]],
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> List[Dict[str, Any]]:
    rows = rows or []
    start_date = _parse_iso_date(start)
    end_date = _parse_iso_date(end)
    filtered: List[Dict[str, Any]] = []
    for row in rows:
        day_raw = row.get("day")
        try:
            day_value = _parse_iso_date(day_raw)
        except Exception:
            day_value = None
        if start_date and day_value and day_value < start_date:
            continue
        if end_date and day_value and day_value > end_date:
            continue
        filtered.append(row)

    ordered = sorted(filtered, key=lambda item: item.get("day") or "")
    normalized = []
    for row in ordered:
        item = dict(row)
        item["day_label"] = _format_day(item["day"])
        normalized.append(item)
    return normalized


def _catalog_cache_key(
    storage_state_path: str,
    range_payload: Dict[str, str],
    mode: str = "compact",
) -> Tuple[str, str, str, str]:
    return (
        storage_state_path,
        range_payload["current_start"],
        range_payload["current_end"],
        str(mode or "compact"),
    )


def _products_cache_key(
    storage_state_path: str,
    range_payload: Dict[str, str],
    article_ids: Iterable[str],
    campaign_mode: str,
    heavy_campaign_ids: Iterable[str],
) -> Tuple[str, str, str, str, Tuple[str, ...], Tuple[str, ...]]:
    return (
        storage_state_path,
        range_payload["current_start"],
        range_payload["current_end"],
        str(campaign_mode or "full"),
        tuple(str(article_id) for article_id in article_ids),
        tuple(sorted(str(campaign_id) for campaign_id in heavy_campaign_ids)),
    )


def _shop_list_cache_key(storage_state_path: str) -> str:
    return storage_state_path


def _shop_listing_cache_key(storage_state_path: str, start: str, end: str, shop_id: int) -> Tuple[str, str, str, int]:
    return (storage_state_path, start, end, int(shop_id))


def _get_cached_shop_list(storage_state_path: str) -> Optional[List[Dict[str, Any]]]:
    now = monotonic()
    cache_key = _shop_list_cache_key(storage_state_path)
    with _CACHE_LOCK:
        entry = _SHOP_LIST_CACHE.get(cache_key)
        if not entry:
            return None
        cached_at, payload = entry
        if now - cached_at > SHOP_LIST_CACHE_TTL_SECONDS:
            _SHOP_LIST_CACHE.pop(cache_key, None)
            return None
        return copy.deepcopy(payload)


def _set_cached_shop_list(storage_state_path: str, payload: List[Dict[str, Any]]) -> None:
    cache_key = _shop_list_cache_key(storage_state_path)
    with _CACHE_LOCK:
        if len(_SHOP_LIST_CACHE) >= SHOP_LIST_CACHE_MAX_ENTRIES:
            oldest_key = min(_SHOP_LIST_CACHE.items(), key=lambda item: item[1][0])[0]
            _SHOP_LIST_CACHE.pop(oldest_key, None)
        _SHOP_LIST_CACHE[cache_key] = (monotonic(), copy.deepcopy(payload))


def _get_cached_shop_listing(
    storage_state_path: str,
    start: str,
    end: str,
    shop_id: int,
) -> Optional[Dict[str, Any]]:
    now = monotonic()
    cache_key = _shop_listing_cache_key(storage_state_path, start, end, shop_id)
    with _CACHE_LOCK:
        entry = _SHOP_LISTING_CACHE.get(cache_key)
        if not entry:
            return None
        cached_at, payload = entry
        if now - cached_at > SHOP_LISTING_CACHE_TTL_SECONDS:
            _SHOP_LISTING_CACHE.pop(cache_key, None)
            return None
        return copy.deepcopy(payload)


def _set_cached_shop_listing(
    storage_state_path: str,
    start: str,
    end: str,
    shop_id: int,
    payload: Dict[str, Any],
) -> None:
    cache_key = _shop_listing_cache_key(storage_state_path, start, end, shop_id)
    with _CACHE_LOCK:
        if len(_SHOP_LISTING_CACHE) >= SHOP_LISTING_CACHE_MAX_ENTRIES:
            oldest_key = min(_SHOP_LISTING_CACHE.items(), key=lambda item: item[1][0])[0]
            _SHOP_LISTING_CACHE.pop(oldest_key, None)
        _SHOP_LISTING_CACHE[cache_key] = (monotonic(), copy.deepcopy(payload))


def _get_cached_catalog(cache_key: Tuple[str, str, str, str]) -> Optional[Dict[str, Any]]:
    now = monotonic()
    with _CACHE_LOCK:
        entry = _CATALOG_CACHE.get(cache_key)
        if not entry:
            return None
        cached_at, payload = entry
        if now - cached_at > CATALOG_CACHE_TTL_SECONDS:
            _CATALOG_CACHE.pop(cache_key, None)
            return None
        return copy.deepcopy(payload)


def _set_cached_catalog(cache_key: Tuple[str, str, str, str], payload: Dict[str, Any]) -> None:
    with _CACHE_LOCK:
        if len(_CATALOG_CACHE) >= CATALOG_CACHE_MAX_ENTRIES:
            oldest_key = min(_CATALOG_CACHE.items(), key=lambda item: item[1][0])[0]
            _CATALOG_CACHE.pop(oldest_key, None)
        _CATALOG_CACHE[cache_key] = (monotonic(), copy.deepcopy(payload))


def _get_cached_products(
    cache_key: Tuple[str, str, str, str, Tuple[str, ...], Tuple[str, ...]],
) -> Optional[Dict[str, Any]]:
    now = monotonic()
    with _CACHE_LOCK:
        entry = _PRODUCTS_CACHE.get(cache_key)
        if not entry:
            return None
        cached_at, payload = entry
        if now - cached_at > PRODUCTS_CACHE_TTL_SECONDS:
            _PRODUCTS_CACHE.pop(cache_key, None)
            return None
        return copy.deepcopy(payload)


def _set_cached_products(
    cache_key: Tuple[str, str, str, str, Tuple[str, ...], Tuple[str, ...]],
    payload: Dict[str, Any],
) -> None:
    with _CACHE_LOCK:
        if len(_PRODUCTS_CACHE) >= PRODUCTS_CACHE_MAX_ENTRIES:
            oldest_key = min(_PRODUCTS_CACHE.items(), key=lambda item: item[1][0])[0]
            _PRODUCTS_CACHE.pop(oldest_key, None)
        _PRODUCTS_CACHE[cache_key] = (monotonic(), copy.deepcopy(payload))


def _filter_dated_mapping(
    rows: Optional[Dict[str, Any]],
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> Dict[str, Any]:
    rows = rows or {}
    start_date = _parse_iso_date(start)
    end_date = _parse_iso_date(end)
    filtered: Dict[str, Any] = {}
    for day, payload in rows.items():
        try:
            day_value = _parse_iso_date(day)
        except Exception:
            day_value = None
        if start_date and day_value and day_value < start_date:
            continue
        if end_date and day_value and day_value > end_date:
            continue
        filtered[day] = payload
    return filtered


def _daily_totals(rows: List[Dict[str, Any]]) -> Dict[str, float]:
    totals = {field: 0.0 for field in DAILY_SUM_FIELDS}
    for row in rows:
        for field in DAILY_SUM_FIELDS:
            value = row.get(field)
            if value is None:
                continue
            totals[field] += float(value)

    views = totals["views"]
    clicks = totals["clicks"]
    expense_sum = totals["expense_sum"]
    orders = totals["orders"]
    ordered_total = totals["ordered_total"]
    rel_shks = totals["rel_shks"]
    sum_price = totals["sum_price"]

    totals.update(
        {
            "CTR": (clicks / views * 100) if views else None,
            "CPC": (expense_sum / clicks) if clicks else None,
            "CR": (orders / clicks * 100) if clicks else None,
            "DRR": (expense_sum / sum_price * 100) if sum_price else None,
            "CPO": (expense_sum / orders) if orders else None,
            "CPO_overall": (expense_sum / ordered_total) if ordered_total else None,
            "CPO_with_rel": (expense_sum / (orders + rel_shks)) if (orders + rel_shks) else None,
        }
    )
    return totals


def _normalize_schedule(schedule_payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload = schedule_payload or {}
    raw_schedule = payload.get("schedule") or {}
    days = []
    active_slots = 0

    for day_key, day_label in WEEKDAYS:
        active_hours = sorted(int(hour) for hour in raw_schedule.get(day_key, []) if hour is not None)
        active_set = set(active_hours)
        cells = []
        for hour in range(24):
            is_active = hour in active_set
            if is_active:
                active_slots += 1
            cells.append({"hour": hour, "active": is_active})
        days.append(
            {
                "key": day_key,
                "label": day_label,
                "active_hours": active_hours,
                "hours": cells,
            }
        )

    return {
        "schedule_active": bool(payload.get("schedule_active")),
        "active_slots": active_slots,
        "days": days,
        "hours_by_day": {day["key"]: day["active_hours"] for day in days},
    }


def _aggregate_schedule(campaigns: List[Dict[str, Any]]) -> Dict[str, Any]:
    matrix = []
    max_count = 0
    active_slots = 0

    for day_key, day_label in WEEKDAYS:
        row = []
        for hour in range(24):
            count = 0
            for campaign in campaigns:
                schedule = campaign.get("schedule_config") or {}
                if hour in (schedule.get("hours_by_day") or {}).get(day_key, []):
                    count += 1
            if count:
                active_slots += 1
                max_count = max(max_count, count)
            row.append({"hour": hour, "count": count, "active": count > 0})
        matrix.append({"key": day_key, "label": day_label, "hours": row})

    return {
        "days": matrix,
        "max_count": max_count,
        "active_slots": active_slots,
    }


def _normalize_heatmap(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload = raw or {}
    by_hour = []
    for hour in range(24):
        entry = (payload.get("by_hour") or {}).get(str(hour)) or {}
        by_hour.append(
            {
                "hour": hour,
                "views": ((entry.get("views") or {}).get("value")),
                "clicks": ((entry.get("clicks") or {}).get("value")),
                "spent": entry.get("spent"),
                "CTR": ((entry.get("CTR") or {}).get("value")),
                "CPC": ((entry.get("CPC") or {}).get("value")),
            }
        )

    return {
        "period_from": payload.get("period_from"),
        "period_to": payload.get("period_to"),
        "views": payload.get("views"),
        "clicks": payload.get("clicks"),
        "CTR": payload.get("CTR"),
        "CPC": payload.get("CPC"),
        "by_hour": by_hour,
    }


def _normalize_orders_heatmap(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload = raw or {}
    by_hour = []
    for hour in range(24):
        entry = (payload.get("by_hour") or {}).get(str(hour)) or {}
        by_hour.append(
            {
                "hour": hour,
                "orders": entry.get("value"),
            }
        )

    return {
        "period_from": payload.get("period_from"),
        "period_to": payload.get("period_to"),
        "statistics_from": payload.get("statistics_from"),
        "overall_orders": payload.get("overall_orders"),
        "by_hour": by_hour,
    }


def _normalize_bid_history(campaign: Dict[str, Any], rows: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    history = []
    for row in rows or []:
        item = dict(row)
        dt_raw = item.get("datetime")
        try:
            dt_sort = datetime.strptime(dt_raw, BID_HISTORY_FMT)
        except Exception:
            dt_sort = None
        item.update(
            {
                "campaign_id": campaign.get("id"),
                "campaign_name": campaign.get("name"),
                "zone": "Рекомендации" if item.get("recom") else "Поиск",
                "datetime_sort": dt_sort.isoformat() if dt_sort else None,
            }
        )
        history.append(item)

    history.sort(key=lambda row: row.get("datetime_sort") or "", reverse=True)
    return history


def _normalize_budget_history(rows: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    history = []
    for row in rows or []:
        item = dict(row)
        dt_raw = item.get("datetime")
        try:
            dt_sort = datetime.strptime(dt_raw, BID_HISTORY_FMT)
        except Exception:
            dt_sort = None
        item["datetime_sort"] = dt_sort.isoformat() if dt_sort else None
        history.append(item)

    history.sort(key=lambda row: row.get("datetime_sort") or "", reverse=True)
    return history


def _normalize_budget_rule(campaign: Dict[str, Any], budget_history: List[Dict[str, Any]]) -> Dict[str, Any]:
    rule = campaign.get("budget_rule") or {}
    last_topup = budget_history[0] if budget_history else None
    return {
        "active": bool(rule.get("active")),
        "threshold": rule.get("threshold"),
        "deposit": rule.get("deposit"),
        "limit": rule.get("limit"),
        "limit_period": rule.get("limit_period"),
        "restart": rule.get("restart"),
        "status": campaign.get("budget_deposit_status"),
        "error": campaign.get("budget_deposit_error"),
        "last_topup": last_topup,
        "history_count": len(budget_history),
    }


def _normalize_spend_limits(campaign: Dict[str, Any]) -> Dict[str, Any]:
    limits = []
    raw_limits = campaign.get("limits_by_period") or {}
    raw_spend = campaign.get("spend") or {}
    for period, config in raw_limits.items():
        limit = config.get("limit")
        spent = raw_spend.get(period)
        remaining = None
        if limit is not None and spent is not None:
            remaining = float(limit) - float(spent)
        limits.append(
            {
                "period": period,
                "active": bool(config.get("active")),
                "limit": limit,
                "spent": spent,
                "remaining": remaining,
            }
        )
    return {"items": limits}


def _normalize_product_spend_limits(
    stat_item: Dict[str, Any],
    product: Dict[str, Any],
    _campaigns: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    raw_limits = copy.deepcopy(stat_item.get("spend_limits") or product.get("spend_limits") or [])
    meaningful_raw_limits = [
        item
        for item in raw_limits
        if isinstance(item, dict) and (item.get("limit") is not None or item.get("active"))
    ]
    return meaningful_raw_limits


def _normalize_status_mp_history(rows: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    history: List[Dict[str, Any]] = []
    for row in rows or []:
        item = dict(row)
        timestamp = item.get("timestamp")
        dt = None
        if timestamp:
            try:
                dt = datetime.fromisoformat(timestamp)
            except Exception:
                dt = None
        item["day"] = dt.date().isoformat() if dt else None
        item["time"] = dt.strftime("%H:%M") if dt else None
        item["timestamp_sort"] = dt.isoformat() if dt else None
        history.append(item)
    history.sort(key=lambda row: row.get("timestamp_sort") or "", reverse=True)
    return history


def _status_interval_state_key(item: Dict[str, Any]) -> Optional[str]:
    if item.get("is_freeze"):
        return "freeze"
    status_text = str(item.get("status") or "").lower()
    reason_text = " ".join(
        str(token or "").lower()
        for token in [*(item.get("pause_reasons") or []), item.get("paused_limiter")]
    )
    if re.search(r"актив|active", status_text):
        return "active"
    if (
        re.search(r"приост|pause|paused|stop|неактив|inactive", status_text)
        or re.search(r"schedule|распис|budget|бюджет|limit|лимит", reason_text)
        or bool(item.get("paused_limiter"))
        or bool(item.get("paused_user"))
    ):
        return "paused"
    return None


def _parse_status_datetime_text(
    value: Optional[str],
    fallback_date: Optional[datetime] = None,
    fallback_year: Optional[int] = None,
) -> Tuple[Optional[datetime], bool]:
    text = str(value or "").strip()
    if not text:
        return None, False

    date_match = re.search(r"(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?", text)
    time_match = re.search(r"(\d{1,2}):(\d{2})", text)

    if fallback_date is not None:
        day = fallback_date.day
        month = fallback_date.month
        year = fallback_date.year
    else:
        day = month = None
        year = fallback_year or datetime.now().year

    has_explicit_date = False
    if date_match:
        day = int(date_match.group(1))
        month = int(date_match.group(2))
        year = int(date_match.group(3)) if date_match.group(3) else (fallback_year or year)
        has_explicit_date = True

    if day is None or month is None or year is None:
        return None, has_explicit_date

    hours = int(time_match.group(1)) if time_match else 0
    minutes = int(time_match.group(2)) if time_match else 0
    try:
        return datetime(year, month, day, hours, minutes, 0, 0), has_explicit_date
    except ValueError:
        return None, has_explicit_date


def _resolve_pause_interval_bounds(item: Dict[str, Any]) -> Tuple[Optional[datetime], Optional[datetime]]:
    start_at, _ = _parse_status_datetime_text(item.get("start"))
    if start_at is None:
        return None, None
    raw_end = str(item.get("end") or "").strip()
    if not raw_end:
        return start_at, datetime.now()
    end_at, has_explicit_date = _parse_status_datetime_text(
        raw_end,
        fallback_date=start_at,
        fallback_year=start_at.year,
    )
    if end_at is None:
        return start_at, start_at
    if not has_explicit_date and end_at <= start_at:
        end_at += timedelta(days=1)
    return start_at, end_at


def _format_status_datetime_text(value: Optional[datetime], start_at: Optional[datetime] = None) -> Optional[str]:
    if value is None:
        return None
    if start_at is not None and value.date() == start_at.date():
        return value.strftime("%H:%M")
    return value.strftime("%d.%m.%Y, %H:%M")


def _join_status_names(*values: Any) -> Optional[str]:
    seen: Set[str] = set()
    ordered: List[str] = []
    for value in values:
        raw = str(value or "").strip()
        if not raw:
            continue
        for part in [chunk.strip() for chunk in raw.split(",")]:
            if part and part not in seen:
                seen.add(part)
                ordered.append(part)
    return ", ".join(ordered) if ordered else None


def _merge_pause_intervals(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        state_key = _status_interval_state_key(item)
        start_at, end_at = _resolve_pause_interval_bounds(item)
        item["pause_reasons"] = list(item.get("pause_reasons") or [])
        if merged:
            previous = merged[-1]
            prev_state_key = previous.get("_state_key")
            prev_start_at = previous.get("_start_at")
            prev_end_at = previous.get("_end_at")
            if (
                state_key
                and state_key == prev_state_key
                and isinstance(start_at, datetime)
                and isinstance(end_at, datetime)
                and isinstance(prev_start_at, datetime)
                and isinstance(prev_end_at, datetime)
                and end_at >= prev_start_at
            ):
                previous["_start_at"] = min(prev_start_at, start_at)
                previous["_end_at"] = max(prev_end_at, end_at)
                previous["start"] = _format_status_datetime_text(previous["_start_at"])
                previous["end"] = _format_status_datetime_text(previous["_end_at"], previous["_start_at"])
                previous["pause_reasons"] = list(dict.fromkeys([
                    *(previous.get("pause_reasons") or []),
                    *(item.get("pause_reasons") or []),
                ]))
                previous["paused_user"] = _join_status_names(previous.get("paused_user"), item.get("paused_user"))
                previous["unpaused_user"] = _join_status_names(previous.get("unpaused_user"), item.get("unpaused_user"))
                previous["stopped_user"] = _join_status_names(previous.get("stopped_user"), item.get("stopped_user"))
                previous["paused_limiter"] = _join_status_names(previous.get("paused_limiter"), item.get("paused_limiter"))
                previous["is_freeze"] = bool(previous.get("is_freeze")) or bool(item.get("is_freeze"))
                previous["is_unfreeze"] = bool(previous.get("is_unfreeze")) or bool(item.get("is_unfreeze"))
                continue

        item["_state_key"] = state_key
        item["_start_at"] = start_at
        item["_end_at"] = end_at
        if start_at is not None:
          item["start"] = _format_status_datetime_text(start_at)
        if end_at is not None:
          item["end"] = _format_status_datetime_text(end_at, start_at)
        merged.append(item)

    for item in merged:
        item.pop("_state_key", None)
        item.pop("_start_at", None)
        item.pop("_end_at", None)
    return merged


def _flatten_pause_tooltips(payload: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for item in (payload or {}).get("tooltips") or []:
        normalized = {
            "start": item.get("startDate"),
            "end": item.get("endDate"),
            "status": item.get("status"),
            "is_freeze": bool(item.get("isFreeze")),
            "is_unfreeze": bool(item.get("isUnfreeze")),
            "pause_reasons": item.get("pauseReasons") or [],
            "paused_user": item.get("pausedUser"),
            "unpaused_user": item.get("unpausedUser"),
            "stopped_user": item.get("stopedUser"),
            "paused_limiter": item.get("pausedLimiter"),
        }
        if not any(
            normalized.get(field)
            for field in ("start", "end", "status", "paused_user", "unpaused_user", "stopped_user", "paused_limiter")
        ) and not normalized["pause_reasons"]:
            continue
        rows.append(normalized)
    return rows


def _normalize_status_pause_history(payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    data = payload or {}
    intervals = _flatten_pause_tooltips(data)
    return {
        "labels": data.get("labels") or [],
        "header": data.get("header") or [],
        "series": data.get("series") or [],
        "next_page": data.get("next_page") or {},
        "tooltips": data.get("tooltips") or [],
        "intervals": intervals,
        "merged_intervals": _merge_pause_intervals(intervals),
    }


def _normalize_cluster_rows(
    stats_payload: Optional[Dict[str, Any]],
    positions_payload: Optional[Dict[str, Any]],
    additional_payload: Optional[Dict[str, Any]],
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> Dict[str, Any]:
    stats_payload = stats_payload or {}
    positions_payload = positions_payload or {}
    additional_payload = additional_payload or {}
    rows = []

    for normquery in stats_payload.get("normqueries") or []:
        normquery_id = normquery.get("normquery_id")
        position_raw = positions_payload.get(str(normquery_id))
        daily_stats = _filter_dated_mapping(
            additional_payload.get(str(normquery_id)) or {},
            start=start,
            end=end,
        )
        latest_daily_date = max(daily_stats.keys(), default=None)
        latest_daily = daily_stats.get(latest_daily_date) if latest_daily_date else None
        rows.append(
            {
                "normquery_id": normquery_id,
                "name": normquery.get("name"),
                "popularity": normquery.get("popularity"),
                "views": normquery.get("views"),
                "clicks": normquery.get("clicks"),
                "atbs": normquery.get("atbs"),
                "orders": normquery.get("orders"),
                "shks": normquery.get("shks"),
                "expense": normquery.get("expense"),
                "ctr": normquery.get("ctr"),
                "cpc": normquery.get("cpc"),
                "cr": normquery.get("cr"),
                "ocr": normquery.get("ocr"),
                "cpo": normquery.get("cpo"),
                "bid": normquery.get("bid"),
                "bid_default": normquery.get("bid_default"),
                "bid_rule_active": normquery.get("bid_rule_active"),
                "bid_rule_target_place": normquery.get("bid_rule_target_place"),
                "bid_rule_max_cpm": normquery.get("bid_rule_max_cpm"),
                "excluded": normquery.get("excluded"),
                "fixed": normquery.get("fixed"),
                "is_main": normquery.get("is_main"),
                "tags": normquery.get("tags") or [],
                "position_raw": position_raw,
                "position": abs(position_raw) if position_raw else position_raw,
                "position_is_promo": bool(position_raw and position_raw > 0),
                "latest_date": latest_daily_date,
                "latest_org_pos": latest_daily.get("org_pos") if latest_daily else None,
                "latest_promo_pos": latest_daily.get("rates_promo_pos") if latest_daily else None,
                "daily": daily_stats,
            }
        )

    rows.sort(
        key=lambda item: (
            -(float(item.get("expense") or 0)),
            -(float(item.get("views") or 0)),
            str(item.get("name") or ""),
        )
    )
    return {
        "available": bool(rows),
        "statistics_from": stats_payload.get("statistics_from"),
        "created": stats_payload.get("created"),
        "status": stats_payload.get("status"),
        "status_xway": stats_payload.get("status_xway"),
        "type": stats_payload.get("type"),
        "unified": stats_payload.get("unified"),
        "total_clusters": stats_payload.get("total_clusters"),
        "excluded": stats_payload.get("excluded"),
        "fixed": stats_payload.get("fixed"),
        "current_rules_used": stats_payload.get("current_rules_used"),
        "max_rules_available": stats_payload.get("max_rules_available"),
        "items": rows,
    }


def _additional_stats_start(period: Dict[str, Any]) -> str:
    start = _parse_iso_date(period.get("current_start"))
    end = _parse_iso_date(period.get("current_end"))
    if not start or not end:
        return period.get("current_start")
    span_days = (end - start).days + 1
    if span_days <= 30:
        return start.isoformat()
    return (end - timedelta(days=30)).isoformat()


def _normalize_cluster_action_history(
    campaign: Dict[str, Any],
    cluster: Dict[str, Any],
    rows: Optional[List[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    history = []
    for row in rows or []:
        ts = row.get("ts") or row.get("datetime") or row.get("created") or row.get("created_at") or row.get("date") or ""
        history.append(
            {
                "ts": ts,
                "ts_sort": row.get("ts_sort") or row.get("datetime_sort") or row.get("created_at") or row.get("created") or ts or None,
                "action": row.get("action") or row.get("message") or row.get("status") or row.get("type") or "Действие",
                "author": row.get("author") or row.get("user") or row.get("username") or row.get("initiator") or "—",
                "campaign_id": campaign.get("id"),
                "campaign_name": campaign.get("name"),
                "normquery_id": cluster.get("normquery_id"),
                "cluster_name": cluster.get("name"),
            }
        )
    history = [row for row in history if row.get("ts") or row.get("action")]
    history.sort(key=lambda row: row.get("ts_sort") or row.get("ts") or "", reverse=True)
    return history


def _catalog_campaign_status_label(status_code: Optional[str]) -> Optional[str]:
    normalized = str(status_code or "").strip().upper()
    if not normalized:
        return None
    return {
        "ACTIVE": "Активна",
        "PAUSED": "Пауза",
        "FROZEN": "Заморожена",
    }.get(normalized, normalized)


def _extract_catalog_campaign_status_code(raw_value: Any) -> Optional[str]:
    if isinstance(raw_value, dict):
        raw_value = raw_value.get("status")
    if raw_value in (None, ""):
        return None
    normalized = str(raw_value).strip().upper()
    return normalized or None


def _catalog_number_or_none(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def _catalog_first_number(*values: Any) -> Optional[float]:
    for value in values:
        numeric = _catalog_number_or_none(value)
        if numeric is not None:
            return numeric
    return None


def _normalize_catalog_spend_limit_period(period: Any) -> str:
    value = str(period or "").lower()
    if "day" in value or "дн" in value:
        return "day"
    if "week" in value or "нед" in value:
        return "week"
    if "month" in value or "мес" in value:
        return "month"
    return value


def _catalog_values_as_list(value: Any) -> List[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return list(value.values())
    return []


def _catalog_campaign_slot_for_row(row: Dict[str, Any]) -> str:
    text = " ".join(
        str(row.get(field) or "").lower()
        for field in ("payment_type", "paymentType", "name", "auction_mode", "auto_type", "type", "kind", "zone", "placement")
    )
    is_cpc = bool(re.search(r"cpc|click|клик", text))
    is_unified = bool(row.get("unified")) or bool(re.search(r"unified|auto|единая", text))
    is_recom = bool(row.get("recom") or row.get("is_recom") or row.get("recommendation")) or bool(re.search(r"recom|recommend|реком", text))
    if is_cpc:
        return "cpc"
    if is_unified:
        return "unified"
    return "manual_recom" if is_recom else "manual_search"


def _catalog_chart_campaign_type_for_row(row: Dict[str, Any]) -> str:
    slot = _catalog_campaign_slot_for_row(row or {})
    if slot == "cpc":
        return "cpc"
    if slot == "unified":
        return "cpm-unified"
    return "cpm-manual"


def _clone_catalog_chart_campaign_type_orders(value: Any) -> Dict[str, float]:
    if not isinstance(value, dict):
        return {}
    result: Dict[str, float] = {}
    for key, raw_value in value.items():
        numeric = _catalog_chart_number(raw_value)
        if numeric > 0:
            result[str(key)] = numeric
    return result


def _add_catalog_chart_campaign_type_order(target: Dict[str, Any], type_key: str, value: Any) -> None:
    numeric = _catalog_chart_number(value)
    if not type_key or numeric <= 0:
        return
    bucket = target.setdefault("orders_by_campaign_type", {})
    if not isinstance(bucket, dict):
        bucket = {}
        target["orders_by_campaign_type"] = bucket
    bucket[type_key] = _catalog_chart_number(bucket.get(type_key)) + numeric


def _add_catalog_chart_campaign_type_orders(target: Dict[str, Any], source: Any) -> None:
    if not isinstance(source, dict):
        return
    for type_key, value in source.items():
        _add_catalog_chart_campaign_type_order(target, str(type_key), value)


def _is_catalog_campaign_row(source: Dict[str, Any]) -> bool:
    has_identity = any(source.get(field) is not None for field in ("id", "campaign_id", "external_id", "wb_id"))
    has_campaign_fields = any(
        field in source
        for field in (
            "status",
            "status_xway",
            "payment_type",
            "paymentType",
            "auction_mode",
            "auto_type",
            "unified",
            "budget_rule",
            "budget_rule_config",
            "limits_by_period",
        )
    )
    return has_identity and has_campaign_fields


def _collect_catalog_campaign_rows_from_source(source: Any) -> List[Dict[str, Any]]:
    if not isinstance(source, dict):
        return []
    rows: List[Dict[str, Any]] = []
    if _is_catalog_campaign_row(source):
        rows.append(source)
    for direct_key in ("campaigns", "campaign_wb", "campaigns_wb", "campaign_items", "items"):
        rows.extend([item for item in _catalog_values_as_list(source.get(direct_key)) if isinstance(item, dict)])
    by_type = source.get("campaigns_by_type")
    nested_campaigns_data = source.get("campaigns_data") if isinstance(source.get("campaigns_data"), dict) else {}
    if not isinstance(by_type, dict):
        by_type = nested_campaigns_data.get("campaigns_by_type")
    if isinstance(by_type, dict):
        for value in by_type.values():
            rows.extend([item for item in _catalog_values_as_list(value) if isinstance(item, dict)])
    return rows


def _unique_catalog_campaign_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    order: List[str] = []
    by_key: Dict[str, Dict[str, Any]] = {}

    def merge_dict(left: Any, right: Any) -> Dict[str, Any]:
        merged: Dict[str, Any] = {}
        if isinstance(left, dict):
            merged.update(left)
        if isinstance(right, dict):
            merged.update(right)
        return merged

    def merge_row(left: Dict[str, Any], right: Dict[str, Any]) -> Dict[str, Any]:
        merged = dict(left or {})
        for field, value in (right or {}).items():
            if value not in (None, ""):
                merged[field] = value
        for field in ("limits_by_period", "spend", "budget_rule", "budget_rule_config"):
            merged[field] = merge_dict((left or {}).get(field), (right or {}).get(field))
        left_limits = (left or {}).get("spend_limits")
        right_limits = (right or {}).get("spend_limits")
        if isinstance(left_limits, list) or isinstance(right_limits, list):
            seen_limits: Set[str] = set()
            merged_limits: List[Dict[str, Any]] = []
            for limit_index, limit_item in enumerate(
                [
                    *(left_limits if isinstance(left_limits, list) else []),
                    *(right_limits if isinstance(right_limits, list) else []),
                ]
            ):
                if not isinstance(limit_item, dict):
                    continue
                limit_key = json.dumps(
                    [
                        limit_item.get("period") or limit_item.get("limit_period") or limit_index,
                        limit_item.get("limit") or limit_item.get("limit_sum") or limit_item.get("value"),
                        limit_item.get("spent") or limit_item.get("spent_today") or limit_item.get("current") or limit_item.get("used"),
                        limit_item.get("active"),
                    ],
                    sort_keys=True,
                    default=str,
                )
                if limit_key in seen_limits:
                    continue
                seen_limits.add(limit_key)
                merged_limits.append(limit_item)
            merged["spend_limits"] = merged_limits
        return merged

    for index, row in enumerate(rows):
        key_value = row.get("id") or row.get("campaign_id") or row.get("external_id") or row.get("wb_id") or f"idx-{index}"
        key = str(key_value)
        if key not in by_key:
            order.append(key)
            by_key[key] = row
            continue
        by_key[key] = merge_row(by_key[key], row)
    return [by_key[key] for key in order]


def _catalog_campaign_rows_for_key(payload: Dict[str, Any], key: str, extra_sources: Optional[List[Any]] = None) -> List[Dict[str, Any]]:
    by_type = payload.get("campaigns_by_type") or {}
    candidates_by_key = {
        "unified": ["unified", "auto", "automatic"],
        "manual_search": ["manual_search", "search", "manual"],
        "manual_recom": ["manual_recom", "recom", "recommendation", "recommendations"],
        "cpc": ["cpc", "clicks"],
    }
    rows: List[Dict[str, Any]] = []
    for candidate_key in candidates_by_key.get(key, [key]):
        for item in _catalog_values_as_list(by_type.get(candidate_key)):
            if isinstance(item, dict):
                rows.append(item)
    inferred_rows = [
        row
        for source in [payload, *(extra_sources or [])]
        for row in _collect_catalog_campaign_rows_from_source(source)
        if _catalog_campaign_slot_for_row(row) == key
    ]
    return _unique_catalog_campaign_rows([*rows, *inferred_rows])


def _resolve_catalog_spend_limit_config(source: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    raw_spend = source.get("spend") or {}

    def read_spend_value(value: Any) -> Optional[float]:
        if isinstance(value, dict):
            return _catalog_first_number(
                value.get("spent"),
                value.get("spent_today"),
                value.get("current"),
                value.get("used"),
                value.get("value"),
                value.get("sum"),
                value.get("amount"),
            )
        return _catalog_first_number(value)

    def read_period_spend(period: Any) -> Optional[float]:
        if not isinstance(raw_spend, dict):
            return None
        period_text = str(period or "")
        for key in (period, period_text.upper(), period_text.lower()):
            value = read_spend_value(raw_spend.get(key))
            if value is not None:
                return value
        return None

    limits_by_period = source.get("limits_by_period") or {}
    if isinstance(limits_by_period, dict):
        for period, config in limits_by_period.items():
            if isinstance(config, dict):
                items.append(
                    {
                        "period": period,
                        "active": bool(config.get("active")),
                        "limit": _catalog_first_number(
                            config.get("limit"),
                            config.get("limit_sum"),
                            config.get("limitSum"),
                            config.get("value"),
                            config.get("sum"),
                            config.get("amount"),
                            config.get("max"),
                            config.get("max_sum"),
                        ),
                        "spent": read_period_spend(period),
                    }
                )
    raw_spend_limits = source.get("spend_limits") or []
    if isinstance(raw_spend_limits, dict):
        raw_spend_limits = raw_spend_limits.get("items") or []
    if isinstance(raw_spend_limits, list):
        for item in raw_spend_limits:
            if isinstance(item, dict):
                items.append(
                    {
                        "period": item.get("period") or item.get("limit_period"),
                        "active": bool(item.get("active")),
                        "limit": _catalog_first_number(
                            item.get("limit"),
                            item.get("limit_sum"),
                            item.get("limitSum"),
                            item.get("value"),
                            item.get("sum"),
                            item.get("amount"),
                            item.get("max"),
                            item.get("max_sum"),
                        ),
                        "spent": _catalog_first_number(
                            item.get("spent"),
                            item.get("spent_today"),
                            item.get("current"),
                            item.get("used"),
                            item.get("value_spent"),
                            item.get("spent_sum"),
                            item.get("amount_spent"),
                            read_period_spend(item.get("period") or item.get("limit_period")),
                        ),
                    }
                )
    direct_limit = _catalog_first_number(
        source.get("spend_limit"),
        source.get("day_limit"),
        source.get("daily_limit"),
        source.get("limit"),
        source.get("limit_sum"),
        source.get("spend_limit_sum"),
        source.get("daily_limit_sum"),
    )
    if direct_limit is not None or source.get("spend_limit_active"):
        direct_period = source.get("spend_limit_period") or source.get("limit_period") or "day"
        items.append(
            {
                "period": direct_period,
                "active": bool(source.get("spend_limit_active") if "spend_limit_active" in source else source.get("active")),
                "limit": direct_limit,
                "spent": _catalog_first_number(
                    source.get("spend_limit_spent"),
                    source.get("spend_limit_spent_today"),
                    source.get("day_limit_spent"),
                    source.get("daily_limit_spent"),
                    source.get("spent_today"),
                    source.get("spent_day"),
                    read_period_spend(direct_period),
                ),
            }
        )
    meaningful = [item for item in items if item.get("limit") is not None or item.get("active")]
    return (
        next((item for item in meaningful if item.get("active") and _normalize_catalog_spend_limit_period(item.get("period")) == "day"), None)
        or next((item for item in meaningful if item.get("active")), None)
        or next((item for item in meaningful if _normalize_catalog_spend_limit_period(item.get("period")) == "day"), None)
        or (meaningful[0] if meaningful else None)
    )


def _read_catalog_campaign_spend_today(source: Dict[str, Any]) -> Optional[float]:
    spend = source.get("spend") or {}

    def read_spend_value(value: Any) -> Optional[float]:
        if isinstance(value, dict):
            return _catalog_first_number(
                value.get("spent"),
                value.get("spent_today"),
                value.get("current"),
                value.get("used"),
                value.get("value"),
                value.get("sum"),
                value.get("amount"),
            )
        return _catalog_first_number(value)

    if isinstance(spend, dict):
        value = read_spend_value(spend.get("DAY"))
        if value is not None:
            return value
        value = read_spend_value(spend.get("day"))
        if value is not None:
            return value
    for key in ("spend_today", "spent_day", "spend_day", "day_spend", "today_spend", "today_expense", "expense_day", "expense_today", "spent_today"):
        value = _catalog_number_or_none(source.get(key))
        if value is not None:
            return value
    stat = source.get("stat") or source.get("metrics") or {}
    if isinstance(stat, dict):
        return _catalog_first_number(stat.get("sum"), stat.get("expense_sum"))
    return None


def _read_catalog_budget_spent_today(source: Dict[str, Any], budget_rule: Dict[str, Any]) -> Optional[float]:
    return _catalog_first_number(
        budget_rule.get("spent"),
        budget_rule.get("spent_today"),
        budget_rule.get("current"),
        budget_rule.get("used"),
        budget_rule.get("value"),
        budget_rule.get("sum"),
        budget_rule.get("amount"),
        source.get("budget_spent_today"),
        source.get("budget_spent"),
        source.get("budget_used"),
        source.get("budget_current"),
        _read_catalog_campaign_spend_today(source),
    )


def _normalize_catalog_campaign_limit_summary(raw_value: Any, campaigns: List[Dict[str, Any]]) -> Dict[str, Any]:
    sources: List[Dict[str, Any]] = []
    if isinstance(raw_value, dict):
        sources.append(raw_value)
    sources.extend(campaigns)
    budget_limits: List[float] = []
    budget_spent_values: List[float] = []
    spend_limits: List[float] = []
    spend_spent_values: List[float] = []
    budget_rule_active = False
    spend_limit_active = False
    for source in sources:
        budget_rule = source.get("budget_rule_config") or source.get("budget_rule") or {}
        if not isinstance(budget_rule, dict):
            budget_rule = {}
        budget_limit = _catalog_first_number(
            budget_rule.get("limit"),
            budget_rule.get("limit_sum"),
            budget_rule.get("limitSum"),
            budget_rule.get("max"),
            budget_rule.get("max_sum"),
            budget_rule.get("value"),
            source.get("budget_limit"),
            source.get("budget_rule_limit"),
            source.get("budget_limit_sum"),
        )
        spend_limit = _resolve_catalog_spend_limit_config(source)
        spend_today = _read_catalog_campaign_spend_today(source)
        budget_spent_today = _read_catalog_budget_spent_today(source, budget_rule)
        if budget_limit is not None and budget_limit > 0:
            budget_limits.append(budget_limit)
        if budget_spent_today is not None and budget_spent_today >= 0:
            budget_spent_values.append(budget_spent_today)
        spend_limit_spent = _catalog_number_or_none(spend_limit.get("spent") if spend_limit else None)
        if spend_limit_spent is not None and spend_limit_spent >= 0:
            spend_spent_values.append(spend_limit_spent)
        elif spend_today is not None and spend_today >= 0:
            spend_spent_values.append(spend_today)
        if spend_limit and spend_limit.get("limit") is not None and spend_limit["limit"] > 0:
            spend_limits.append(spend_limit["limit"])
        budget_rule_active = budget_rule_active or bool(budget_rule.get("active") if "active" in budget_rule else source.get("budget_rule_active"))
        spend_limit_active = spend_limit_active or bool(spend_limit.get("active") if spend_limit else source.get("spend_limit_active"))
        if (not spend_limit or spend_limit.get("limit") is None) and budget_limit is not None and budget_limit > 0:
            spend_limits.append(budget_limit)
            spend_limit_active = spend_limit_active or bool(budget_rule.get("active") if "active" in budget_rule else source.get("budget_rule_active"))
    return {
        "budget_limit": sum(budget_limits) if budget_limits else None,
        "budget_spent_today": sum(budget_spent_values) if budget_spent_values else None,
        "budget_rule_active": budget_rule_active,
        "spend_limit": sum(spend_limits) if spend_limits else None,
        "spend_spent_today": sum(spend_spent_values) if spend_spent_values else None,
        "spend_limit_active": spend_limit_active,
    }


def _normalize_catalog_campaign_states(raw: Optional[Dict[str, Any]], extra_sources: Optional[List[Any]] = None) -> List[Dict[str, Any]]:
    payload = raw or {}
    rows: List[Dict[str, Any]] = []
    for key in CATALOG_CAMPAIGN_FIELD_ORDER:
        campaigns = _catalog_campaign_rows_for_key(payload, key, extra_sources)
        status_source = next(
            (
                campaign
                for campaign in campaigns
                if _extract_catalog_campaign_status_code(campaign.get("status_xway") if campaign.get("status_xway") is not None else campaign.get("status"))
            ),
            None,
        )
        normalized_code = _extract_catalog_campaign_status_code(payload.get(key)) or _extract_catalog_campaign_status_code(
            (status_source or {}).get("status_xway") if (status_source or {}).get("status_xway") is not None else (status_source or {}).get("status")
        )
        if not normalized_code:
            continue
        meta = CATALOG_CAMPAIGN_FIELD_META.get(key) or {}
        rows.append(
            {
                "key": key,
                "label": meta.get("label") or key,
                "short_label": meta.get("short_label") or meta.get("label") or key,
                "status_code": normalized_code,
                "status_label": _catalog_campaign_status_label(normalized_code),
                "active": normalized_code == "ACTIVE",
                **_normalize_catalog_campaign_limit_summary(payload.get(key), campaigns),
            }
        )
    return rows


def _catalog_product_has_campaign_slots(product: Dict[str, Any], stat_item: Dict[str, Any]) -> bool:
    campaign_data = product.get("campaigns_data") or {}
    return bool(
        campaign_data.get("unified")
        or campaign_data.get("manual_search")
        or campaign_data.get("manual_recom")
        or campaign_data.get("cpc")
        or (stat_item.get("campaigns_count") or 0) > 0
        or (campaign_data.get("manual_count") or 0) > 0
    )


def _collect_catalog_campaign_detail_sources(
    api: XwayApi,
    shop_id: int,
    products: List[Dict[str, Any]],
    stat_map: Dict[str, Any],
) -> Tuple[Dict[str, Dict[str, Any]], int]:
    targets: List[Dict[str, Any]] = []
    for product in products:
        product_id = product.get("id")
        stat_item = stat_map.get(str(product_id), {}) if product_id is not None else {}
        if product_id is not None and _catalog_product_has_campaign_slots(product, stat_item):
            targets.append(product)

    detail_by_product_id: Dict[str, Dict[str, Any]] = {}
    error_count = 0
    if not targets:
        return detail_by_product_id, error_count

    with ThreadPoolExecutor(max_workers=min(6, len(targets))) as executor:
        future_by_product_id = {
            executor.submit(api.product_stata, shop_id, int(product["id"])): str(product["id"])
            for product in targets
            if product.get("id") is not None
        }
        for future in as_completed(future_by_product_id):
            product_id = future_by_product_id[future]
            try:
                stata = future.result() or {}
                detail_by_product_id[product_id] = {"campaign_wb": copy.deepcopy(stata.get("campaign_wb") or [])}
            except Exception:
                error_count += 1
    return detail_by_product_id, error_count


def _campaign_summary(campaign: Dict[str, Any]) -> Dict[str, Any]:
    stat = campaign.get("stat", {})
    payment_type_raw = str(campaign.get("payment_type") or "").strip().lower()
    campaign_name = str(campaign.get("name") or "").strip().lower()
    auction_mode = str(campaign.get("auction_mode") or "").strip().lower()
    auto_type = str(campaign.get("auto_type") or "").strip().lower()
    if payment_type_raw in {"cpc", "click", "clicks"}:
        payment_type = "cpc"
    elif payment_type_raw in {"cpm", "view", "views"}:
        payment_type = "cpm"
    elif re.search(r"оплата\s+за\s+клики|cpc|click|клик", " ".join([campaign_name, auction_mode, auto_type]), re.I):
        payment_type = "cpc"
    else:
        payment_type = "cpm"
    return {
        "id": campaign.get("id"),
        "wb_id": campaign.get("external_id"),
        "name": campaign.get("name"),
        "query_main": (campaign.get("query_main") or {}).get("text"),
        "status": campaign.get("status"),
        "status_xway": campaign.get("status_xway"),
        "auction_mode": campaign.get("auction_mode"),
        "auto_type": campaign.get("auto_type"),
        "payment_type": payment_type,
        "unified": campaign.get("unified"),
        "schedule_active": campaign.get("schedule_active"),
        "created": campaign.get("created"),
        "wb_created": campaign.get("wb_created"),
        "budget": campaign.get("budget"),
        "bid": campaign.get("bid"),
        "mp_bid": campaign.get("mp_bid"),
        "mp_recom_bid": campaign.get("mp_recom_bid"),
        "min_cpm": campaign.get("min_cpm"),
        "min_cpm_recom": campaign.get("min_cpm_recom"),
        "spend": campaign.get("spend"),
        "limits_by_period": campaign.get("limits_by_period"),
        "budget_rule": campaign.get("budget_rule"),
        "budget_deposit_status": campaign.get("budget_deposit_status"),
        "budget_deposit_error": campaign.get("budget_deposit_error"),
        "pause_reasons": campaign.get("pause_reasons"),
        "metrics": {
            "views": stat.get("views"),
            "clicks": stat.get("clicks"),
            "atbs": stat.get("atbs"),
            "orders": stat.get("orders"),
            "shks": stat.get("shks"),
            "rel_shks": stat.get("rel_shks"),
            "sum": stat.get("sum"),
            "sum_price": stat.get("sum_price"),
            "rel_sum_price": stat.get("rel_sum_price"),
            "ctr": stat.get("CTR"),
            "cpc": stat.get("CPC"),
            "cr": stat.get("CR"),
            "cpo": stat.get("CPO"),
            "cpo_with_rel": stat.get("CPO_with_rel"),
        },
        "raw": campaign,
    }


def _product_summary(
    article: str,
    match: Dict[str, Any],
    shop_info: Dict[str, Any],
    info: Dict[str, Any],
    stocks_rule_payload: Dict[str, Any],
    stat_item: Dict[str, Any],
    dynamics: Dict[str, Any],
    stata: Dict[str, Any],
    daily_stats: List[Dict[str, Any]],
    heatmap: Dict[str, Any],
    orders_heatmap: Dict[str, Any],
    article_sheet: Dict[str, Any],
    campaigns: List[Dict[str, Any]],
    errors: Dict[str, str],
    period: Dict[str, Any],
) -> Dict[str, Any]:
    product = match["product"]
    stat = stat_item.get("stat", {})
    spend = stat_item.get("spend", {})
    totals = stata.get("totals", {})
    daily_totals = _daily_totals(daily_stats)
    normalized_product_spend_limits = _normalize_product_spend_limits(stat_item, product, campaigns)
    normalized_stocks_rule = copy.deepcopy(product.get("stocks_rule") or {})
    if stocks_rule_payload:
        normalized_stocks_rule.update(copy.deepcopy(stocks_rule_payload))

    return {
        "article": article,
        "product_id": info.get("id"),
        "product_url": f"https://am.xway.ru/wb/shop/{shop_info['id']}/product/{info.get('id')}",
        "period": period,
        "shop": {
            "id": shop_info["id"],
            "name": shop_info["name"],
            "marketplace": shop_info.get("marketplace"),
            "tariff_code": shop_info.get("tariff_code"),
            "products_count": shop_info.get("products_count"),
            "only_api": shop_info.get("only_api"),
            "expired": shop_info.get("expired"),
            "expired_days": shop_info.get("expired_days"),
            "expire_date": shop_info.get("expire_date"),
            "expire_in": shop_info.get("expire_in"),
            "new_flow": shop_info.get("new_flow"),
            "recurrent_shop": shop_info.get("recurrent_shop"),
            "jam_status": shop_info.get("jam_status"),
        },
        "identity": {
            "name": info.get("name"),
            "name_custom": info.get("name_custom"),
            "brand": product.get("brand"),
            "category_keyword": info.get("category_keyword"),
            "vendor_code": product.get("vendor_code"),
            "subject_id": info.get("subject_id"),
            "image_url": info.get("main_image_url"),
            "created": info.get("created"),
            "group": product.get("group"),
            "disp_version": product.get("disp_version"),
            "progress_bar": product.get("progress_bar"),
            "tags": copy.deepcopy(product.get("tags") or []),
            "tags_count": len(product.get("tags") or []),
            "seo_sets": copy.deepcopy(product.get("seo_sets") or []),
            "seo_sets_count": len(product.get("seo_sets") or []),
            "ab_tests_count": len(product.get("ab_tests") or []),
        },
        "flags": {
            "enabled": info.get("enabled"),
            "is_active": product.get("is_active"),
            "ab_test_active": info.get("ab_test_active"),
            "dispatcher_enabled": product.get("dispatcher_enabled"),
            "dispatcher_errors": copy.deepcopy(product.get("dispatcher_errors") or []),
            "auto_dispatcher_is_active": info.get("auto_dispatcher_is_active"),
        },
        "stock": {
            "current": info.get("stock"),
            "list_stock": stat_item.get("stock"),
        },
        "range_metrics": {
            "budget": stat_item.get("budget"),
            "day_budget": stat_item.get("day_budget"),
            "campaigns_count": stat_item.get("campaigns_count"),
            "manual_campaigns_count": (product.get("campaigns_data") or {}).get("manual_count"),
            "ordered_report": stat_item.get("ordered_report"),
            "ordered_sum_report": stat_item.get("ordered_sum_report"),
            "ordered_dynamics_report": copy.deepcopy(stat_item.get("ordered_dynamics_report")),
            "dynamics": copy.deepcopy(stat_item.get("dynamics")),
            "spend_day": spend.get("DAY"),
            "spend_week": spend.get("WEEK"),
            "spend_month": spend.get("MONTH"),
            "spend_limits": normalized_product_spend_limits,
            "views": stat.get("views"),
            "clicks": stat.get("clicks"),
            "atbs": stat.get("atbs"),
            "orders": stat.get("orders"),
            "shks": stat.get("shks"),
            "rel_shks": stat.get("rel_shks"),
            "sum": stat.get("sum"),
            "sum_price": stat.get("sum_price"),
            "rel_sum_price": stat.get("rel_sum_price"),
            "rel_atbs": stat.get("rel_atbs"),
            "ctr": stat.get("CTR"),
            "cpc": stat.get("CPC"),
            "cr": stat.get("CR"),
            "cpo": stat.get("CPO"),
            "cpo_overall": stat.get("CPO_overall"),
            "cpo_with_rel": stat.get("CPO_with_rel"),
            "drr": stat.get("DRR"),
        },
        "operations": {
            "spend_limits": copy.deepcopy(product.get("spend_limits")),
            "stocks_rule": normalized_stocks_rule or None,
            "campaigns_data": copy.deepcopy(product.get("campaigns_data") or {}),
            "campaigns_by_type": copy.deepcopy((product.get("campaigns_data") or {}).get("campaigns_by_type") or {}),
        },
        "comparison": dynamics,
        "stata_totals": totals,
        "daily_stats": daily_stats,
        "daily_totals": daily_totals,
        "heatmap": heatmap,
        "orders_heatmap": orders_heatmap,
        "article_sheet": article_sheet,
        "catalog_campaign_states": _normalize_catalog_campaign_states(product.get("campaigns_data"), [product, stat_item, *campaigns]),
        "schedule_aggregate": _aggregate_schedule(campaigns),
        "campaigns": campaigns,
        "bid_log": sorted(
            [entry for campaign in campaigns for entry in campaign.get("bid_history", [])],
            key=lambda row: row.get("datetime_sort") or "",
            reverse=True,
        ),
        "cluster_action_log": sorted(
            [entry for campaign in campaigns for entry in campaign.get("cluster_action_history", [])],
            key=lambda row: row.get("ts_sort") or row.get("ts") or "",
            reverse=True,
        ),
        "errors": errors,
        "raw": {
            "product_list_item": product,
            "stat_item": stat_item,
            "info": info,
            "dynamics": dynamics,
            "stata": stata,
        },
    }


def _collect_single_article(
    article_key: str,
    match: Dict[str, Any],
    storage_state_path: str,
    start: Optional[str],
    end: Optional[str],
    campaign_mode: str,
    requested_heavy_ids: Set[str],
    article_sheet_rows_by_article: Dict[str, List[Dict[str, Any]]],
    article_sheet_error: Optional[str],
) -> Dict[str, Any]:
    api = XwayApi(storage_state_path, start=start, end=end)
    shop = match["shop"]
    product = match["product"]
    stat_item = match["stat_item"]
    shop_id = int(shop["id"])
    product_id = int(product["id"])

    with ThreadPoolExecutor(max_workers=4) as executor:
        future_shop_info = executor.submit(api.shop_details, shop_id)
        future_info = executor.submit(api.product_info, shop_id, product_id)
        future_stocks_rule = executor.submit(api.product_stocks_rule, shop_id, product_id)
        future_dynamics = executor.submit(api.product_dynamics, shop_id, product_id)
        future_stata = executor.submit(api.product_stata, shop_id, product_id)
        shop_info = future_shop_info.result()
        info = future_info.result()
        stocks_rule_payload, _ = _safe_call(lambda: future_stocks_rule.result(), {})
        dynamics = future_dynamics.result()
        stata = future_stata.result()

    campaign_rows = stata.get("campaign_wb", [])
    campaign_ids = [campaign.get("id") for campaign in campaign_rows if campaign.get("id") is not None]
    campaign_history_starts = {
        str(campaign.get("id")): _resolve_campaign_history_fetch_start(campaign)
        for campaign in campaign_rows
        if campaign.get("id") is not None
    }
    if campaign_mode == "summary":
        default_heavy_ids = [str(campaign_id) for campaign_id in campaign_ids[:2]]
        heavy_ids = {
            str(campaign_id)
            for campaign_id in campaign_ids
            if (
                (requested_heavy_ids and str(campaign_id) in requested_heavy_ids)
                or (not requested_heavy_ids and str(campaign_id) in default_heavy_ids)
            )
        }
    else:
        heavy_ids = {str(campaign_id) for campaign_id in campaign_ids}
    heavy_campaign_ids = [campaign_id for campaign_id in campaign_ids if str(campaign_id) in heavy_ids]
    heavy_payload_by_campaign: Dict[str, Dict[str, Any]] = {}
    aux_tasks = {
        "campaign_daily_exact": (
            lambda: api.campaign_daily_exact(
                shop_id,
                product_id,
                sorted(heavy_ids),
                start=api.range["current_start"],
                end=api.range["current_end"],
            ),
            {},
        ),
        "daily_stats": (
            lambda: api.product_stats_by_day(shop_id, product_id),
            [],
        ),
        "heatmap": (
            lambda: api.product_heat_map(shop_id, product_id, campaign_ids),
            {},
        ),
        "orders_heatmap": (
            lambda: api.product_orders_heat_map(shop_id, product_id),
            {},
        ),
    }

    aux_values: Dict[str, Any] = {}
    aux_errors: Dict[str, Optional[str]] = {}
    if heavy_campaign_ids:
        with ThreadPoolExecutor(max_workers=1 + min(4, max(1, len(heavy_campaign_ids)))) as executor:
            aux_future = executor.submit(
                _run_parallel_safe_calls,
                aux_tasks,
                4,
            )
            future_by_campaign = {
                executor.submit(
                    _collect_campaign_heavy_payload,
                    storage_state_path,
                    api.range["current_start"],
                    api.range["current_end"],
                    shop_id,
                    product_id,
                    int(campaign_id),
                    campaign_history_starts.get(str(campaign_id)),
                ): str(campaign_id)
                for campaign_id in heavy_campaign_ids
            }
            aux_values, aux_errors = aux_future.result()
            for future in as_completed(future_by_campaign):
                campaign_id_key = future_by_campaign[future]
                try:
                    heavy_payload_by_campaign[campaign_id_key] = future.result()
                except Exception as exc:  # pragma: no cover - defensive path
                    heavy_payload_by_campaign[campaign_id_key] = {
                        "errors": {"fatal": str(exc)},
                    }
    else:
        aux_values, aux_errors = _run_parallel_safe_calls(
            aux_tasks,
            max_workers=4,
        )

    campaign_daily_exact = aux_values.get("campaign_daily_exact") or {}
    daily_stats_raw = aux_values.get("daily_stats") or []
    heatmap_raw = aux_values.get("heatmap") or {}
    orders_heatmap_raw = aux_values.get("orders_heatmap") or {}
    campaign_daily_exact_error = aux_errors.get("campaign_daily_exact")
    daily_error = aux_errors.get("daily_stats")
    heatmap_error = aux_errors.get("heatmap")
    orders_heatmap_error = aux_errors.get("orders_heatmap")

    campaigns = []
    for campaign in campaign_rows:
        summary = _campaign_summary(campaign)
        campaign_id = campaign["id"]
        is_heavy = str(campaign_id) in heavy_ids
        summary["_heavy_loaded"] = is_heavy
        summary["daily_exact"] = campaign_daily_exact.get(str(campaign_id), []) if is_heavy else []
        summary["spend_limits"] = _normalize_spend_limits(campaign)
        if is_heavy:
            heavy_payload = heavy_payload_by_campaign.get(str(campaign_id), {})
            heavy_errors = heavy_payload.get("errors") or {}
            schedule_payload = heavy_payload.get("schedule_payload") or {}
            bid_history_payload = heavy_payload.get("bid_history_payload") or []
            budget_history_payload = heavy_payload.get("budget_history_payload") or []
            status_mp_payload = heavy_payload.get("status_mp_payload") or {}
            status_pause_payload = heavy_payload.get("status_pause_payload") or {}
            cluster_stats_payload = heavy_payload.get("cluster_stats_payload") or {}
            cluster_positions_payload = heavy_payload.get("cluster_positions_payload") or {}
            cluster_additional_payload = heavy_payload.get("cluster_additional_payload") or {}
            cluster_history_payload = heavy_payload.get("cluster_history_payload") or {}
            summary["schedule_config"] = _normalize_schedule(schedule_payload)
            summary["schedule_error"] = heavy_errors.get("schedule") or heavy_errors.get("fatal")
            summary["bid_history"] = _normalize_bid_history(campaign, bid_history_payload)
            summary["bid_history_error"] = heavy_errors.get("bid_history") or heavy_errors.get("fatal")
            summary["budget_history"] = _normalize_budget_history(budget_history_payload)
            summary["budget_history_error"] = heavy_errors.get("budget_history") or heavy_errors.get("fatal")
            summary["budget_rule_config"] = _normalize_budget_rule(campaign, summary["budget_history"])
            summary["status_logs"] = {
                "mp_history": _normalize_status_mp_history((status_mp_payload or {}).get("result") or []),
                "mp_next_page": (status_mp_payload or {}).get("next_page"),
                "mp_error": heavy_errors.get("status_mp") or heavy_errors.get("fatal"),
                "pause_history": _normalize_status_pause_history(status_pause_payload),
                "pause_error": heavy_errors.get("status_pause") or heavy_errors.get("fatal"),
            }
            summary["clusters"] = _normalize_cluster_rows(
                cluster_stats_payload,
                cluster_positions_payload,
                cluster_additional_payload,
                start=api.range["current_start"],
                end=api.range["current_end"],
            )
            summary["cluster_action_history"] = [
                entry
                for cluster in summary["clusters"].get("items", [])
                for entry in _normalize_cluster_action_history(
                    campaign,
                    cluster,
                    cluster_history_payload.get(str(cluster.get("normquery_id"))) or [],
                )
            ]
            summary["cluster_errors"] = {
                key: value
                for key, value in {
                    "stats": heavy_errors.get("cluster_stats") or heavy_errors.get("fatal"),
                    "positions": heavy_errors.get("cluster_positions") or heavy_errors.get("fatal"),
                    "additional": heavy_errors.get("cluster_additional") or heavy_errors.get("fatal"),
                    "history": heavy_errors.get("cluster_history") or heavy_errors.get("fatal"),
                }.items()
                if value
            }
        else:
            summary["schedule_config"] = {}
            summary["schedule_error"] = None
            summary["bid_history"] = []
            summary["bid_history_error"] = None
            summary["budget_history"] = []
            summary["budget_history_error"] = None
            summary["budget_rule_config"] = _normalize_budget_rule(campaign, [])
            summary["status_logs"] = {
                "mp_history": [],
                "mp_next_page": None,
                "mp_error": None,
                "pause_history": _normalize_status_pause_history({}),
                "pause_error": None,
            }
            summary["clusters"] = {
                "available": False,
                "items": [],
                "total_clusters": 0,
                "excluded": 0,
                "fixed": 0,
                "current_rules_used": 0,
                "max_rules_available": 0,
                "statistics_from": None,
                "created": None,
                "status": campaign.get("status"),
                "status_xway": campaign.get("status_xway"),
                "type": campaign.get("type"),
                "unified": campaign.get("unified"),
            }
            summary["cluster_errors"] = {}
            summary["cluster_action_history"] = []
        campaigns.append(summary)

    errors = {
        key: value
        for key, value in {
            "daily_stats": daily_error,
            "heatmap": heatmap_error,
            "orders_heatmap": orders_heatmap_error,
            "campaign_daily_exact": campaign_daily_exact_error,
            "article_sheet": article_sheet_error,
        }.items()
        if value
    }
    article_sheet_rows = _filter_article_sheet_rows(
        article_sheet_rows_by_article.get(article_key, []),
        start=api.range["current_start"],
        end=api.range["current_end"],
    )
    return _product_summary(
        article_key,
        match,
        shop_info,
        info,
        stocks_rule_payload or {},
        stat_item,
        dynamics,
        stata,
        _normalize_daily_stats(
            daily_stats_raw,
            start=api.range["current_start"],
            end=api.range["current_end"],
        ),
        _normalize_heatmap(heatmap_raw),
        _normalize_orders_heatmap(orders_heatmap_raw),
        _build_article_sheet_payload(article_sheet_rows, error=article_sheet_error),
        campaigns,
        errors,
        api.range,
    )


def collect_articles(
    article_ids: Iterable[str],
    storage_state_path: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    campaign_mode: str = "full",
    heavy_campaign_ids: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    requested_articles = [str(article) for article in article_ids]
    normalized_mode = "summary" if str(campaign_mode).lower() == "summary" else "full"
    requested_heavy_ids = {
        str(campaign_id)
        for campaign_id in (heavy_campaign_ids or [])
        if str(campaign_id or "").strip()
    }

    api = XwayApi(storage_state_path, start=start, end=end)
    cache_key = _products_cache_key(
        storage_state_path,
        api.range,
        requested_articles,
        normalized_mode,
        requested_heavy_ids,
    )
    cached = _get_cached_products(cache_key)
    if cached is not None:
        return cached

    found = api.find_articles(requested_articles)
    not_found: List[str] = []
    pending_articles: List[str] = []
    for article in requested_articles:
        if article in found:
            pending_articles.append(article)
        else:
            not_found.append(article)

    if normalized_mode == "full":
        article_sheet_rows_by_article, article_sheet_error = _safe_call(
            _load_article_sheet_rows_by_article,
            {},
        )
    else:
        article_sheet_rows_by_article, article_sheet_error = {}, None

    products_by_article: Dict[str, Dict[str, Any]] = {}
    if pending_articles:
        max_workers = min(4, max(1, len(pending_articles)))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_by_article = {
                executor.submit(
                    _collect_single_article,
                    article,
                    found[article],
                    storage_state_path,
                    api.range["current_start"],
                    api.range["current_end"],
                    normalized_mode,
                    requested_heavy_ids,
                    article_sheet_rows_by_article,
                    article_sheet_error,
                ): article
                for article in pending_articles
            }
            for future in as_completed(future_by_article):
                article = future_by_article[future]
                products_by_article[article] = future.result()

    products: List[Dict[str, Any]] = []
    for article in requested_articles:
        product = products_by_article.get(article)
        if product is not None:
            products.append(product)

    payload = {
        "generated_at": date.today().isoformat(),
        "range": api.range,
        "products": products,
        "not_found": not_found,
    }
    _set_cached_products(cache_key, payload)
    return payload


def _collect_shop_catalog(
    shop: Dict[str, Any],
    storage_state_path: str,
    start: str,
    end: str,
    include_extended: bool = False,
) -> Dict[str, Any]:
    shop_id = int(shop["id"])
    api = XwayApi(storage_state_path, start=start, end=end)
    listing, listing_error = _safe_call(
        lambda sid=shop_id: api.shop_listing(sid),
        {"list_wo": {}, "list_stat": {}},
    )
    shop_detail, shop_detail_error = _safe_call(
        lambda sid=shop_id: api.shop_details(sid),
        {},
    )
    list_wo = listing.get("list_wo") or {}
    list_stat = listing.get("list_stat") or {}
    shop_listing_meta = {
        "products_limit": list_wo.get("products_limit"),
        "total_products": list_wo.get("total_products"),
        "filtered_products": list_wo.get("filtered_products"),
        "disabled_products": list_wo.get("disabled_products"),
        "total_launched_ab_test": list_wo.get("total_launched_ab_test"),
        "spend_limits_by_period": copy.deepcopy(list_wo.get("spend_limits_by_period") or {}),
        "shop_spend": copy.deepcopy(list_stat.get("spend") or {}),
        "shop_totals": copy.deepcopy(list_stat.get("totals") or {}),
    }
    shop_detail_snapshot = _snapshot_fields(shop_detail, SHOP_DETAIL_SAFE_FIELDS) if include_extended else {}
    products = (listing.get("list_wo") or {}).get("products_wb") or []
    stat_map = (listing.get("list_stat") or {}).get("products_wb") or {}
    campaign_detail_sources, campaign_detail_error_count = _collect_catalog_campaign_detail_sources(api, shop_id, products, stat_map)
    shop_articles: List[Dict[str, Any]] = []
    for product in products:
        article = str(product.get("external_id") or "").strip()
        if not article:
            continue
        product_id = product.get("id")
        campaign_data = product.get("campaigns_data") or {}
        stat_item = stat_map.get(str(product_id), {}) if product_id is not None else {}
        campaign_detail_source = campaign_detail_sources.get(str(product_id)) if product_id is not None else None
        stat = stat_item.get("stat") or {}
        spend = stat_item.get("spend") or {}
        article_payload = {
            "article": article,
            "product_id": product_id,
            "name": product.get("name_custom") or product.get("name") or "",
            "brand": product.get("brand") or "",
            "vendor_code": product.get("vendor_code") or "",
            "category_keyword": product.get("category_keyword") or "",
            "image_url": product.get("main_image_url") or "",
            "enabled": product.get("enabled"),
            "is_active": product.get("is_active"),
            "stock": stat_item.get("stock"),
            "campaigns_count": stat_item.get("campaigns_count"),
            "campaign_states": _normalize_catalog_campaign_states(campaign_data, [product, stat_item, campaign_detail_source]),
            "manual_campaigns_count": campaign_data.get("manual_count"),
            "expense_sum": stat.get("sum"),
            "views": stat.get("views"),
            "clicks": stat.get("clicks"),
            "atbs": stat.get("atbs"),
            "orders": stat.get("orders"),
            "sum_price": stat.get("sum_price"),
            "ctr": stat.get("CTR"),
            "cpc": stat.get("CPC"),
            "cr": stat.get("CR"),
            "cpo": stat.get("CPO"),
            "cpo_overall": stat.get("CPO_overall"),
            "cpo_with_rel": stat.get("CPO_with_rel"),
            "drr": stat.get("DRR"),
            "budget": stat_item.get("budget"),
            "day_budget": stat_item.get("day_budget"),
            "ordered_report": stat_item.get("ordered_report"),
            "ordered_sum_report": stat_item.get("ordered_sum_report"),
            "spend_day": spend.get("DAY"),
            "spend_week": spend.get("WEEK"),
            "spend_month": spend.get("MONTH"),
            "dispatcher_enabled": stat_item.get("dispatcher_enabled", product.get("dispatcher_enabled")),
            "group": product.get("group"),
            "subject_id": product.get("subject_id"),
            "disp_version": product.get("disp_version"),
            "ab_test_active": product.get("ab_test_active"),
            "ab_tests_count": len(product.get("ab_tests") or []),
            "tags_count": len(product.get("tags") or []),
            "seo_sets_count": len(product.get("seo_sets") or []),
            "shop_url": f"https://am.xway.ru/wb/shop/{shop_id}",
            "product_url": (
                f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}"
                if product_id is not None
                else None
            ),
        }
        if include_extended:
            article_payload.update(
                {
                    "progress_bar": copy.deepcopy(product.get("progress_bar")),
                    "dispatcher_errors": copy.deepcopy(product.get("dispatcher_errors") or []),
                    "spend_limits": copy.deepcopy(product.get("spend_limits")),
                    "stocks_rule": copy.deepcopy(product.get("stocks_rule")),
                    "ordered_dynamics_report": copy.deepcopy(stat_item.get("ordered_dynamics_report")),
                    "dynamics": copy.deepcopy(stat_item.get("dynamics")),
                    "campaigns_data": copy.deepcopy(campaign_data),
                    "campaigns_by_type": copy.deepcopy((campaign_data or {}).get("campaigns_by_type") or {}),
                    "listing_product_snapshot": _snapshot_fields(product, SHOP_PRODUCT_SAFE_FIELDS),
                    "listing_stat_snapshot": _snapshot_fields(stat_item, SHOP_STAT_SAFE_FIELDS),
                }
            )
        shop_articles.append(article_payload)
    shop_articles.sort(key=lambda item: (item["name"].lower(), item["article"]))
    shop_payload = {
        "id": shop_id,
        "name": shop.get("name") or f"Кабинет {shop_id}",
        "marketplace": shop.get("marketplace"),
        "tariff_code": shop.get("tariff_code"),
        "only_api": shop.get("only_api"),
        "expired_days": shop.get("expired_days"),
        "shop_url": f"https://am.xway.ru/wb/shop/{shop_id}",
        "balance": shop_detail.get("balance"),
        "bonus": shop_detail.get("bonus"),
        "cashback": shop_detail.get("cashback"),
        "expired": shop_detail.get("expired"),
        "expire_in": shop_detail.get("expire_in"),
        "expire_date": shop_detail.get("expire_date"),
        "recurrent_shop": shop_detail.get("recurrent_shop"),
        "new_flow": shop_detail.get("new_flow"),
        "jam_status": shop_detail.get("jam_status"),
        "use_cashback": shop_detail.get("use_cashback"),
        "has_limit": shop_detail.get("has_limit"),
        "limit_q": shop_detail.get("limit_q"),
        "fact_q": shop_detail.get("fact_q"),
        "requests_num": shop_detail.get("requests_num"),
        "top_up_balance_type_code": shop_detail.get("top_up_balance_type_code"),
        "listing_meta": shop_listing_meta,
        "campaign_limit_details_loaded": len(campaign_detail_sources),
        "campaign_limit_details_errors": campaign_detail_error_count,
        "shop_detail_error": shop_detail_error,
        "products_count": len(shop_articles),
        "listing_error": listing_error,
        "articles": shop_articles,
    }
    if include_extended:
        shop_payload.update(
            {
                "selected_contract": copy.deepcopy(shop_detail.get("selected_contract")),
                "selected_contract_secondary": copy.deepcopy(shop_detail.get("selected_contract_secondary")),
                "contracts": copy.deepcopy(shop_detail.get("contracts") or []),
                "tariffs": copy.deepcopy(shop_detail.get("tariffs") or []),
                "top_up_balance_type": copy.deepcopy(shop_detail.get("top_up_balance_type")),
                "top_up_balance_type_secondary": copy.deepcopy(shop_detail.get("top_up_balance_type_secondary")),
                "top_up_balance_type_secondary_code": shop_detail.get("top_up_balance_type_secondary_code"),
                "detail_snapshot": shop_detail_snapshot,
            }
        )
    return shop_payload


def collect_catalog(
    storage_state_path: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    mode: str = "compact",
) -> Dict[str, Any]:
    normalized_mode = "full" if str(mode).lower() == "full" else "compact"
    include_extended = normalized_mode == "full"
    api = XwayApi(storage_state_path, start=start, end=end)
    range_payload = api.range
    cache_key = _catalog_cache_key(storage_state_path, range_payload, normalized_mode)
    cached = _get_cached_catalog(cache_key)
    if cached is not None:
        return cached

    shops = api.list_shops()
    max_workers = min(8, max(1, len(shops)))
    catalog_shops: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(
                _collect_shop_catalog,
                shop,
                storage_state_path,
                range_payload["current_start"],
                range_payload["current_end"],
                include_extended=include_extended,
            )
            for shop in shops
        ]
        for future in as_completed(futures):
            catalog_shops.append(future.result())

    total_articles = sum(shop_payload.get("products_count", 0) for shop_payload in catalog_shops)
    def _as_float(value: Any) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0
    totals = {
        "expense_sum": 0.0,
        "orders": 0.0,
        "atbs": 0.0,
        "clicks": 0.0,
        "views": 0.0,
    }
    for shop_payload in catalog_shops:
        shop_totals = ((shop_payload.get("listing_meta") or {}).get("shop_totals") or {})
        totals["expense_sum"] += _as_float(shop_totals.get("sum"))
        totals["orders"] += _as_float(shop_totals.get("orders"))
        totals["atbs"] += _as_float(shop_totals.get("atbs"))
        totals["clicks"] += _as_float(shop_totals.get("clicks"))
        totals["views"] += _as_float(shop_totals.get("views"))
    catalog_shops.sort(key=lambda item: (item["name"].lower(), item["id"]))
    payload = {
        "generated_at": date.today().isoformat(),
        "mode": normalized_mode,
        "range": range_payload,
        "total_shops": len(catalog_shops),
        "total_articles": total_articles,
        "totals": totals,
        "shops": catalog_shops,
    }
    _set_cached_catalog(cache_key, payload)
    return payload


def _parse_catalog_product_refs(product_refs: Iterable[str]) -> List[Tuple[int, int, str]]:
    parsed: List[Tuple[int, int, str]] = []
    seen: Set[str] = set()
    for value in product_refs:
        text = str(value or "").strip()
        if not text or text in seen or ":" not in text:
            continue
        shop_raw, product_raw = text.split(":", 1)
        try:
            shop_id = int(shop_raw)
            product_id = int(product_raw)
        except ValueError:
            continue
        parsed.append((shop_id, product_id, text))
        seen.add(text)
    return parsed


def _catalog_chart_rate(numerator: float, denominator: float) -> Optional[float]:
    return (numerator / denominator) * 100 if denominator else None


def _catalog_chart_number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _create_catalog_chart_row(day: str) -> Dict[str, Any]:
    return {
        "day": day,
        "day_label": _format_day(day),
        "views": 0.0,
        "clicks": 0.0,
        "atbs": 0.0,
        "orders": 0.0,
        "ordered_total": 0.0,
        "avg_stock": 0.0,
        "expense_sum": 0.0,
        "sum_price": 0.0,
        "rel_sum_price": 0.0,
        "rel_shks": 0.0,
        "rel_atbs": 0.0,
        "ordered_sum_total": 0.0,
        "spent_sku_count": 0,
        "orders_by_campaign_type": {},
    }


def _finalize_catalog_chart_row(row: Dict[str, Any]) -> Dict[str, Any]:
    views = _catalog_chart_number(row.get("views"))
    clicks = _catalog_chart_number(row.get("clicks"))
    atbs = _catalog_chart_number(row.get("atbs"))
    orders = _catalog_chart_number(row.get("orders"))
    ordered_total = _catalog_chart_number(row.get("ordered_total"))
    avg_stock = _catalog_chart_number(row.get("avg_stock"))
    expense_sum = _catalog_chart_number(row.get("expense_sum"))
    sum_price = _catalog_chart_number(row.get("sum_price"))
    rel_sum_price = _catalog_chart_number(row.get("rel_sum_price"))
    rel_shks = _catalog_chart_number(row.get("rel_shks"))
    rel_atbs = _catalog_chart_number(row.get("rel_atbs"))
    ordered_sum_total = _catalog_chart_number(row.get("ordered_sum_total"))
    spent_sku_count = int(row.get("spent_sku_count") or 0)
    orders_by_campaign_type = _clone_catalog_chart_campaign_type_orders(row.get("orders_by_campaign_type"))
    return {
        **row,
        "views": views,
        "clicks": clicks,
        "atbs": atbs,
        "orders": orders,
        "ordered_total": ordered_total,
        "avg_stock": avg_stock,
        "expense_sum": expense_sum,
        "sum_price": sum_price,
        "rel_sum_price": rel_sum_price,
        "rel_shks": rel_shks,
        "rel_atbs": rel_atbs,
        "ordered_sum_total": ordered_sum_total,
        "spent_sku_count": spent_sku_count,
        "orders_by_campaign_type": orders_by_campaign_type,
        "ctr": _catalog_chart_rate(clicks, views),
        "cr1": _catalog_chart_rate(atbs, clicks),
        "cr2": _catalog_chart_rate(orders, atbs),
        "crf": _catalog_chart_rate(orders, clicks),
        "cr_total": _catalog_chart_rate(ordered_total, views),
        "drr_total": _catalog_chart_rate(expense_sum, ordered_sum_total),
        "drr_ads": _catalog_chart_rate(expense_sum, sum_price),
    }


def _catalog_chart_totals(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    totals = {
        "views": 0.0,
        "clicks": 0.0,
        "atbs": 0.0,
        "orders": 0.0,
        "ordered_total": 0.0,
        "avg_stock": 0.0,
        "expense_sum": 0.0,
        "sum_price": 0.0,
        "rel_sum_price": 0.0,
        "rel_shks": 0.0,
        "rel_atbs": 0.0,
        "ordered_sum_total": 0.0,
        "orders_by_campaign_type": {},
    }
    for row in rows:
        totals["views"] += _catalog_chart_number(row.get("views"))
        totals["clicks"] += _catalog_chart_number(row.get("clicks"))
        totals["atbs"] += _catalog_chart_number(row.get("atbs"))
        totals["orders"] += _catalog_chart_number(row.get("orders"))
        totals["ordered_total"] += _catalog_chart_number(row.get("ordered_total"))
        totals["avg_stock"] += _catalog_chart_number(row.get("avg_stock"))
        totals["expense_sum"] += _catalog_chart_number(row.get("expense_sum"))
        totals["sum_price"] += _catalog_chart_number(row.get("sum_price"))
        totals["rel_sum_price"] += _catalog_chart_number(row.get("rel_sum_price"))
        totals["rel_shks"] += _catalog_chart_number(row.get("rel_shks"))
        totals["rel_atbs"] += _catalog_chart_number(row.get("rel_atbs"))
        totals["ordered_sum_total"] += _catalog_chart_number(row.get("ordered_sum_total"))
        _add_catalog_chart_campaign_type_orders(totals, row.get("orders_by_campaign_type"))
    return {
        **totals,
        "orders_by_campaign_type": _clone_catalog_chart_campaign_type_orders(totals.get("orders_by_campaign_type")),
        "ctr": _catalog_chart_rate(totals["clicks"], totals["views"]),
        "cr1": _catalog_chart_rate(totals["atbs"], totals["clicks"]),
        "cr2": _catalog_chart_rate(totals["orders"], totals["atbs"]),
        "crf": _catalog_chart_rate(totals["orders"], totals["clicks"]),
        "cr_total": _catalog_chart_rate(totals["ordered_total"], totals["views"]),
        "drr_total": _catalog_chart_rate(totals["expense_sum"], totals["ordered_sum_total"]),
        "drr_ads": _catalog_chart_rate(totals["expense_sum"], totals["sum_price"]),
    }


def _issue_number(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if numeric == numeric else None


def _issue_number_or_zero(value: Any) -> float:
    numeric = _issue_number(value)
    return numeric if numeric is not None else 0.0


def _compute_issue_drr(spend: Any, revenue: Any) -> Optional[float]:
    spend_value = _issue_number(spend)
    revenue_value = _issue_number(revenue)
    if spend_value is None or revenue_value is None or revenue_value <= 0:
        return None
    return (spend_value / revenue_value) * 100


def _split_pause_reason_tokens(values: Any) -> List[str]:
    source = values if isinstance(values, list) else [values]
    tokens: List[str] = []
    for value in source:
        for part in re.split(r"[;,/]", str(value or "")):
            normalized = part.strip()
            if normalized:
                tokens.append(normalized)
    return tokens


def _resolve_issue_pause_reason_kinds(item: Dict[str, Any]) -> List[str]:
    tokens = [
        *_split_pause_reason_tokens(item.get("pause_reasons") or []),
        *_split_pause_reason_tokens(item.get("paused_limiter")),
    ]
    joined = " ".join(token.lower() for token in tokens)
    result: List[str] = []
    if re.search(r"budget|бюджет|money|баланс|остаток|fund", joined):
        result.append("budget")
    if re.search(r"campaign_limiter|spend_limit|day_limit|daily_limit|limit|лимит|день|day", joined):
        result.append("limit")
    return result


def _resolve_issue_activity_status_key(item: Dict[str, Any]) -> str:
    if item.get("is_freeze"):
        return "freeze"
    status = str(item.get("status") or "").lower()
    reasons = " ".join(
        str(token or "").lower()
        for token in [*(item.get("pause_reasons") or []), item.get("paused_limiter")]
    )
    if re.search(r"актив|active", status):
        return "active"
    if (
        re.search(r"приост|pause|paused|stop|неактив|inactive", status)
        or re.search(r"schedule|распис|budget|бюджет|limit|лимит", reasons)
        or bool(item.get("paused_limiter"))
        or bool(item.get("paused_user"))
    ):
        return "paused"
    return "unknown"


def _campaign_issue_intervals(campaign: Dict[str, Any]) -> List[Dict[str, Any]]:
    pause_history = ((campaign.get("status_logs") or {}).get("pause_history") or {})
    intervals = pause_history.get("intervals")
    if isinstance(intervals, list):
        return intervals
    merged = pause_history.get("merged_intervals")
    return merged if isinstance(merged, list) else []


def _issue_day_label(day: str) -> str:
    try:
        parsed = date.fromisoformat(day)
    except ValueError:
        return day
    weekday = WEEKDAYS[parsed.weekday()][1].lower()
    return f"{weekday} {parsed.strftime('%d.%m')}"


def _build_campaign_issue_status_day(campaign: Dict[str, Any], day: str) -> Dict[str, Any]:
    day_date = date.fromisoformat(day)
    day_start = datetime.combine(day_date, datetime.min.time())
    day_end = datetime.combine(day_date, datetime.max.time())
    entries: List[Dict[str, Any]] = []

    for item in _campaign_issue_intervals(campaign):
        start_at, end_at = _resolve_pause_interval_bounds(item)
        if start_at is None or end_at is None or start_at > day_end or end_at < day_start:
            continue
        effective_start = max(start_at, day_start)
        effective_end = min(end_at, day_end)
        entries.append(
            {
                "key": _resolve_issue_activity_status_key(item),
                "startTime": effective_start.strftime("%H:%M"),
                "endTime": None if effective_end >= day_end else effective_end.strftime("%H:%M"),
                "issueKinds": _resolve_issue_pause_reason_kinds(item) if not item.get("is_freeze") else [],
            }
        )

    entries.sort(key=lambda entry: entry["startTime"])
    return {"day": day, "label": _issue_day_label(day), "entries": entries}


def _parse_issue_clock_to_minutes(value: Any, end_of_day: bool = False) -> int:
    if not value:
        return 24 * 60 if end_of_day else 0
    parts = str(value).split(":")
    try:
        hours = int(parts[0] or 0)
        minutes = int(parts[1] or 0) if len(parts) > 1 else 0
    except ValueError:
        return 24 * 60 if end_of_day else 0
    return hours * 60 + minutes


def _build_campaign_issue_summaries(campaign: Dict[str, Any], status_days: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    summaries: Dict[str, Dict[str, Any]] = {}
    total_stopped_hours_by_day: Dict[str, float] = {}
    daily_expense_by_day = {
        str(row.get("day")): _issue_number(row.get("expense_sum"))
        for row in sorted(campaign.get("daily_exact") or [], key=lambda item: str(item.get("day") or ""))
    }
    positive_expenses = [value for value in daily_expense_by_day.values() if value is not None and value > 0]
    average_hourly_spend_fallback = sum(positive_expenses) / (len(positive_expenses) * 24) if positive_expenses else 0

    for day_payload in status_days:
        for entry in day_payload.get("entries") or []:
            if entry.get("key") == "active":
                continue
            start_minutes = _parse_issue_clock_to_minutes(entry.get("startTime"))
            end_minutes = _parse_issue_clock_to_minutes(entry.get("endTime"), True)
            duration_hours = max(end_minutes - start_minutes, 0) / 60
            if duration_hours > 0:
                day_key = day_payload["day"]
                total_stopped_hours_by_day[day_key] = total_stopped_hours_by_day.get(day_key, 0) + duration_hours

    for day_payload in status_days:
        for entry in day_payload.get("entries") or []:
            issue_kinds = entry.get("issueKinds") or []
            if not issue_kinds or entry.get("key") == "active":
                continue
            start_minutes = _parse_issue_clock_to_minutes(entry.get("startTime"))
            end_minutes = _parse_issue_clock_to_minutes(entry.get("endTime"), True)
            duration_hours = max(end_minutes - start_minutes, 0) / 60
            if duration_hours <= 0:
                continue
            for kind in issue_kinds:
                current = summaries.setdefault(
                    kind,
                    {
                        "kind": kind,
                        "label": "Израсходован лимит" if kind == "limit" else "Нет бюджета",
                        "hours": 0.0,
                        "incidents": 0,
                        "days": [],
                    },
                )
                current["hours"] += duration_hours
                current["incidents"] += 1
                day_entry = next((item for item in current["days"] if item["day"] == day_payload["day"]), None)
                if day_entry is None:
                    day_entry = {
                        "day": day_payload["day"],
                        "label": day_payload["label"],
                        "hours": 0.0,
                        "incidents": 0,
                        "estimatedGap": None,
                    }
                    current["days"].append(day_entry)
                day_entry["hours"] += duration_hours
                day_entry["incidents"] += 1

    result: List[Dict[str, Any]] = []
    for kind in ("budget", "limit"):
        summary = summaries.get(kind)
        if not summary:
            continue
        days: List[Dict[str, Any]] = []
        for day_entry in summary["days"]:
            total_stopped_hours = total_stopped_hours_by_day.get(day_entry["day"], 0)
            active_hours = max(24 - total_stopped_hours, 0)
            daily_expense = daily_expense_by_day.get(day_entry["day"])
            estimated_gap = None
            if daily_expense is not None and daily_expense > 0 and active_hours > 0:
                estimated_gap = (daily_expense / active_hours) * day_entry["hours"]
            elif average_hourly_spend_fallback > 0:
                estimated_gap = average_hourly_spend_fallback * day_entry["hours"]
            days.append({**day_entry, "estimatedGap": estimated_gap})
        estimated_values = [
            day_entry["estimatedGap"]
            for day_entry in days
            if isinstance(day_entry.get("estimatedGap"), (int, float))
        ]
        result.append(
            {
                **summary,
                "estimatedGapTotal": sum(estimated_values) if estimated_values else None,
                "days": sorted(days, key=lambda item: item["day"]),
            }
        )
    return result


def _format_issue_campaign_name(campaign: Dict[str, Any]) -> str:
    campaign_id = campaign.get("id")
    name = str(campaign.get("name") or "").strip()
    return f"РК {campaign_id} · {name}" if name else f"РК {campaign_id}"


def _resolve_issue_campaign_payment_type(campaign: Dict[str, Any]) -> str:
    payment_type = str(campaign.get("payment_type") or "").strip().lower()
    source = " ".join(
        str(campaign.get(field) or "").strip().lower()
        for field in ("name", "auction_mode", "auto_type")
    )
    if payment_type in {"cpc", "click", "clicks"} or re.search(r"оплата\s+за\s+клики|cpc|click|клик", source):
        return "cpc"
    return "cpm"


def _resolve_issue_campaign_zone_kind(campaign: Dict[str, Any]) -> str:
    auction_mode = str(campaign.get("auction_mode") or "").strip().lower()
    auto_type = str(campaign.get("auto_type") or "").strip().lower()
    name = str(campaign.get("name") or "").strip().lower()
    payment_type = str(campaign.get("payment_type") or "").strip().lower()
    search_signal = _issue_number(campaign.get("min_cpm")) is not None or _issue_number(campaign.get("mp_bid")) is not None
    recom_signal = _issue_number(campaign.get("min_cpm_recom")) is not None or _issue_number(campaign.get("mp_recom_bid")) is not None
    source = " ".join(item for item in (auction_mode, auto_type, name) if item)

    if campaign.get("unified"):
        return "both"
    if re.search(r"search[_\s-]*recom|recom[_\s-]*search|searchrecom|поиск.*реком|реком.*поиск", auction_mode):
        return "both"
    if re.search(r"recom|recommend|реком", auction_mode):
        return "recom"
    if re.search(r"search|поиск", auction_mode) or "cpc" in payment_type or "click" in payment_type or "клик" in payment_type:
        return "search"
    has_search = search_signal or bool(re.search(r"search|поиск", source))
    has_recom = recom_signal or bool(re.search(r"recom|recommend|реком", source))
    if has_search and has_recom:
        return "both"
    return "recom" if has_recom else "search"


def _issue_campaign_status_code(campaign: Dict[str, Any]) -> Optional[str]:
    raw = campaign.get("status_xway") if campaign.get("status_xway") is not None else campaign.get("status")
    normalized = str(raw or "").strip().upper()
    return normalized or None


def _issue_campaign_status_label(status_code: Optional[str]) -> Optional[str]:
    if not status_code:
        return None
    return {"ACTIVE": "Активна", "PAUSED": "Пауза", "FROZEN": "Заморожена"}.get(status_code, status_code)


def _issue_campaign_display_status(status_code: Optional[str]) -> str:
    normalized = str(status_code or "").strip().upper()
    normalized_lower = normalized.lower()
    if normalized == "ACTIVE" or re.search(r"(^|\s)актив", normalized_lower):
        return "active"
    if normalized == "FROZEN" or re.search(r"заморож|freeze|frozen", normalized_lower):
        return "freeze"
    if normalized == "PAUSED" or re.search(r"приост|pause|paused|stop|неактив", normalized_lower):
        return "paused"
    return "muted"


def _collect_issue_campaign_day_metrics(campaign: Dict[str, Any], day: str) -> Dict[str, float]:
    totals = {"orders_ads": 0.0, "spend": 0.0, "revenue_ads": 0.0}
    for row in campaign.get("daily_exact") or []:
        if str(row.get("day") or "") != day:
            continue
        totals["orders_ads"] += _issue_number_or_zero(row.get("orders"))
        totals["spend"] += _issue_number_or_zero(row.get("expense_sum"))
        totals["revenue_ads"] += _issue_number_or_zero(row.get("sum_price"))
    return totals


def _collect_issue_product_day_metrics(rows: List[Dict[str, Any]], day: str) -> Dict[str, float]:
    totals = {"total_orders": 0.0, "total_revenue": 0.0}
    for row in rows or []:
        if str(row.get("day") or "") != day:
            continue
        totals["total_orders"] += _issue_number_or_zero(row.get("ordered_total"))
        totals["total_revenue"] += _issue_number_or_zero(row.get("ordered_sum_total"))
    return totals


def _build_issue_campaign_meta(campaign: Dict[str, Any], metrics: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    metrics = metrics or {}
    status_code = _issue_campaign_status_code(campaign)
    return {
        "id": int(campaign.get("id") or 0),
        "label": _format_issue_campaign_name(campaign),
        "payment_type": _resolve_issue_campaign_payment_type(campaign),
        "zone_kind": _resolve_issue_campaign_zone_kind(campaign),
        "status_code": status_code,
        "status_label": _issue_campaign_status_label(status_code),
        "display_status": _issue_campaign_display_status(status_code),
        "hours": metrics.get("hours") if isinstance(metrics.get("hours"), (int, float)) else 0,
        "incidents": metrics.get("incidents") if isinstance(metrics.get("incidents"), (int, float)) else 0,
        "orders_ads": metrics.get("orders_ads") if isinstance(metrics.get("orders_ads"), (int, float)) else 0,
        "drr": metrics.get("drr") if isinstance(metrics.get("drr"), (int, float)) else None,
        "estimated_gap": metrics.get("estimated_gap") if isinstance(metrics.get("estimated_gap"), (int, float)) and metrics.get("estimated_gap") > 0 else None,
    }


def _aggregate_catalog_issue_summaries(
    campaigns: List[Dict[str, Any]],
    product_daily_stats: List[Dict[str, Any]],
    day: str,
) -> List[Dict[str, Any]]:
    product_day_metrics = _collect_issue_product_day_metrics(product_daily_stats, day)
    aggregated: Dict[str, Dict[str, Any]] = {}
    for campaign in campaigns or []:
        campaign_issues = _build_campaign_issue_summaries(campaign, [_build_campaign_issue_status_day(campaign, day)])
        campaign_day_metrics = _collect_issue_campaign_day_metrics(campaign, day)
        campaign_drr = _compute_issue_drr(campaign_day_metrics["spend"], campaign_day_metrics["revenue_ads"])
        for summary in campaign_issues:
            day_entry = next((entry for entry in summary.get("days") or [] if entry.get("day") == day), None)
            if not day_entry:
                continue
            current = aggregated.setdefault(
                summary["kind"],
                {
                    "kind": summary["kind"],
                    "title": summary["label"],
                    "hours": 0.0,
                    "incidents": 0,
                    "orders_ads": 0.0,
                    "total_orders": product_day_metrics["total_orders"],
                    "drr_overall": None,
                    "spend": 0.0,
                    "estimated_gap": 0.0,
                    "campaign_ids": [],
                    "campaign_labels": [],
                    "campaigns": [],
                    "campaign_id_set": set(),
                    "campaign_label_set": set(),
                },
            )
            current["hours"] += _issue_number_or_zero(day_entry.get("hours"))
            current["incidents"] += int(day_entry.get("incidents") or 0)
            current["orders_ads"] += campaign_day_metrics["orders_ads"]
            current["spend"] += campaign_day_metrics["spend"]
            if day_entry.get("estimatedGap") is not None:
                current["estimated_gap"] += _issue_number_or_zero(day_entry.get("estimatedGap"))

            campaign_id = campaign.get("id")
            if campaign_id not in current["campaign_id_set"]:
                current["campaign_id_set"].add(campaign_id)
                current["campaign_ids"].append(campaign_id)
                current["campaigns"].append(
                    _build_issue_campaign_meta(
                        campaign,
                        {
                            "hours": day_entry.get("hours"),
                            "incidents": day_entry.get("incidents"),
                            "orders_ads": campaign_day_metrics["orders_ads"],
                            "drr": campaign_drr,
                            "estimated_gap": day_entry.get("estimatedGap"),
                        },
                    )
                )
            else:
                current_campaign = next((item for item in current["campaigns"] if item["id"] == int(campaign_id or 0)), None)
                if current_campaign:
                    current_campaign["hours"] += _issue_number_or_zero(day_entry.get("hours"))
                    current_campaign["incidents"] += int(day_entry.get("incidents") or 0)
                    current_campaign["orders_ads"] += campaign_day_metrics["orders_ads"]
                    current_campaign["drr"] = campaign_drr if campaign_drr is not None else current_campaign.get("drr")
                    if day_entry.get("estimatedGap") is not None:
                        current_campaign["estimated_gap"] = _issue_number_or_zero(current_campaign.get("estimated_gap")) + _issue_number_or_zero(day_entry.get("estimatedGap"))

            campaign_label = _format_issue_campaign_name(campaign)
            if campaign_label not in current["campaign_label_set"]:
                current["campaign_label_set"].add(campaign_label)
                current["campaign_labels"].append(campaign_label)

    result: List[Dict[str, Any]] = []
    for kind in ("budget", "limit"):
        item = aggregated.get(kind)
        if not item:
            continue
        drr_overall = _compute_issue_drr(item["spend"], product_day_metrics["total_revenue"])
        campaigns_payload = []
        for campaign in item["campaigns"]:
            campaigns_payload.append(
                {
                    **campaign,
                    "drr": campaign.get("drr") if isinstance(campaign.get("drr"), (int, float)) else None,
                    "estimated_gap": campaign.get("estimated_gap") if isinstance(campaign.get("estimated_gap"), (int, float)) and campaign.get("estimated_gap") > 0 else None,
                }
            )
        campaigns_payload.sort(key=lambda campaign: (-campaign.get("hours", 0), -campaign.get("incidents", 0), str(campaign.get("label") or "")))
        result.append(
            {
                "kind": item["kind"],
                "title": item["title"],
                "hours": item["hours"],
                "incidents": item["incidents"],
                "orders_ads": item["orders_ads"],
                "total_orders": item["total_orders"] if isinstance(item["total_orders"], (int, float)) else None,
                "drr_overall": drr_overall if isinstance(drr_overall, (int, float)) else None,
                "estimated_gap": item["estimated_gap"] if item["estimated_gap"] > 0 else None,
                "campaign_ids": item["campaign_ids"],
                "campaign_labels": item["campaign_labels"],
                "campaigns": campaigns_payload,
            }
        )
    return result


def _collect_single_catalog_issue(
    storage_state_path: str,
    range_payload: Dict[str, str],
    ref: Tuple[int, int, str],
) -> Dict[str, Any]:
    shop_id, product_id, product_ref = ref
    api = XwayApi(storage_state_path, start=range_payload["current_start"], end=range_payload["current_end"])
    stata = api.product_stata(shop_id, product_id) or {}
    campaign_rows = stata.get("campaign_wb") or []
    campaign_ids = [campaign.get("id") for campaign in campaign_rows if campaign.get("id") is not None]
    if not campaign_ids:
        return {"product_ref": product_ref, "issues": [], "campaigns": []}

    daily_exact_payload, _ = _safe_call(
        lambda: api.campaign_daily_exact(shop_id, product_id, campaign_ids, range_payload["current_start"], range_payload["current_end"]),
        {},
    )
    product_daily_stats, _ = _safe_call(
        lambda: api.product_stats_by_day(shop_id, product_id),
        [],
    )

    def collect_campaign(campaign: Dict[str, Any]) -> Dict[str, Any]:
        campaign_id = campaign.get("id")
        campaign_api = XwayApi(storage_state_path, start=range_payload["current_start"], end=range_payload["current_end"])
        pause_payload, _ = _safe_call(
            lambda: campaign_api.campaign_status_pause_history_full(
                shop_id,
                product_id,
                int(campaign_id),
                initial_limit=STATUS_PAUSE_HISTORY_INITIAL_LIMIT,
                target_start=range_payload["current_start"],
            ),
            {},
        )
        return {
            "id": campaign_id,
            "name": campaign.get("name"),
            "status": campaign.get("status"),
            "status_xway": campaign.get("status_xway"),
            "payment_type": campaign.get("payment_type"),
            "auction_mode": campaign.get("auction_mode"),
            "auto_type": campaign.get("auto_type"),
            "unified": bool(campaign.get("unified")),
            "min_cpm": campaign.get("min_cpm"),
            "mp_bid": campaign.get("mp_bid"),
            "min_cpm_recom": campaign.get("min_cpm_recom"),
            "mp_recom_bid": campaign.get("mp_recom_bid"),
            "daily_exact": (daily_exact_payload or {}).get(str(campaign_id)) or [],
            "status_logs": {
                "pause_history": _normalize_status_pause_history(pause_payload or {}),
            },
        }

    campaigns: List[Dict[str, Any]] = []
    max_workers = min(2, max(1, len(campaign_rows)))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(collect_campaign, campaign) for campaign in campaign_rows]
        for future in as_completed(futures):
            campaigns.append(future.result())

    return {
        "product_ref": product_ref,
        "issues": _aggregate_catalog_issue_summaries(campaigns, product_daily_stats, range_payload["current_start"]),
        "campaigns": [_build_issue_campaign_meta(campaign) for campaign in campaigns],
    }


def collect_catalog_issues(
    storage_state_path: str,
    product_refs: Iterable[str],
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> Dict[str, Any]:
    base_api = XwayApi(storage_state_path, start=start, end=end)
    range_payload = base_api.range
    parsed_refs = _parse_catalog_product_refs(product_refs)
    rows: List[Dict[str, Any]] = []

    max_workers = min(2, max(1, len(parsed_refs)))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_refs = {
            executor.submit(_collect_single_catalog_issue, storage_state_path, range_payload, ref): ref
            for ref in parsed_refs
        }
        for future in as_completed(future_refs):
            ref = future_refs[future]
            try:
                rows.append(future.result())
            except Exception:
                rows.append({"product_ref": ref[2], "issues": [], "campaigns": []})

    rows_by_ref = {row["product_ref"]: row for row in rows}
    ordered_rows = [rows_by_ref[ref[2]] for ref in parsed_refs if ref[2] in rows_by_ref]
    return {
        "ok": True,
        "generated_at": date.today().isoformat(),
        "range": range_payload,
        "rows": ordered_rows,
        "requested_products": [ref[2] for ref in parsed_refs],
        "loaded_products_count": len(ordered_rows),
    }


def collect_catalog_chart(
    storage_state_path: str,
    product_refs: Iterable[str],
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> Dict[str, Any]:
    base_api = XwayApi(storage_state_path, start=start, end=end)
    range_payload = base_api.range
    parsed_refs = _parse_catalog_product_refs(product_refs)
    days = _iter_iso_days(range_payload["current_start"], range_payload["current_end"])
    rows_by_day = {day: _create_catalog_chart_row(day) for day in days}
    chart_product_rows: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []

    def collect_ref(
        shop_id: int,
        product_id: int,
        ref: str,
    ) -> Tuple[str, Optional[List[Dict[str, Any]]], Dict[str, List[Dict[str, Any]]], Dict[str, str], Optional[str]]:
        try:
            api = XwayApi(storage_state_path, start=range_payload["current_start"], end=range_payload["current_end"])
            product_daily_rows = api.product_stats_by_day(shop_id, product_id)
            campaign_daily_exact: Dict[str, List[Dict[str, Any]]] = {}
            campaign_type_by_id: Dict[str, str] = {}
            try:
                stata = api.product_stata(shop_id, product_id) or {}
                campaign_rows = stata.get("campaign_wb") or []
                campaign_ids = [campaign.get("id") for campaign in campaign_rows if campaign.get("id") is not None]
                campaign_type_by_id = {
                    str(campaign.get("id")): _catalog_chart_campaign_type_for_row(campaign)
                    for campaign in campaign_rows
                    if campaign.get("id") is not None
                }
                campaign_daily_exact = api.campaign_daily_exact(
                    shop_id,
                    product_id,
                    campaign_ids,
                    range_payload["current_start"],
                    range_payload["current_end"],
                )
            except Exception:
                campaign_daily_exact = {}
                campaign_type_by_id = {}
            return ref, product_daily_rows, campaign_daily_exact, campaign_type_by_id, None
        except Exception as exc:
            return ref, None, {}, {}, str(exc)

    max_workers = min(6, max(1, len(parsed_refs)))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(collect_ref, shop_id, product_id, ref) for shop_id, product_id, ref in parsed_refs]
        for future in as_completed(futures):
            ref, product_daily_rows, campaign_daily_exact, campaign_type_by_id, error = future.result()
            if error:
                errors.append({"product": ref, "error": error})
                continue
            product_rows_by_day = {day: _create_catalog_chart_row(day) for day in days}
            for product_row in product_daily_rows or []:
                day = product_row.get("day")
                target = rows_by_day.get(day)
                product_target = product_rows_by_day.get(day)
                if target is None or product_target is None:
                    continue
                expense_sum = _catalog_chart_number(product_row.get("expense_sum"))
                sum_price = _catalog_chart_number(product_row.get("sum_price"))
                rel_sum_price = _catalog_chart_number(product_row.get("rel_sum_price"))
                rel_shks = _catalog_chart_number(product_row.get("rel_shks"))
                rel_atbs = _catalog_chart_number(product_row.get("rel_atbs"))
                ordered_sum_total = _catalog_chart_number(product_row.get("ordered_sum_total"))
                ordered_total = _catalog_chart_number(product_row.get("ordered_total"))
                avg_stock = _catalog_chart_number(product_row.get("avg_stock"))
                target["views"] += _catalog_chart_number(product_row.get("views"))
                target["clicks"] += _catalog_chart_number(product_row.get("clicks"))
                target["atbs"] += _catalog_chart_number(product_row.get("atbs"))
                target["orders"] += _catalog_chart_number(product_row.get("orders"))
                target["ordered_total"] += ordered_total
                target["avg_stock"] += avg_stock
                target["expense_sum"] += expense_sum
                target["sum_price"] += sum_price
                target["rel_sum_price"] += rel_sum_price
                target["rel_shks"] += rel_shks
                target["rel_atbs"] += rel_atbs
                target["ordered_sum_total"] += ordered_sum_total
                product_target["views"] += _catalog_chart_number(product_row.get("views"))
                product_target["clicks"] += _catalog_chart_number(product_row.get("clicks"))
                product_target["atbs"] += _catalog_chart_number(product_row.get("atbs"))
                product_target["orders"] += _catalog_chart_number(product_row.get("orders"))
                product_target["ordered_total"] += ordered_total
                product_target["avg_stock"] += avg_stock
                product_target["expense_sum"] += expense_sum
                product_target["sum_price"] += sum_price
                product_target["rel_sum_price"] += rel_sum_price
                product_target["rel_shks"] += rel_shks
                product_target["rel_atbs"] += rel_atbs
                product_target["ordered_sum_total"] += ordered_sum_total
                if expense_sum > 0:
                    target["spent_sku_count"] += 1
                    product_target["spent_sku_count"] = 1
            for campaign_id, campaign_rows in (campaign_daily_exact or {}).items():
                type_key = campaign_type_by_id.get(str(campaign_id))
                if not type_key:
                    continue
                for campaign_row in campaign_rows or []:
                    day = campaign_row.get("day")
                    target = rows_by_day.get(day)
                    product_target = product_rows_by_day.get(day)
                    if target is None or product_target is None:
                        continue
                    orders = _catalog_chart_number(campaign_row.get("orders"))
                    _add_catalog_chart_campaign_type_order(target, type_key, orders)
                    _add_catalog_chart_campaign_type_order(product_target, type_key, orders)
            chart_product_rows.append(
                {
                    "product_ref": ref,
                    "rows": [_finalize_catalog_chart_row(product_rows_by_day[day]) for day in days],
                }
            )

    rows = [_finalize_catalog_chart_row(rows_by_day[day]) for day in days]
    chart_product_rows.sort(key=lambda row: row.get("product_ref") or "")
    return {
        "ok": True,
        "generated_at": date.today().isoformat(),
        "range": range_payload,
        "selection_count": len(parsed_refs),
        "loaded_products_count": max(len(parsed_refs) - len(errors), 0),
        "rows": rows,
        "product_rows": chart_product_rows,
        "campaign_type_meta": CATALOG_CHART_CAMPAIGN_TYPE_META,
        "totals": _catalog_chart_totals(rows),
        "errors": errors,
    }


def collect_cluster_detail(
    storage_state_path: str,
    shop_id: int,
    product_id: int,
    campaign_id: int,
    normquery_id: int,
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> Dict[str, Any]:
    api = XwayApi(storage_state_path, start=start, end=end)
    history_payload, history_error = _safe_call(
        lambda: api.campaign_normquery_history(shop_id, product_id, campaign_id, normquery_id),
        [],
    )
    bid_payload, bid_error = _safe_call(
        lambda: api.campaign_normquery_bid_history(shop_id, product_id, campaign_id, normquery_id),
        [],
    )
    additional_payload, additional_error = _safe_call(
        lambda: api.campaign_additional_stats_for_normqueries(
            shop_id,
            product_id,
            campaign_id,
            [normquery_id],
            start=api.range["current_start"],
            end=api.range["current_end"],
        ),
        {},
    )
    positions_payload, positions_error = _safe_call(
        lambda: api.product_normqueries_positions(shop_id, product_id, [normquery_id]),
        {},
    )
    return {
        "range": api.range,
        "history": history_payload or [],
        "bid_history": bid_payload or [],
        "daily": _filter_dated_mapping(
            (additional_payload or {}).get(str(normquery_id)) or {},
            start=api.range["current_start"],
            end=api.range["current_end"],
        ),
        "position": (positions_payload or {}).get(str(normquery_id)),
        "errors": {
            key: value
            for key, value in {
                "history": history_error,
                "bid_history": bid_error,
                "daily": additional_error,
                "position": positions_error,
            }.items()
            if value
        },
    }
