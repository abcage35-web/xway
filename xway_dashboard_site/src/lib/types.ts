export interface DateRange {
  current_start: string;
  current_end: string;
  compare_start?: string | null;
  compare_end?: string | null;
  span_days: number;
}

export interface CatalogCampaignState {
  key: string;
  label: string;
  short_label: string;
  status_code: string;
  status_label: string;
  active: boolean;
}

export interface GroupInfo {
  id: number;
  name: string;
  color: string;
  products_num: number;
}

export interface IdentityInfo {
  name: string;
  brand: string;
  category_keyword: string;
  vendor_code: string;
  image_url: string;
  tags_count: number;
  seo_sets_count: number;
  ab_tests_count: number;
  group?: GroupInfo | null;
}

export interface ShopInfo {
  id: number;
  name: string;
  marketplace: string;
  tariff_code: string;
  products_count: number;
  expired: boolean;
  expire_date?: string | null;
  expire_in?: string | null;
}

export interface RangeMetrics {
  budget: number | null;
  day_budget: number | null;
  campaigns_count: number | null;
  manual_campaigns_count: number | null;
  ordered_report: number | null;
  ordered_sum_report: number | null;
  views: number | null;
  clicks: number | null;
  atbs: number | null;
  orders: number | null;
  shks: number | null;
  rel_shks: number | null;
  sum: number | null;
  sum_price: number | null;
  rel_sum_price: number | null;
  rel_atbs: number | null;
  ctr: number | null;
  cpc: number | null;
  cr: number | null;
  cpo: number | null;
  cpo_overall: number | null;
  cpo_with_rel: number | null;
  drr: number | null;
  spend_day: number | null;
  spend_week: number | null;
  spend_month: number | null;
  spend_limits?: RangeMetricSpendLimitItem[];
}

export interface RangeMetricSpendLimitItem {
  limit: number | null;
  limit_period: string | null;
  user_id?: number | null;
  active: boolean;
  created_at?: string | null;
}

export interface ComparisonMetric {
  filter_sum?: number | null;
  dynamics_sum?: number | null;
  diff?: number | null;
  diff_percent?: number | null;
}

export interface DailyStat {
  day: string;
  day_label: string;
  views: number | null;
  clicks: number | null;
  expense_sum: number | null;
  atbs: number | null;
  orders: number | null;
  ordered_total: number | null;
  sum_price: number | null;
  ordered_sum_total: number | null;
  avg_stock: number | null;
  rel_shks: number | null;
  rel_atbs: number | null;
  rel_sum_price: number | null;
  CTR: number | null;
  CPC: number | null;
  CR: number | null;
  DRR: number | null;
  CPO: number | null;
  CPO_overall: number | null;
  CPO_with_rel: number | null;
}

export interface BidLogEntry {
  datetime: string;
  datetime_sort?: string | null;
  campaign_name: string | null;
  campaign_id?: number | null;
  zone: string | null;
  cpm: number | null;
  new_position: string | null;
  origin: string | null;
  recom?: boolean | null;
}

export interface HeatmapHour {
  hour: number;
  views: number;
  clicks: number;
  spent: number;
  CTR: number;
  CPC: number;
}

export interface HeatmapPayload {
  period_from: string;
  period_to: string;
  by_hour: HeatmapHour[];
}

export interface OrdersHeatmapHour {
  hour: number;
  orders: number;
}

export interface OrdersHeatmapPayload {
  period_from: string;
  period_to: string;
  by_hour: OrdersHeatmapHour[];
}

export interface ScheduleHour {
  hour: number;
  count: number;
  active: boolean;
}

export interface ScheduleDay {
  key: string;
  label: string;
  hours: ScheduleHour[];
}

export interface ScheduleAggregate {
  days: ScheduleDay[];
  max_count: number;
  active_slots?: number;
}

export interface CampaignScheduleHour {
  hour: number;
  active: boolean;
}

export interface CampaignScheduleDay {
  key: string;
  label: string;
  active_hours?: number[];
  hours: CampaignScheduleHour[];
}

