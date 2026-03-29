#!/usr/bin/env python3
import argparse
import asyncio
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional

from playwright.async_api import async_playwright


MENU_MARKERS = {
    "A/B-тесты",
    "SEO",
    "Товары",
    "Наcтройки",
    "База знаний",
    "Новости",
    "Трансляции",
    "Про",
}

SUMMARY_LABELS_WITH_DELTA = {
    "Расход",
    "Показов",
    "Кликов",
    "Корзин с рекламы",
    "Заказано с рекламы, шт",
    "CTR",
    "CPC",
    "CR",
    "CPO",
    "Заказано штук других товаров",
    "CPO с заказами других товаров",
}

SUMMARY_LABELS_SINGLE = {
    "Текущий остаток товара:",
    "Расходы за сегодня",
    "Расходы за эту неделю",
    "Расходы за этот месяц",
    "Период:",
    "Сравнивать с:",
    "Бюджет",
}

CAMPAIGN_MODELS = {"CPM", "CPC", "CPA"}

CAMPAIGN_LABELS = {
    "Бюджет",
    "Ставка",
    "Время показов",
    "Расход",
    "Показов",
    "Кликов",
    "Корзин с рекламы",
    "Заказано с рекламы, шт",
    "CTR",
    "CPC",
    "CR",
    "CPO",
    "Заказано штук других товаров",
    "CPO с заказами других товаров",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Авторизуется в XWAY по token-link и забирает данные страницы товара."
    )
    parser.add_argument(
        "--login-url",
        default=os.environ.get("XWAY_LOGIN_URL"),
        help="Полный XWAY login URL с token и uuid. Можно передать через XWAY_LOGIN_URL.",
    )
    parser.add_argument(
        "--storage-state",
        default=os.environ.get("XWAY_STORAGE_STATE"),
        help="Путь к Playwright storage_state.json для повторного входа без token-link.",
    )
    parser.add_argument(
        "--save-state",
        default=os.environ.get("XWAY_SAVE_STATE"),
        help="Куда сохранить storage_state.json после успешной авторизации.",
    )
    parser.add_argument(
        "--product-url",
        default=os.environ.get("XWAY_PRODUCT_URL"),
        help="Полный URL страницы товара. Можно передать через XWAY_PRODUCT_URL.",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=180000,
        help="Таймаут загрузки страницы товара в миллисекундах.",
    )
    parser.add_argument(
        "--raw-text",
        action="store_true",
        help="Добавить в JSON исходный text dump страницы.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Печатать JSON с отступами.",
    )
    args = parser.parse_args()
    if not args.product_url:
        parser.error("Нужен --product-url или переменная окружения XWAY_PRODUCT_URL.")
    if not args.login_url and not args.storage_state:
        parser.error(
            "Нужен --login-url / XWAY_LOGIN_URL или --storage-state / XWAY_STORAGE_STATE."
        )
    return args


def normalize_lines(text: str) -> List[str]:
    lines = []
    for raw_line in text.splitlines():
        line = re.sub(r"\s+", " ", raw_line.replace("\xa0", " ")).strip()
        if line:
            lines.append(line)
    return lines


def looks_like_delta(value: str) -> bool:
    return bool(re.match(r"^[+-]?\d", value))


def parse_number(raw: Optional[str]) -> Optional[float]:
    if raw is None:
        return None
    value = raw.replace("\xa0", " ").replace("₽", "").replace("%", "").replace(" ", "")
    value = value.replace(",", ".")
    value = re.sub(r"[^0-9.\-+]", "", value)
    if not value or value in {"+", "-", ".", "+.", "-."}:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def find_campaign_starts(lines: List[str]) -> List[int]:
    starts = []
    for idx, line in enumerate(lines):
        next_line = lines[idx + 1] if idx + 1 < len(lines) else ""
        if next_line not in CAMPAIGN_MODELS:
            continue
        if line.startswith("Кампания ") or " / " in line:
            starts.append(idx)
    return starts


def parse_summary(lines: List[str], summary_start: int, summary_end: int) -> Dict[str, Any]:
    metrics: Dict[str, Any] = {}
    idx = summary_start
    while idx < summary_end:
        line = lines[idx]
        if line in SUMMARY_LABELS_SINGLE:
            value = lines[idx + 1] if idx + 1 < summary_end else None
            metrics[line] = {"raw": value, "value": parse_number(value)}
            idx += 2
            continue
        if line in SUMMARY_LABELS_WITH_DELTA:
            value = lines[idx + 1] if idx + 1 < summary_end else None
            delta = lines[idx + 2] if idx + 2 < summary_end and looks_like_delta(lines[idx + 2]) else None
            metrics[line] = {
                "raw": value,
                "value": parse_number(value),
                "delta_raw": delta,
                "delta_value": parse_number(delta),
            }
            idx += 3 if delta is not None else 2
            continue
        idx += 1
    return metrics


