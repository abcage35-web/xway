export const DEFAULT_TRACKED_ARTICLE_IDS = ["44392513", "60149847"];
export const SIDEBAR_STATE_KEY = "xway-sidebar-collapsed";
export const TRACKED_ARTICLES_KEY = "xway-tracked-articles";
export const SELECTED_ARTICLE_KEY = "xway-selected-article";
export const RANGE_STATE_KEY = "xway-range";
export const ARTICLE_SUMMARY_KEY = "xway-article-summary-cache";
export const SHOP_COLLAPSE_KEY = "xway-shop-collapse";
export const OVERVIEW_COLLAPSE_KEY = "xway-overview-collapse";
export const DEFAULT_CHART_WINDOW_DAYS = 7;
export const MAX_CHART_WINDOW_DAYS = 30;
export const SCHEDULE_COVERAGE_BASELINE = 2;
export const PRODUCT_TAB_KEYS = ["overview", "daily", "campaign-status", "clusters", "hours", "campaign-heatmap", "bids"];
export const HEAVY_TAB_KEYS = new Set(["campaign-status", "clusters", "hours", "campaign-heatmap", "bids"]);

export const DAILY_COLUMNS = [
  { label: "Дата", field: "day_label", type: "text" },
  { label: "Показы", field: "views", type: "number", digits: 0 },
  { label: "Клики", field: "clicks", type: "number", digits: 0 },
  { label: "Расход", field: "expense_sum", type: "money" },
  { label: "CTR", field: "CTR", type: "percent" },
  { label: "CPC", field: "CPC", type: "money" },
  { label: "Корзины", field: "atbs", type: "number", digits: 0 },
  { label: "Заказы с рекламы", field: "orders", type: "number", digits: 0 },
  { label: "Заказов всего", field: "ordered_total", type: "number", digits: 0 },
  { label: "Заказано с рекламы", field: "sum_price", type: "money" },
  { label: "Заказано всего", field: "ordered_sum_total", type: "money" },
  { label: "CR", field: "CR", type: "percent" },
  { label: "ДРР", field: "DRR", type: "percent" },
  { label: "CPO", field: "CPO", type: "money" },
  { label: "CPO общий", field: "CPO_overall", type: "money" },
  { label: "CPO с доп. продажами", field: "CPO_with_rel", type: "money" },
  { label: "Доп. корзины", field: "rel_atbs", type: "number", digits: 0 },
  { label: "Доп. заказы", field: "rel_shks", type: "number", digits: 0 },
  { label: "Доп. выручка", field: "rel_sum_price", type: "money" },
];

export const BIDLOG_COLUMNS = [
  { label: "Время", field: "datetime", type: "text" },
  { label: "Кампания", field: "campaign_name", type: "text" },
  { label: "Зона", field: "zone", type: "text" },
  { label: "Ставка", field: "cpm", type: "money" },
  { label: "Новая позиция", field: "new_position", type: "text" },
  { label: "Инициатор", field: "origin", type: "text" },
];

export const BUDGET_HISTORY_COLUMNS = [
  { label: "Время", field: "datetime", type: "text" },
  { label: "Сумма", field: "deposit", type: "money" },
  { label: "Источник", field: "producer", type: "text" },
  { label: "ID", field: "id", type: "number", digits: 0 },
];

export const STATUS_MP_COLUMNS = [
  { label: "Время", field: "timestamp_label", type: "text" },
  { label: "Статус", field: "status", type: "text" },
];

export const CLUSTER_HISTORY_COLUMNS = [
  { label: "Время", field: "ts", type: "text" },
  { label: "Действие", field: "action", type: "text" },
  { label: "Инициатор", field: "author", type: "text" },
];

export const CLUSTER_BID_COLUMNS = [
  { label: "Время", field: "ts", type: "text" },
  { label: "Ставка", field: "bid", type: "money" },
  { label: "Инициатор", field: "author", type: "text" },
];

export const CLUSTER_DAILY_COLUMNS = [
  { label: "Дата", field: "day_label", type: "text" },
  { label: "Показы", field: "views", type: "number", digits: 0 },
  { label: "Клики", field: "clicks", type: "number", digits: 0 },
  { label: "Расход", field: "expense", type: "money" },
  { label: "CTR", field: "CTR", type: "percent" },
  { label: "CPC", field: "CPC", type: "money" },
  { label: "Ставка", field: "CPM", type: "money" },
  { label: "Орг. позиция", field: "org_pos", type: "number", digits: 0 },
  { label: "Рекл. позиция", field: "rates_promo_pos", type: "number", digits: 0 },
];