export interface CampaignScheduleConfig {
  schedule_active: boolean;
  active_slots: number;
  days: CampaignScheduleDay[];
  hours_by_day?: Record<string, number[]>;
}

export interface BudgetHistoryEntry {
  id?: number;
  deposit: number;
  producer: string;
  datetime: string;
  datetime_sort?: string;
}

export interface BudgetRuleConfig {
  active: boolean;
  threshold: number | null;
  deposit: number | null;
  limit: number | null;
  limit_period: string | null;
  restart: boolean;
  status?: string | null;
  error?: string | null;
  history_count: number;
  last_topup?: BudgetHistoryEntry | null;
}

export interface CampaignStatusHistoryEntry {
  timestamp: string;
  status: string;
  day?: string;
  time?: string;
  timestamp_sort?: string;
}

export interface CampaignPauseHistoryEntry {
  start?: string;
  end?: string;
  status?: string;
  pause_reasons?: string[];
  paused_user?: string;
  paused_limiter?: string;
  is_freeze?: boolean;
  is_unfreeze?: boolean;
  unpaused_user?: string | null;
  stopped_user?: string | null;
}

export interface CampaignPauseHistoryLabel {
  date?: string | null;
  time?: string | null;
}

export interface CampaignPauseHistoryPayload {
  labels: CampaignPauseHistoryLabel[];
  header: unknown[];
  series: unknown[];
  next_page?: Record<string, unknown> | null;
  tooltips: unknown[];
  intervals: CampaignPauseHistoryEntry[];
  merged_intervals: CampaignPauseHistoryEntry[];
}

export interface CampaignStatusLogs {
  mp_error?: string | null;
  mp_history: CampaignStatusHistoryEntry[];
  mp_next_page?: number | null;
  pause_error?: string | null;
  pause_history: CampaignPauseHistoryPayload;
}

export interface CampaignMetricSet {
  views: number | null;
  clicks: number | null;
  atbs: number | null;
  orders: number | null;
  shks: number | null;
  rel_shks: number | null;
  sum: number | string | null;
  sum_price: number | string | null;
  rel_sum_price: number | string | null;
  ctr: number | null;
  cpc: number | null;
  cr: number | null;
  cpo: number | null;
  cpo_with_rel: number | null;
}

export interface CampaignDailyExactRow {
  day: string;
  views: number | null;
  clicks: number | null;
  atbs: number | null;
  orders: number | null;
  shks: number | null;
  rel_shks: number | null;
  expense_sum: number | null;
  sum_price: number | null;
  rel_sum_price: number | null;
  CTR: number | null;
  CPC: number | null;
  CR: number | null;
  CPO: number | null;
  CPO_with_rel: number | null;
}

export interface CampaignSpendLimitItem {
  period: string;
  active: boolean;
  limit: number | null;
  spent: number | null;
  remaining: number | null;
}

export interface CampaignSpendLimits {
  items: CampaignSpendLimitItem[];
}

export interface ClusterDailyRow {
  views?: number | null;
  clicks?: number | null;
  CTR?: number | null;
  CPC?: number | null;
  CPM?: number | null;
  expense?: number | null;
  DRR?: number | null;
  drr?: number | null;
  org_pos?: number | null;
  rates_promo_pos?: number | null;
  CR?: number | null;
  basket?: number | null;
  orders?: number | null;
  OCR?: number | null;
  CPO?: number | null;
}

export interface ClusterItem {
  normquery_id: number;
  name: string;
  popularity: number | null;
  views: number | null;
  clicks: number | null;
  atbs: number | null;
  orders: number | null;
  shks: number | null;
  expense: number | null;
  ctr: number | null;
  cpc: number | null;
  cr: number | null;
  ocr: number | null;
  cpo: number | null;
  bid: number | null;
  bid_default: boolean;
  bid_rule_active: boolean;
  bid_rule_target_place: number | null;
  bid_rule_max_cpm: number | null;
  excluded: boolean;
  fixed: boolean;
  is_main: boolean;
  position: number | null;
  position_is_promo: boolean;
  latest_org_pos: number | null;
  latest_promo_pos: number | null;
  latest_date: string | null;
  daily: Record<string, ClusterDailyRow>;
}