def parse_campaign_block(block: List[str]) -> Dict[str, Any]:
    campaign: Dict[str, Any] = {
        "title": block[0],
        "model": block[1] if len(block) > 1 else None,
        "strategy": block[2] if len(block) > 2 else None,
        "status": block[3] if len(block) > 3 else None,
    }
    idx = 4
    while idx < len(block):
        line = block[idx]
        if line == "Кластеры":
            campaign["clusters_action"] = block[idx + 1] if idx + 1 < len(block) else None
            idx += 2
            continue
        if line == "Зоны показов:":
            campaign["zones"] = block[idx + 1] if idx + 1 < len(block) else None
            idx += 2
            continue
        if line.startswith("ID: "):
            campaign["id"] = line.split(":", 1)[1].strip()
            idx += 1
            continue
        if line.startswith("WB ID: "):
            campaign["wb_id"] = line.split(":", 1)[1].strip()
            idx += 1
            continue
        if line.startswith("Создана "):
            campaign["created_at"] = line.replace("Создана ", "", 1).strip()
            idx += 1
            continue
        if line in CAMPAIGN_LABELS:
            value = block[idx + 1] if idx + 1 < len(block) else None
            campaign[line] = {"raw": value, "value": parse_number(value)}
            if line == "Бюджет":
                next_line = block[idx + 2] if idx + 2 < len(block) else None
                if next_line == "АВТО":
                    campaign["budget_mode"] = next_line
                    idx += 3
                    continue
            idx += 2
            continue
        idx += 1
    return campaign


def parse_product_page(title: str, url: str, lines: List[str]) -> Dict[str, Any]:
    article_index = next((i for i, line in enumerate(lines) if line.startswith("Арт: ")), None)
    if article_index is None:
        raise ValueError("Не найден артикул на странице товара.")

    campaign_starts = find_campaign_starts(lines)
    first_campaign_index = next((idx for idx in campaign_starts if idx > article_index), len(lines))

    campaigns_label_index = next(
        (i for i, line in enumerate(lines[:article_index]) if line == "Кампании"),
        None,
    )
    product_name = lines[article_index - 1] if article_index > 0 else None
    cabinet_name = (
        lines[campaigns_label_index - 1]
        if campaigns_label_index is not None and campaigns_label_index > 0
        else None
    )
    user_name = (
        lines[campaigns_label_index - 2]
        if campaigns_label_index is not None and campaigns_label_index > 1
        else None
    )

    result: Dict[str, Any] = {
        "page_title": title,
        "page_url": url,
        "cabinet_name": cabinet_name,
        "user_name": user_name,
        "product_name": product_name,
        "article": lines[article_index].split(":", 1)[1].strip(),
        "summary": parse_summary(lines, article_index + 1, first_campaign_index),
        "campaigns": [],
    }

    campaign_bounds = campaign_starts + [len(lines)]
    for current, next_start in zip(campaign_bounds, campaign_bounds[1:]):
        block = lines[current:next_start]
        if block and block[0] != "Подписывайтесь на наши каналы:":
            result["campaigns"].append(parse_campaign_block(block))

    return result


async def fetch_product(
    login_url: Optional[str],
    product_url: str,
    timeout_ms: int,
    storage_state: Optional[str],
    save_state: Optional[str],
) -> Dict[str, Any]:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context_kwargs: Dict[str, Any] = {"viewport": {"width": 1440, "height": 900}}
        if storage_state:
            context_kwargs["storage_state"] = storage_state
        context = await browser.new_context(**context_kwargs)
        page = await context.new_page()

        if login_url:
            await page.goto(login_url, wait_until="domcontentloaded", timeout=120000)
            await page.wait_for_timeout(8000)
            if "/login" in page.url and "Вход" in await page.title():
                raise RuntimeError("Token-link не авторизовал сессию XWAY.")
            if save_state:
                await context.storage_state(path=save_state)

        await page.goto(product_url, wait_until="load", timeout=timeout_ms)
        await page.wait_for_timeout(8000)
        if "/login" in page.url and "Вход" in await page.title():
            if storage_state and not login_url:
                raise RuntimeError("Storage state больше не валиден, XWAY редиректит на логин.")
            raise RuntimeError("После авторизации страница товара редиректит на логин.")

        title = await page.title()
        body_text = await page.locator("body").inner_text()
        cookies = [
            {"name": cookie["name"], "domain": cookie["domain"]}
            for cookie in await context.cookies()
            if "xway" in cookie["domain"] or cookie["domain"].endswith(".xway.ru")
        ]
        await browser.close()

    lines = normalize_lines(body_text)
    parsed = parse_product_page(title, product_url, lines)
    parsed["session_cookies"] = cookies
    parsed["line_count"] = len(lines)
    parsed["raw_text"] = body_text
    return parsed


def main() -> int:
    args = parse_args()
    try:
        data = asyncio.run(
            fetch_product(
                args.login_url,
                args.product_url,
                args.timeout_ms,
                args.storage_state,
                args.save_state,
            )
        )
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if not args.raw_text:
        data.pop("raw_text", None)

    if args.pretty:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(data, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
