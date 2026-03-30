#!/usr/bin/env python3
import copy
import csv
import io
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path
from time import monotonic
from threading import RLock, Thread
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

import requests


DEFAULT_STORAGE_STATE = Path(__file__).with_name("xway_storage_state.json")
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

    def product_stats_by_day(self, shop_id: int, product_id: int) -> List[Dict[str, Any]]:
        r = self.range
        return self._get_json(
            "https://am.xway.ru/api/adv/shop/"
            f"{shop_id}/product/{product_id}/stats-by-day"
            f"?start={r['current_start']}&end={r['current_end']}",
            referer=f"https://am.xway.ru/wb/shop/{shop_id}/product/{product_id}",
        )

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
    }
    secondary_errors: Dict[str, Optional[str]] = {
        "cluster_positions": None,
        "cluster_additional": None,
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
            },
            max_workers=2,
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
        "errors": {
            "schedule": primary_errors.get("schedule"),
            "bid_history": primary_errors.get("bid_history"),
            "budget_history": primary_errors.get("budget_history"),
            "status_mp": primary_errors.get("status_mp"),
            "status_pause": primary_errors.get("status_pause"),
            "cluster_stats": primary_errors.get("cluster_stats"),
            "cluster_positions": secondary_errors.get("cluster_positions"),
            "cluster_additional": secondary_errors.get("cluster_additional"),
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


def _normalize_catalog_campaign_states(raw: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    payload = raw or {}
    rows: List[Dict[str, Any]] = []
    for key in CATALOG_CAMPAIGN_FIELD_ORDER:
        normalized_code = _extract_catalog_campaign_status_code(payload.get(key))
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
            }
        )
    return rows


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
        "catalog_campaign_states": _normalize_catalog_campaign_states(product.get("campaigns_data")),
        "schedule_aggregate": _aggregate_schedule(campaigns),
        "campaigns": campaigns,
        "bid_log": sorted(
            [entry for campaign in campaigns for entry in campaign.get("bid_history", [])],
            key=lambda row: row.get("datetime_sort") or "",
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
            summary["cluster_errors"] = {
                key: value
                for key, value in {
                    "stats": heavy_errors.get("cluster_stats") or heavy_errors.get("fatal"),
                    "positions": heavy_errors.get("cluster_positions") or heavy_errors.get("fatal"),
                    "additional": heavy_errors.get("cluster_additional") or heavy_errors.get("fatal"),
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
    shop_articles: List[Dict[str, Any]] = []
    for product in products:
        article = str(product.get("external_id") or "").strip()
        if not article:
            continue
        product_id = product.get("id")
        campaign_data = product.get("campaigns_data") or {}
        stat_item = stat_map.get(str(product_id), {}) if product_id is not None else {}
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
            "campaign_states": _normalize_catalog_campaign_states(campaign_data),
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