export interface ClusterPayload {
  available: boolean;
  total_clusters: number;
  excluded: number;
  fixed: number;
  current_rules_used: number | null;
  max_rules_available: number | null;
  items: ClusterItem[];
}

export interface CampaignSummary {
  id: number;
  wb_id: string;
  name: string;
  query_main?: string | null;
  status: string;
  status_xway?: string | null;
  auction_mode: string | null;
  auto_type: string | null;
  payment_type?: string | null;
  unified: boolean;
  schedule_active: boolean;
  created?: string | null;
  wb_created?: string | null;
  budget: number | null;
  bid: number | null;
  mp_bid: number | null;
  mp_recom_bid: number | null;
  min_cpm: number | null;
  min_cpm_recom: number | null;
  spend: Record<string, number | null>;
  metrics: CampaignMetricSet;
  pause_reasons?: Record<string, unknown>;
  budget_history: BudgetHistoryEntry[];
  budget_rule_config?: BudgetRuleConfig | null;
  bid_history: BidLogEntry[];
  daily_exact?: CampaignDailyExactRow[];
  spend_limits?: CampaignSpendLimits;
  clusters: ClusterPayload;
  schedule_config?: CampaignScheduleConfig;
  status_logs?: CampaignStatusLogs;
  raw?: Record<string, unknown>;
}

export interface ProductStocksRule {
  active?: boolean | null;
  has_error?: boolean | null;
  type?: string | null;
  condition?: string | null;
  metric?: string | null;
  kind?: string | null;
  rule_type?: string | null;
  mode?: string | null;
  field?: string | null;
  threshold?: number | string | null;
  value?: number | string | null;
  stock?: number | string | null;
  stock_threshold?: number | string | null;
  min_stock?: number | string | null;
  remain_stock?: number | string | null;
  quantity?: number | string | null;
  qty?: number | string | null;
  days?: number | string | null;
  days_gap?: number | string | null;
  days_left?: number | string | null;
  days_threshold?: number | string | null;
  turnover_days?: number | string | null;
  coverage_days?: number | string | null;
  days_to_stockout?: number | string | null;
  stocks_limit?: number | string | null;
  last_state?: string | null;
  [key: string]: unknown;
}

export interface ProductOperationsSummary {
  stocks_rule?: ProductStocksRule | null;
  [key: string]: unknown;
}

export interface ProductSummary {
  article: string;
  product_id: number;
  product_url: string;
  period: DateRange;
  shop: ShopInfo;
  identity: IdentityInfo;
  stock: {
    current: number | null;
    list_stock: number | null;
  };
  range_metrics: RangeMetrics;
  comparison: Record<string, ComparisonMetric>;
  daily_stats: DailyStat[];
  daily_totals: Record<string, number | null>;
  errors?: Record<string, string | null>;
  heatmap: HeatmapPayload;
  orders_heatmap: OrdersHeatmapPayload;
  catalog_campaign_states: CatalogCampaignState[];
  schedule_aggregate: ScheduleAggregate;
  campaigns: CampaignSummary[];
  bid_log: BidLogEntry[];
  operations?: ProductOperationsSummary | null;
}

export interface ProductsResponse {
  ok: boolean;
  generated_at: string;
  range: DateRange;
  products: ProductSummary[];
  not_found: string[];
  requested_articles: string[];
}

