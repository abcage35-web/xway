#!/usr/bin/env python3
import json
import os
import traceback
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

from xway_api import DEFAULT_STORAGE_STATE, collect_articles, collect_catalog, collect_catalog_chart, collect_catalog_issues, collect_cluster_detail


ROOT = Path(__file__).resolve().parent
SITE_DIR = ROOT / "xway_dashboard_site"
REACT_STATIC_DIR = SITE_DIR / "dist"
REACT_INDEX_PATH = "/index.html"
PRODUCT_PATH = "/product"
CATALOG_PATH = "/catalog"
RUSSIAN_PRODUCT_PATH = "/товар"
RUSSIAN_CATALOG_PATH = "/артикулы"
HOST = os.environ.get("XWAY_DASHBOARD_HOST", "127.0.0.1")
PORT = int(os.environ.get("XWAY_DASHBOARD_PORT", "8765"))
DEFAULT_ARTICLES = os.environ.get("XWAY_DEFAULT_ARTICLES", "44392513,60149847")
STORAGE_STATE = os.environ.get("XWAY_STORAGE_STATE", str(DEFAULT_STORAGE_STATE))


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(REACT_STATIC_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _write_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _request_params(self) -> Tuple[Tuple[str, ...], Optional[str], Optional[str], str, Tuple[str, ...]]:
        query = parse_qs(urlparse(self.path).query)
        raw_articles = query.get("articles", [DEFAULT_ARTICLES])[0]
        article_ids = tuple(dict.fromkeys(item.strip() for item in raw_articles.split(",") if item.strip()))
        start = query.get("start", [None])[0] or None
        end = query.get("end", [None])[0] or None
        campaign_mode = (query.get("campaign_mode", ["full"])[0] or "full").strip().lower()
        raw_heavy_campaigns = query.get("heavy_campaign_ids", [""])[0]
        heavy_campaign_ids = tuple(
            dict.fromkeys(item.strip() for item in raw_heavy_campaigns.split(",") if item.strip())
        )
        return article_ids, start, end, campaign_mode, heavy_campaign_ids

    def _cluster_detail_params(self):
        query = parse_qs(urlparse(self.path).query)
        def pick_int(name: str) -> Optional[int]:
            raw = query.get(name, [None])[0]
            return int(raw) if raw not in {None, ""} else None
        return {
            "shop_id": pick_int("shop_id"),
            "product_id": pick_int("product_id"),
            "campaign_id": pick_int("campaign_id"),
            "normquery_id": pick_int("normquery_id"),
            "start": query.get("start", [None])[0] or None,
            "end": query.get("end", [None])[0] or None,
        }

    def _catalog_chart_params(self) -> Dict[str, Any]:
        query = parse_qs(urlparse(self.path).query)
        product_refs = tuple(
            item.strip()
            for item in query.get("products", [""])[0].split(",")
            if item.strip()
        )
        return {
            "product_refs": product_refs,
            "start": query.get("start", [None])[0] or None,
            "end": query.get("end", [None])[0] or None,
            "include_campaign_types": query.get("include_campaign_types", ["0"])[0] == "1",
        }

    def _is_spa_route(self, path: str) -> bool:
        normalized_path = (unquote(path or "/").rstrip("/") or "/")
        return normalized_path in {"/", PRODUCT_PATH, CATALOG_PATH, RUSSIAN_PRODUCT_PATH, RUSSIAN_CATALOG_PATH}

    def _spa_redirect_target(self, path: str) -> Optional[str]:
        normalized_path = (unquote(path or "/").rstrip("/") or "/")
        if normalized_path == RUSSIAN_PRODUCT_PATH:
            return PRODUCT_PATH
        if normalized_path == RUSSIAN_CATALOG_PATH:
            return CATALOG_PATH
        return None

    def _serve_from_directory(self, directory: Path, path: str, head: bool = False) -> None:
        original_directory = self.directory
        original_path = self.path
        try:
            self.directory = str(directory)
            self.path = path
            if head:
                super().do_HEAD()
            else:
                super().do_GET()
        finally:
            self.directory = original_directory
            self.path = original_path

    @staticmethod
    def _with_query(path: str, query: str) -> str:
        return f"{path}?{query}" if query else path

    def _redirect(self, path: str, query: str = "") -> None:
        target = self._with_query(path, query)
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", target)
        self.end_headers()

    @staticmethod
    def _react_request_targets_file(subpath: str) -> bool:
        if subpath.startswith("/assets/"):
            return True
        filename = Path(subpath).name
        return "." in filename

    def _is_api_route(self, path: str) -> bool:
        return path.startswith("/api/")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        redirect_target = self._spa_redirect_target(parsed.path)
        if redirect_target:
            self._redirect(redirect_target, parsed.query)
            return

        if parsed.path == "/api/health":
            self._write_json({"ok": True, "storage_state": STORAGE_STATE})
            return

        if parsed.path == "/api/products":
            article_ids, start, end, campaign_mode, heavy_campaign_ids = self._request_params()
            try:
                payload = collect_articles(
                    article_ids,
                    STORAGE_STATE,
                    start=start,
                    end=end,
                    campaign_mode=campaign_mode,
                    heavy_campaign_ids=heavy_campaign_ids,
                )
            except Exception as exc:
                self._write_json(
                    {
                        "ok": False,
                        "error": str(exc),
                        "traceback": traceback.format_exc(),
                    },
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
                return

            payload["ok"] = True
            payload["requested_articles"] = list(article_ids)
            self._write_json(payload)
            return

        if parsed.path == "/api/catalog":
            query = parse_qs(parsed.query)
            _, start, end, _, _ = self._request_params()
            catalog_mode = (query.get("mode", ["compact"])[0] or "compact").strip().lower()
            try:
                payload = collect_catalog(STORAGE_STATE, start=start, end=end, mode=catalog_mode)
            except Exception as exc:
                self._write_json(
                    {
                        "ok": False,
                        "error": str(exc),
                        "traceback": traceback.format_exc(),
                    },
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
                return
            payload["ok"] = True
            self._write_json(payload)
            return

        if parsed.path == "/api/catalog-chart":
            params = self._catalog_chart_params()
            try:
                payload = collect_catalog_chart(
                    STORAGE_STATE,
                    params["product_refs"],
                    start=params["start"],
                    end=params["end"],
                    include_campaign_types=params["include_campaign_types"],
                )
            except Exception as exc:
                self._write_json(
                    {
                        "ok": False,
                        "error": str(exc),
                        "traceback": traceback.format_exc(),
                    },
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
                return
            self._write_json(payload)
            return

        if parsed.path == "/api/catalog-issues":
            params = self._catalog_chart_params()
            try:
                payload = collect_catalog_issues(
                    STORAGE_STATE,
                    params["product_refs"],
                    start=params["start"],
                    end=params["end"],
                )
            except Exception as exc:
                self._write_json(
                    {
                        "ok": False,
                        "error": str(exc),
                        "traceback": traceback.format_exc(),
                    },
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
                return
            self._write_json(payload)
            return

        if parsed.path == "/api/cluster-detail":
            params = self._cluster_detail_params()
            required = ("shop_id", "product_id", "campaign_id", "normquery_id")
            if any(params[key] is None for key in required):
                self._write_json(
                    {"ok": False, "error": "shop_id, product_id, campaign_id и normquery_id обязательны"},
                    status=HTTPStatus.BAD_REQUEST,
                )
                return
            try:
                payload = collect_cluster_detail(
                    STORAGE_STATE,
                    shop_id=params["shop_id"],
                    product_id=params["product_id"],
                    campaign_id=params["campaign_id"],
                    normquery_id=params["normquery_id"],
                    start=params["start"],
                    end=params["end"],
                )
            except Exception as exc:
                self._write_json(
                    {
                        "ok": False,
                        "error": str(exc),
                        "traceback": traceback.format_exc(),
                    },
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
                return
            payload["ok"] = True
            self._write_json(payload)
            return

        if self._is_api_route(parsed.path):
            self._write_json(
                {"ok": False, "error": f"Unknown API route: {parsed.path}"},
                status=HTTPStatus.NOT_FOUND,
            )
            return

        # Dist assets are requested from absolute /assets/* in Vite build.
        if parsed.path.startswith("/assets/") and REACT_STATIC_DIR.exists():
            self._serve_from_directory(REACT_STATIC_DIR, self._with_query(parsed.path, parsed.query))
            return

        if not REACT_STATIC_DIR.exists():
            self._write_json(
                {"ok": False, "error": "React build not found. Run npm run build in xway_dashboard_site."},
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return

        target = parsed.path if self._react_request_targets_file(parsed.path) else REACT_INDEX_PATH
        self._serve_from_directory(REACT_STATIC_DIR, self._with_query(target, parsed.query))

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        redirect_target = self._spa_redirect_target(parsed.path)
        if redirect_target:
            self._redirect(redirect_target, parsed.query)
            return

        if parsed.path.startswith("/assets/") and REACT_STATIC_DIR.exists():
            self._serve_from_directory(REACT_STATIC_DIR, self._with_query(parsed.path, parsed.query), head=True)
            return
        if self._is_spa_route(parsed.path) or not self._is_api_route(parsed.path):
            if not REACT_STATIC_DIR.exists():
                self.send_response_only(HTTPStatus.SERVICE_UNAVAILABLE)
                self.end_headers()
                return
            target = parsed.path if self._react_request_targets_file(parsed.path) else REACT_INDEX_PATH
            self._serve_from_directory(REACT_STATIC_DIR, self._with_query(target, parsed.query), head=True)
            return
        super().send_response_only(HTTPStatus.METHOD_NOT_ALLOWED)
        self.send_header("Allow", "GET")
        self.end_headers()


def main() -> None:
    if not Path(STORAGE_STATE).exists():
        raise SystemExit(f"Storage state file not found: {STORAGE_STATE}")
    if not SITE_DIR.exists():
        raise SystemExit(f"Site directory not found: {SITE_DIR}")
    if not REACT_STATIC_DIR.exists():
        raise SystemExit("React build not found. Run npm run build in xway_dashboard_site.")

    server = ThreadingHTTPServer((HOST, PORT), DashboardHandler)
    mode = "react build"
    print(f"XWAY dashboard running at http://{HOST}:{PORT} ({mode})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