export interface CatalogArticle {
  article: string;
  product_id: number;
  name: string;
  brand: string;
  vendor_code: string;
  category_keyword: string;
  image_url: string;
  enabled: boolean;
  is_active: boolean;
  stock: number | null;
  campaigns_count: number | null;
  campaign_states: CatalogCampaignState[];
  manual_campaigns_count: number | null;
  expense_sum: number | null;
  views: number | null;
  clicks: number | null;
  atbs: number | null;
  orders: number | null;
  sum_price: number | null;
  ctr: number | null;
  cpc: number | null;
  cr: number | null;
  cpo: number | null;
  cpo_overall: number | null;
  cpo_with_rel: number | null;
  drr: number | null;
  budget: number | null;
  ordered_report: number | null;
  ordered_sum_report: number | null;
  spend_day: number | null;
  spend_week: number | null;
  spend_month: number | null;
  shop_url: string;
  product_url: string;
  group?: GroupInfo | null;
}

export interface CatalogShop {
  id: number;
  name: string;
  marketplace: string;
  tariff_code: string;
  shop_url: string;
  balance?: number | null;
  expired: boolean;
  expire_date?: string | null;
  expire_in?: string | null;
  products_count: number;
  listing_meta?: {
    shop_totals?: RangeMetrics;
  };
  articles: CatalogArticle[];
}

export interface CatalogResponse {
  ok: boolean;
  generated_at: string;
  mode: string;
  range: DateRange;
  total_shops: number;
  total_articles: number;
  totals: {
    expense_sum: number;
    orders: number;
    atbs: number;
    clicks: number;
    views: number;
  };
  shops: CatalogShop[];
}

export interface CatalogChartRow {
  day: string;
  day_label: string;
  views: number;
  clicks: number;
  atbs: number;
  orders: number;
  expense_sum: number;
  sum_price: number;
  ordered_sum_total: number;
  spent_sku_count: number;
  ctr: number | null;
  cr1: number | null;
  cr2: number | null;
  crf: number | null;
  drr_total: number | null;
  drr_ads: number | null;
}

export interface CatalogChartTotals {
  views: number;
  clicks: number;
  atbs: number;
  orders: number;
  expense_sum: number;
  sum_price: number;
  ordered_sum_total: number;
  ctr: number | null;
  cr1: number | null;
  cr2: number | null;
  crf: number | null;
  drr_total: number | null;
  drr_ads: number | null;
}

export interface CatalogChartProductRows {
  product_ref: string;
  rows: CatalogChartRow[];
}

export interface CatalogIssuesIssue {
  kind: "budget" | "limit";
  title: string;
  hours: number;
  incidents: number;
  orders_ads: number;
  total_orders: number | null;
  drr_overall: number | null;
  estimated_gap: number | null;
  campaign_ids: number[];
  campaign_labels: string[];
  campaigns: CatalogIssuesIssueCampaign[];
}

export interface CatalogIssuesIssueCampaign {
  id: number;
  label: string;
  payment_type: "cpm" | "cpc" | null;
  zone_kind: "search" | "recom" | "both" | null;
  status_code: string | null;
  status_label: string | null;
  display_status: "active" | "paused" | "freeze" | "muted";
  hours: number;
  incidents: number;
  orders_ads: number;
  drr: number | null;
  estimated_gap: number | null;
}

export interface CatalogIssuesRow {
  product_ref: string;
  issues: CatalogIssuesIssue[];
  campaigns: CatalogIssuesIssueCampaign[];
}

export interface CatalogIssuesResponse {
  ok: boolean;
  generated_at: string;
  range: DateRange;
  rows: CatalogIssuesRow[];
  requested_products: string[];
  loaded_products_count: number;
}

export interface CatalogChartResponse {
  ok: boolean;
  generated_at: string;
  range: DateRange;
  selection_count: number;
  loaded_products_count: number;
  rows: CatalogChartRow[];
  product_rows?: CatalogChartProductRows[];
  totals: CatalogChartTotals;
  errors: Array<{ product: string; error: string }>;
}

export interface ClusterDetailResponse {
  ok: boolean;
  range: DateRange;
  history: Array<{ ts: string; action: string; author: string }>;
  bid_history: Array<{ ts: string; bid: number; author: string }>;
  daily: Record<string, ClusterDailyRow>;
  position: number | null;
  errors?: Record<string, string | null>;
}
