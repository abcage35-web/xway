import {
  ARTICLE_SUMMARY_KEY,
  BIDLOG_COLUMNS,
  BUDGET_HISTORY_COLUMNS,
  CLUSTER_BID_COLUMNS,
  CLUSTER_DAILY_COLUMNS,
  CLUSTER_HISTORY_COLUMNS,
  DAILY_COLUMNS,
  DEFAULT_CHART_WINDOW_DAYS,
  DEFAULT_TRACKED_ARTICLE_IDS,
  HEAVY_TAB_KEYS,
  MAX_CHART_WINDOW_DAYS,
  OVERVIEW_COLLAPSE_KEY,
  PRODUCT_TAB_KEYS,
  RANGE_STATE_KEY,
  SELECTED_ARTICLE_KEY,
  SHOP_COLLAPSE_KEY,
  SIDEBAR_STATE_KEY,
  STATUS_MP_COLUMNS,
  TRACKED_ARTICLES_KEY,
} from "./js/constants.js";
import {
  clamp,
  deltaClass,
  escapeHtml,
  formatByKind,
  formatDateLabel,
  formatDateTimeLabel,
  formatMetricDelta,
  formatMoney,
  formatNumber,
  formatPercent,
  localIsoDate,
  parseIsoDate,
  safeNumber,
  shiftIsoDate,
} from "./js/formatters.js";
import { emptyBlock, signalMarkup, tagMarkup } from "./js/services/ui-render.js";
import { createChartsService } from "./js/services/charts-service.js";
import { createAnimationService } from "./js/services/animation-service.js";
import {
  buildHighchartsTooltipHtml,
  destroyMountedHighcharts,
  mountHighcharts,
  renderHighchartsHost,
  toggleHighchartsSeries,
} from "./js/services/highcharts-service.js";
import { createInteractionService } from "./js/services/interaction-service.js";
import { createProductTabsService } from "./js/services/product-tabs-service.js";

const content = document.getElementById("content");
const form = document.getElementById("article-form");
const articleInput = document.getElementById("article-input");
const articleAddButton = document.getElementById("article-add-button");
const articleChipList = document.getElementById("article-chip-list");
const startDateInput = document.getElementById("start-date");
const endDateInput = document.getElementById("end-date");
const filterBackButton = document.getElementById("filter-back-button");
const filterRefreshButton = document.getElementById("filter-refresh-button");
const statusPill = document.getElementById("status-pill");
const articleNav = document.getElementById("article-nav");
const articleCount = document.getElementById("article-count");
const articleSelectorButton = document.getElementById("article-selector-button");
const articleSidebar = document.querySelector(".article-sidebar");
const articlePickerShell = document.getElementById("article-picker-modal");
const articlePickerCloseButton = document.getElementById("article-picker-close");
const articlePickerSearch = document.getElementById("article-picker-search");
const pickerMeta = document.getElementById("picker-meta");
const selectedArticleTitle = document.getElementById("selected-article-title");
const selectedArticleCaption = document.getElementById("selected-article-caption");
const sidebarCatalogHost = document.getElementById("sidebar-catalog-host");
const articleCatalogPanel = document.getElementById("article-catalog-panel");
const sidebarToggleButton = document.getElementById("sidebar-toggle");
const sidebarToggleIcon = document.getElementById("sidebar-toggle-icon");
const pageLinkProduct = document.getElementById("page-link-product");
const pageLinkArticles = document.getElementById("page-link-articles");
const sidebarSectionTitle = document.getElementById("sidebar-section-title");
const articlesPageShell = document.getElementById("articles-page-shell");
const articlesPageCatalogHost = document.getElementById("articles-page-catalog-host");
const articlesPageMeta = document.getElementById("articles-page-meta");
const template = document.getElementById("product-template");
const rangePresetSelect = document.getElementById("range-preset-select");
const modalShell = document.getElementById("detail-modal");
const modalTitle = document.getElementById("modal-title");
const modalNote = document.getElementById("modal-note");
const modalBody = document.getElementById("modal-body");

const productStore = new Map();
const chartProductStore = new Map();
const chartProductLoadPromises = new Map();
const articleSummaryStore = new Map();
const productsRequestCache = new Map();
const catalogRequestCache = new Map();
const clusterDetailCache = new Map();
let currentPayload = null;
let selectedArticle = null;
let trackedArticleIds = DEFAULT_TRACKED_ARTICLE_IDS.slice();
let isLoading = false;
let loadingArticle = null;
let catalogData = null;
let catalogQuery = "";
let collapsedShopIds = new Set();
let hasPersistedShopCollapseState = false;
const chartWindowStore = new Map();
const chartLoadingKeys = new Set();
const chartLoadingRequests = new Map();
const campaignCompareStore = new Map();
const activeTabStore = new Map();
const PRODUCTS_REQUEST_CACHE_TTL_MS = 60_000;
const CATALOG_REQUEST_CACHE_TTL_MS = 60_000;
const CATALOG_PERSISTED_CACHE_KEY = "xway-catalog-cache-v2";
const CATALOG_PERSISTED_CACHE_TTL_MS = 5 * 60_000;
const CATALOG_PERSISTED_CACHE_MAX_ENTRIES = 8;
let renderSelectedProductQueued = false;
let topNavResizeObserver = null;
let currentPage = "product";
let overviewSectionCollapseStore = new Map();

const { animateRenderedRoot, installAutoAnimations } = createAnimationService();
installAutoAnimations(document.body);

function setStatus(text, mode = "idle") {
  if (!statusPill) {
    return;
  }
  statusPill.textContent = text;
  statusPill.className = `status-pill ${mode}`;
}
function comparisonPreviousValue(metric) {
  if (!metric || typeof metric !== "object") {
    return null;
  }
  const dynamics = metric.dynamics_sum;
  if (dynamics !== null && dynamics !== undefined && !Number.isNaN(Number(dynamics))) {
    return Number(dynamics);
  }
  const current = metric.filter_sum;
  const diff = metric.diff;
  if (
    current !== null
    && current !== undefined
    && diff !== null
    && diff !== undefined
    && !Number.isNaN(Number(current))
    && !Number.isNaN(Number(diff))
  ) {
    return Number(current) - Number(diff);
  }
  return null;
}
function previousDeltaItems(current, previous, kind = "number", options = {}) {
  if (previous === null || previous === undefined || Number.isNaN(Number(previous))) {
    return [];
  }
  const delta = current === null || current === undefined || Number.isNaN(Number(current))
    ? null
    : Number(current) - Number(previous);
  const items = [
    {
      label: options.previousLabel || "Пред.",
      value: formatByKind(previous, kind),
      tone: "neutral",
    },
  ];
  if (delta !== null) {
    items.push({
      label: options.deltaLabel || "Δ",
      value: formatMetricDelta(delta, kind),
      tone: deltaClass(delta, options.invert),
    });
  }
  return items;
}
function metricDeltaData(current, previous, kind = "number", options = {}) {
  if (previous === null || previous === undefined || Number.isNaN(Number(previous))) {
    return null;
  }
  const delta = current === null || current === undefined || Number.isNaN(Number(current))
    ? null
    : Number(current) - Number(previous);
  return {
    previousValue: formatByKind(previous, kind),
    deltaValue: delta === null ? null : formatMetricDelta(delta, kind),
    deltaTone: deltaClass(delta, options.invert),
  };
}
function metricPrimaryDelta(current, previous, kind = "number", options = {}) {
  const delta = metricDeltaData(current, previous, kind, options);
  if (!delta?.deltaValue) {
    return null;
  }
  return {
    text: delta.deltaValue,
    tone: delta.deltaTone,
  };
}
function metricMetaItem(label, current, kind = "number", options = {}) {
  const delta = metricDeltaData(current, options.previous, kind, options);
  return {
    label,
    value: formatByKind(current, kind),
    deltaText: delta?.deltaValue || "",
    deltaTone: delta?.deltaTone || "",
  };
}
function normalizeChartWindowDays(days) {
  const numeric = Number(days);
  if ([7, 14, 30].includes(numeric)) {
    return numeric;
  }
  return DEFAULT_CHART_WINDOW_DAYS;
}
function scheduleRenderSelectedProduct() {
  if (renderSelectedProductQueued) {
    return;
  }
  renderSelectedProductQueued = true;
  requestAnimationFrame(() => {
    renderSelectedProductQueued = false;
    renderSelectedProduct();
  });
}
function productChartKey(article, suffix) {
  return `product:${String(article || "unknown")}:${String(suffix || "chart")}`;
}
function campaignChartKey(article, campaignId, suffix) {
  return `campaign:${String(article || "unknown")}:${String(campaignId || "unknown")}:${String(suffix || "chart")}`;
}
function getChartWindowDays(chartKey) {
  if (!chartKey) {
    return DEFAULT_CHART_WINDOW_DAYS;
  }
  return normalizeChartWindowDays(chartWindowStore.get(chartKey));
}
function setChartWindowDays(chartKey, days) {
  if (!chartKey) {
    return DEFAULT_CHART_WINDOW_DAYS;
  }
  const normalized = normalizeChartWindowDays(days);
  chartWindowStore.set(chartKey, normalized);
  return normalized;
}
function isChartLoading(chartKey) {
  return Boolean(chartKey) && chartLoadingKeys.has(chartKey);
}
function setChartLoading(chartKey, loading) {
  if (!chartKey) {
    return;
  }
  const hadKey = chartLoadingKeys.has(chartKey);
  if (loading) {
    chartLoadingKeys.add(chartKey);
  } else {
    chartLoadingKeys.delete(chartKey);
  }
  if (hadKey !== chartLoadingKeys.has(chartKey)) {
    scheduleRenderSelectedProduct();
  }
}
function normalizeProductTab(tabName) {
  const normalized = String(tabName || "overview");
  return PRODUCT_TAB_KEYS.includes(normalized) ? normalized : "overview";
}
function getActiveTab(productOrArticle) {
  const article = typeof productOrArticle === "object"
    ? productOrArticle?.article
    : productOrArticle;
  const articleKey = String(article || "");
  if (!articleKey) {
    return "overview";
  }
  return normalizeProductTab(activeTabStore.get(articleKey));
}
function setActiveTab(article, tabName) {
  const articleKey = String(article || "");
  const normalized = normalizeProductTab(tabName);
  if (articleKey) {
    activeTabStore.set(articleKey, normalized);
  }
  return normalized;
}
function isHeavyTab(tabName) {
  return HEAVY_TAB_KEYS.has(normalizeProductTab(tabName));
}
function campaignHasHeavyData(campaign) {
  return Boolean(campaign && campaign._heavy_loaded);
}
function allCampaignIds(product) {
  return (product?.campaigns || [])
    .map((campaign) => campaign?.id)
    .filter((campaignId) => campaignId !== null && campaignId !== undefined)
    .map((campaignId) => String(campaignId));
}
function hasChartCoverage(product, endDate, windowDays) {
  if (!product) {
    return false;
  }
  const normalizedWindow = Math.max(DEFAULT_CHART_WINDOW_DAYS, normalizeChartWindowDays(windowDays));
  const normalizedStart = shiftIsoDate(String(endDate || "").trim(), -(normalizedWindow - 1));
  const periodStart = product.period?.current_start || null;
  const periodEnd = product.period?.current_end || null;
  if (normalizedStart && periodStart && periodEnd) {
    return String(periodEnd) === String(endDate) && String(periodStart) <= String(normalizedStart);
  }
  if (!Array.isArray(product.daily_stats) || !product.daily_stats.length) {
    return false;
  }
  const rows = [...product.daily_stats]
    .filter((row) => row?.day)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
  if (!rows.length) {
    return false;
  }
  const firstDay = rows[0]?.day || null;
  const lastDay = rows[rows.length - 1]?.day || null;
  if (endDate && lastDay && String(lastDay) !== String(endDate)) {
    return false;
  }
  if (normalizedStart && firstDay) {
    return String(firstDay) <= String(normalizedStart);
  }
  return rows.length >= normalizedWindow;
}
function chartCacheKey(article, endDate, windowDays, heavyCampaignIds = []) {
  return `${String(article)}|${String(endDate || "")}|${Math.max(DEFAULT_CHART_WINDOW_DAYS, normalizeChartWindowDays(windowDays))}|${normalizeArticleIds(heavyCampaignIds).join(",")}`;
}
function clonePayload(payload) {
  if (typeof structuredClone === "function") {
    return structuredClone(payload);
  }
  return JSON.parse(JSON.stringify(payload));
}
function getCachedPayload(cacheStore, cacheKey, ttlMs) {
  const entry = cacheStore.get(cacheKey);
  if (!entry || !entry.payload) {
    return null;
  }
  if (Date.now() - Number(entry.createdAt || 0) > ttlMs) {
    cacheStore.delete(cacheKey);
    return null;
  }
  return clonePayload(entry.payload);
}
function getPendingRequest(cacheStore, cacheKey) {
  const entry = cacheStore.get(cacheKey);
  return entry?.pending || null;
}
function setPendingRequest(cacheStore, cacheKey, requestPromise) {
  const entry = cacheStore.get(cacheKey) || {};
  cacheStore.set(cacheKey, {
    ...entry,
    pending: requestPromise,
  });
}
function clearPendingRequest(cacheStore, cacheKey) {
  const entry = cacheStore.get(cacheKey);
  if (!entry) {
    return;
  }
  if (entry.payload) {
    cacheStore.set(cacheKey, {
      payload: entry.payload,
      createdAt: entry.createdAt,
    });
    return;
  }
  cacheStore.delete(cacheKey);
}
function setCachedPayload(cacheStore, cacheKey, payload) {
  cacheStore.set(cacheKey, {
    payload: clonePayload(payload),
    createdAt: Date.now(),
  });
}
function readPersistedCatalogCache() {
  try {
    const raw = window.localStorage.getItem(CATALOG_PERSISTED_CACHE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}
function writePersistedCatalogCache(cacheMap) {
  try {
    window.localStorage.setItem(CATALOG_PERSISTED_CACHE_KEY, JSON.stringify(cacheMap));
  } catch {
    // Ignore quota/cache write errors; in-memory cache still works.
  }
}
function getPersistedCatalogPayload(cacheKey, ttlMs = CATALOG_PERSISTED_CACHE_TTL_MS) {
  const cacheMap = readPersistedCatalogCache();
  const entry = cacheMap?.[cacheKey];
  if (!entry || !entry.payload) {
    return null;
  }
  if (Date.now() - Number(entry.createdAt || 0) > ttlMs) {
    delete cacheMap[cacheKey];
    writePersistedCatalogCache(cacheMap);
    return null;
  }
  return clonePayload(entry.payload);
}
function setPersistedCatalogPayload(cacheKey, payload) {
  const cacheMap = readPersistedCatalogCache();
  cacheMap[cacheKey] = {
    createdAt: Date.now(),
    payload: clonePayload(payload),
  };
  const keys = Object.keys(cacheMap);
  if (keys.length > CATALOG_PERSISTED_CACHE_MAX_ENTRIES) {
    keys
      .sort((left, right) => Number(cacheMap[left]?.createdAt || 0) - Number(cacheMap[right]?.createdAt || 0))
      .slice(0, keys.length - CATALOG_PERSISTED_CACHE_MAX_ENTRIES)
      .forEach((key) => {
        delete cacheMap[key];
      });
  }
  writePersistedCatalogCache(cacheMap);
}
function buildProductsQuery(articleIds, start, end, options = {}) {
  const params = new URLSearchParams();
  params.set("articles", normalizeArticleIds(articleIds).join(","));
  if (start) {
    params.set("start", start);
  }
  if (end) {
    params.set("end", end);
  }
  if (options.campaignMode) {
    params.set("campaign_mode", String(options.campaignMode));
  }
  const heavyCampaignIds = normalizeArticleIds(options.heavyCampaignIds || []);
  if (heavyCampaignIds.length) {
    params.set("heavy_campaign_ids", heavyCampaignIds.join(","));
  }
  return params;
}
async function fetchProductsPayload(articleIds, start, end, fallbackError = "Не удалось загрузить данные.", requestOptions = {}) {
  const params = buildProductsQuery(articleIds, start, end, requestOptions);
  const cacheKey = params.toString();
  const cached = getCachedPayload(productsRequestCache, cacheKey, PRODUCTS_REQUEST_CACHE_TTL_MS);
  if (cached) {
    return cached;
  }
  const pending = getPendingRequest(productsRequestCache, cacheKey);
  if (pending) {
    return pending;
  }

  const requestPromise = (async () => {
    const response = await fetch(`/api/products?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || fallbackError);
    }
    setCachedPayload(productsRequestCache, cacheKey, payload);
    return payload;
  })();

  setPendingRequest(productsRequestCache, cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    clearPendingRequest(productsRequestCache, cacheKey);
  }
}
async function fetchCatalogPayload(start, end, fallbackError = "Не удалось загрузить каталог кабинетов.") {
  const params = new URLSearchParams();
  if (start) {
    params.set("start", start);
  }
  if (end) {
    params.set("end", end);
  }
  params.set("mode", "full");
  const cacheKey = params.toString();
  const cached = getCachedPayload(catalogRequestCache, cacheKey, CATALOG_REQUEST_CACHE_TTL_MS);
  if (cached) {
    return cached;
  }
  const persisted = getPersistedCatalogPayload(cacheKey, CATALOG_PERSISTED_CACHE_TTL_MS);
  if (persisted) {
    setCachedPayload(catalogRequestCache, cacheKey, persisted);
    return persisted;
  }
  const pending = getPendingRequest(catalogRequestCache, cacheKey);
  if (pending) {
    return pending;
  }

  const requestPromise = (async () => {
    const response = await fetch(`/api/catalog?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || fallbackError);
    }
    setCachedPayload(catalogRequestCache, cacheKey, payload);
    setPersistedCatalogPayload(cacheKey, payload);
    return payload;
  })();

  setPendingRequest(catalogRequestCache, cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    clearPendingRequest(catalogRequestCache, cacheKey);
  }
}
function chartPreloadStart(endDate) {
  return shiftIsoDate(endDate, -(MAX_CHART_WINDOW_DAYS - 1));
}
function selectedRangeCoversChartPreload(startDate, endDate) {
  const preloadStart = chartPreloadStart(endDate);
  if (!startDate || !endDate || !preloadStart) {
    return false;
  }
  return String(startDate) <= String(preloadStart);
}
function cacheChartProducts(products = []) {
  (products || []).forEach((product) => {
    if (product?.article !== undefined && product?.article !== null) {
      chartProductStore.set(String(product.article), product);
    }
  });
}
function clearChartLoadingForArticles(articleIds = []) {
  const normalizedIds = normalizeArticleIds(articleIds);
  if (!normalizedIds.length) {
    return;
  }
  const prefixes = normalizedIds.flatMap((article) => [
    `product:${article}:`,
    `campaign:${article}:`,
  ]);
  Array.from(chartLoadingKeys).forEach((key) => {
    if (prefixes.some((prefix) => String(key).startsWith(prefix))) {
      chartLoadingKeys.delete(key);
    }
  });
  Array.from(chartLoadingRequests.keys()).forEach((key) => {
    if (prefixes.some((prefix) => String(key).startsWith(prefix))) {
      chartLoadingRequests.delete(key);
    }
  });
}
async function ensureChartProductRange(article, endDate, windowDays, options = {}) {
  const normalizedArticle = String(article || "").trim();
  const normalizedEnd = String(endDate || "").trim();
  const normalizedWindow = Math.max(DEFAULT_CHART_WINDOW_DAYS, normalizeChartWindowDays(windowDays));
  const requiredHeavyCampaignIds = normalizeArticleIds(options.heavyCampaignIds || []);
  if (!normalizedArticle || !normalizedEnd) {
    return null;
  }

  const existing = chartProductStore.get(normalizedArticle);
  if (existing && hasChartCoverage(existing, normalizedEnd, normalizedWindow) && productHasCampaignHeavy(existing, requiredHeavyCampaignIds)) {
    return existing;
  }

  const requestKey = chartCacheKey(normalizedArticle, normalizedEnd, normalizedWindow, requiredHeavyCampaignIds);
  const existingPromise = chartProductLoadPromises.get(requestKey);
  if (existingPromise) {
    return existingPromise;
  }

  const startDate = shiftIsoDate(normalizedEnd, -(normalizedWindow - 1));
  if (!startDate) {
    return null;
  }

  const promise = (async () => {
    try {
      const payload = await fetchProductsPayload(
        [normalizedArticle],
        startDate,
        normalizedEnd,
        "Не удалось загрузить данные для графика.",
        { campaignMode: "summary", heavyCampaignIds: requiredHeavyCampaignIds },
      );
      const chartProduct = (payload.products || [])[0];
      if (!chartProduct) {
        return null;
      }
      chartProductStore.set(normalizedArticle, chartProduct);
      return chartProduct;
    } catch (_error) {
      return null;
    } finally {
      chartProductLoadPromises.delete(requestKey);
    }
  })();

  chartProductLoadPromises.set(requestKey, promise);
  return promise;
}
function requestChartRange(chartKey, article, endDate, windowDays, options = {}) {
  const normalizedKey = String(chartKey || "").trim();
  const normalizedArticle = String(article || "").trim();
  const normalizedEnd = String(endDate || "").trim();
  const normalizedWindow = Math.max(DEFAULT_CHART_WINDOW_DAYS, normalizeChartWindowDays(windowDays));
  const requiredHeavyCampaignIds = normalizeArticleIds(options.heavyCampaignIds || []);
  if (!normalizedKey || !normalizedArticle || !normalizedEnd) {
    return;
  }
  const requestKey = chartCacheKey(normalizedArticle, normalizedEnd, normalizedWindow, requiredHeavyCampaignIds);
  if (chartLoadingRequests.get(normalizedKey) === requestKey) {
    return;
  }
  chartLoadingRequests.set(normalizedKey, requestKey);
  setChartLoading(normalizedKey, true);
  ensureChartProductRange(normalizedArticle, normalizedEnd, normalizedWindow, {
    heavyCampaignIds: requiredHeavyCampaignIds,
  }).finally(() => {
    if (chartLoadingRequests.get(normalizedKey) === requestKey) {
      chartLoadingRequests.delete(normalizedKey);
    }
    setChartLoading(normalizedKey, false);
  });
}
function getChartRenderContext(product, chartKey, options = {}) {
  if (!product) {
    return {
      product,
      chartKey,
      windowDays: getChartWindowDays(chartKey),
      loading: isChartLoading(chartKey),
    };
  }
  const requiredHeavyCampaignIds = normalizeArticleIds(options.heavyCampaignIds || []);
  const normalizedWindow = Math.max(DEFAULT_CHART_WINDOW_DAYS, getChartWindowDays(chartKey));
  const endDate = product.period?.current_end || product.daily_stats?.[product.daily_stats.length - 1]?.day || null;
  const article = String(product.article || "");
  if (hasChartCoverage(product, endDate, normalizedWindow) && productHasCampaignHeavy(product, requiredHeavyCampaignIds)) {
    return {
      product,
      chartKey,
      windowDays: normalizedWindow,
      loading: false,
    };
  }
  const cached = chartProductStore.get(article);
  if (cached && hasChartCoverage(cached, endDate, normalizedWindow) && productHasCampaignHeavy(cached, requiredHeavyCampaignIds)) {
    return {
      product: cached,
      chartKey,
      windowDays: normalizedWindow,
      loading: false,
    };
  }
  requestChartRange(chartKey, article, endDate, normalizedWindow, {
    heavyCampaignIds: requiredHeavyCampaignIds,
  });
  return {
    product: cached && (cached.period?.current_end === endDate) ? cached : product,
    chartKey,
    windowDays: normalizedWindow,
    loading: true,
  };
}
function findCampaignById(product, campaignId) {
  return ((product?.campaigns) || []).find((campaign) => String(campaign.id) === String(campaignId)) || null;
}
function productHasCampaignHeavy(product, campaignIds = []) {
  const normalizedIds = new Set((campaignIds || []).map((campaignId) => String(campaignId || "")).filter(Boolean));
  if (!normalizedIds.size) {
    return true;
  }
  return Array.from(normalizedIds).every((campaignId) => campaignHasHeavyData(findCampaignById(product, campaignId)));
}
function productHasAllCampaignHeavy(product) {
  const campaigns = product?.campaigns || [];
  if (!campaigns.length) {
    return true;
  }
  return campaigns.every(campaignHasHeavyData);
}
function getCampaignChartContext(product, campaign, suffix) {
  const chartKey = campaignChartKey(product?.article, campaign?.id, suffix);
  const context = getChartRenderContext(product, chartKey, {
    heavyCampaignIds: campaign?.id != null ? [String(campaign.id)] : [],
  });
  const sourceProduct = context.product || product;
  return {
    chartKey,
    windowDays: context.windowDays,
    loading: context.loading,
    product: sourceProduct,
    campaign: findCampaignById(sourceProduct, campaign?.id) || campaign,
    baseRows: sourceProduct?.daily_stats || product?.daily_stats || [],
  };
}
function lastDaysRange(days = 7) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (days - 1));
  return { start: localIsoDate(start), end: localIsoDate(end) };
}
function singleDayRange(offsetDays = 0) {
  const day = new Date();
  day.setDate(day.getDate() + offsetDays);
  const iso = localIsoDate(day);
  return { start: iso, end: iso };
}
function presetRangeForKey(value) {
  const key = String(value || "").trim();
  if (!key || key === "custom") {
    return lastDaysRange(7);
  }
  if (key === "today") {
    return singleDayRange(0);
  }
  if (key === "yesterday") {
    return singleDayRange(-1);
  }
  const days = Number(key);
  return lastDaysRange(Number.isFinite(days) && days > 0 ? days : 7);
}
function normalizeArticleIds(values) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => String(value || "").split(/[\s,;]+/))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}
function decodePathname(pathname = window.location.pathname) {
  try {
    return decodeURIComponent(pathname || "/");
  } catch {
    return pathname || "/";
  }
}
function pagePathFor(pageKey = "product") {
  return pageKey === "articles" ? "/артикулы" : "/товар";
}
function resolveCurrentPageFromLocation() {
  return decodePathname() === pagePathFor("articles") ? "articles" : "product";
}
function buildPageUrl(pageKey = "product", options = {}) {
  const article = String(options.article || "").trim();
  const start = String(options.start || "").trim();
  const end = String(options.end || "").trim();
  const path = pagePathFor(pageKey);
  const params = new URLSearchParams();
  if (pageKey === "product" && article) {
    params.set("article", article);
  }
  if (start) {
    params.set("start", start);
  }
  if (end) {
    params.set("end", end);
  }
  if (params.size) {
    return `${path}?${params.toString()}`;
  }
  return path;
}
function navigateToPage(pageKey = "product", options = {}) {
  window.location.assign(buildPageUrl(pageKey, options));
}
function openProductInNewTab(article, options = {}) {
  const articleKey = String(article || "").trim();
  if (!articleKey) {
    return;
  }
  const url = buildPageUrl("product", {
    article: articleKey,
    start: options.start || startDateInput?.value,
    end: options.end || endDateInput?.value,
  });
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
function loadSelectedArticleFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return normalizeArticleIds([params.get("article") || ""])[0] || null;
}
function mountArticleCatalogPanel() {
  const targetHost = currentPage === "articles" ? articlesPageCatalogHost : sidebarCatalogHost;
  if (articleCatalogPanel && targetHost && articleCatalogPanel.parentElement !== targetHost) {
    targetHost.appendChild(articleCatalogPanel);
  }
  if (articlesPageShell) {
    articlesPageShell.hidden = currentPage !== "articles";
  }
  if (content) {
    content.hidden = currentPage === "articles";
  }
}
function syncPageChrome() {
  const currentArticle = selectedArticle || trackedArticleIds[0] || "";
  document.body.classList.toggle("page-view-product", currentPage === "product");
  document.body.classList.toggle("page-view-articles", currentPage === "articles");
  if (pageLinkProduct) {
    pageLinkProduct.href = buildPageUrl("product", { article: currentArticle });
    pageLinkProduct.classList.toggle("is-active", currentPage === "product");
    pageLinkProduct.setAttribute("aria-current", currentPage === "product" ? "page" : "false");
  }
  if (pageLinkArticles) {
    pageLinkArticles.href = buildPageUrl("articles", {
      start: startDateInput?.value,
      end: endDateInput?.value,
    });
    pageLinkArticles.classList.toggle("is-active", currentPage === "articles");
    pageLinkArticles.setAttribute("aria-current", currentPage === "articles" ? "page" : "false");
  }
  if (sidebarSectionTitle) {
    sidebarSectionTitle.textContent = currentPage === "articles" ? "Выбранный артикул" : "Товар";
  }
  if (filterBackButton) {
    filterBackButton.hidden = currentPage !== "product";
  }
  if (filterRefreshButton) {
    filterRefreshButton.hidden = currentPage !== "product";
  }
  if (articleSelectorButton) {
    articleSelectorButton.setAttribute(
      "aria-label",
      currentPage === "articles" ? "Открыть страницу товара" : "Открыть страницу артикулов",
    );
    articleSelectorButton.classList.remove("is-open");
    articleSelectorButton.setAttribute("aria-expanded", "false");
  }
  mountArticleCatalogPanel();
}
function normalizeInitialPageUrl() {
  if (decodePathname() !== "/") {
    return;
  }
  window.history.replaceState(null, "", buildPageUrl(currentPage, { article: selectedArticle || trackedArticleIds[0] || "" }));
}
function getArticleIds() {
  return trackedArticleIds.slice();
}
function readJsonStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function loadStoredTrackedArticleIds() {
  const stored = readJsonStorage(TRACKED_ARTICLES_KEY, DEFAULT_TRACKED_ARTICLE_IDS);
  const normalized = normalizeArticleIds(Array.isArray(stored) ? stored : DEFAULT_TRACKED_ARTICLE_IDS);
  return normalized.length ? normalized : DEFAULT_TRACKED_ARTICLE_IDS.slice();
}
function loadStoredSelectedArticle(articleIds = trackedArticleIds) {
  const stored = normalizeArticleIds([window.localStorage.getItem(SELECTED_ARTICLE_KEY) || ""])[0];
  if (stored && articleIds.includes(stored)) {
    return stored;
  }
  return articleIds[0] || null;
}
function loadStoredRange() {
  const params = new URLSearchParams(window.location.search);
  const urlStart = String(params.get("start") || "").trim();
  const urlEnd = String(params.get("end") || "").trim();
  const isIso = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (isIso(urlStart) && isIso(urlEnd) && urlStart <= urlEnd) {
    return { start: urlStart, end: urlEnd };
  }
  const stored = readJsonStorage(RANGE_STATE_KEY, null);
  if (stored && stored.start && stored.end) {
    return { start: stored.start, end: stored.end };
  }
  return lastDaysRange(7);
}
function loadStoredArticleSummaries() {
  const stored = readJsonStorage(ARTICLE_SUMMARY_KEY, {});
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return;
  }
  Object.entries(stored).forEach(([article, summary]) => {
    if (summary && typeof summary === "object") {
      articleSummaryStore.set(String(article), summary);
    }
  });
}
function loadStoredCollapsedShops() {
  const raw = window.localStorage.getItem(SHOP_COLLAPSE_KEY);
  hasPersistedShopCollapseState = raw !== null;
  if (!raw) {
    return new Set();
  }
  try {
    const stored = JSON.parse(raw);
    return new Set(Array.isArray(stored) ? stored.map((item) => String(item)) : []);
  } catch {
    return new Set();
  }
}
function loadStoredOverviewSectionCollapses() {
  const stored = readJsonStorage(OVERVIEW_COLLAPSE_KEY, {});
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return new Map();
  }
  return new Map(
    Object.entries(stored).map(([article, sectionKeys]) => [
      String(article),
      new Set(Array.isArray(sectionKeys) ? sectionKeys.map((item) => String(item)) : []),
    ]),
  );
}
function persistTrackedArticleIds() {
  window.localStorage.setItem(TRACKED_ARTICLES_KEY, JSON.stringify(trackedArticleIds));
}
function persistSelectedArticle() {
  if (!selectedArticle) {
    window.localStorage.removeItem(SELECTED_ARTICLE_KEY);
    return;
  }
  window.localStorage.setItem(SELECTED_ARTICLE_KEY, String(selectedArticle));
}
function persistRangeState(start = startDateInput.value, end = endDateInput.value) {
  window.localStorage.setItem(RANGE_STATE_KEY, JSON.stringify({ start, end }));
}
function persistArticleSummaries() {
  const stored = {};
  articleSummaryStore.forEach((summary, article) => {
    stored[article] = summary;
  });
  window.localStorage.setItem(ARTICLE_SUMMARY_KEY, JSON.stringify(stored));
}
function persistCollapsedShops() {
  window.localStorage.setItem(SHOP_COLLAPSE_KEY, JSON.stringify(Array.from(collapsedShopIds)));
}
function persistOverviewSectionCollapses() {
  const stored = {};
  overviewSectionCollapseStore.forEach((sections, article) => {
    if (sections instanceof Set && sections.size) {
      stored[String(article)] = Array.from(sections);
    }
  });
  window.localStorage.setItem(OVERVIEW_COLLAPSE_KEY, JSON.stringify(stored));
}
function getOverviewSectionCollapsed(article, sectionKey) {
  const articleKey = String(article || "").trim();
  const key = String(sectionKey || "").trim();
  if (!articleKey || !key) {
    return false;
  }
  return overviewSectionCollapseStore.get(articleKey)?.has(key) || false;
}
function toggleOverviewSectionCollapsed(article, sectionKey) {
  const articleKey = String(article || "").trim();
  const key = String(sectionKey || "").trim();
  if (!articleKey || !key) {
    return;
  }
  const current = overviewSectionCollapseStore.get(articleKey) || new Set();
  if (current.has(key)) {
    current.delete(key);
  } else {
    current.add(key);
  }
  if (current.size) {
    overviewSectionCollapseStore.set(articleKey, current);
  } else {
    overviewSectionCollapseStore.delete(articleKey);
  }
  persistOverviewSectionCollapses();
  renderSelectedProduct();
}
function syncPresetButtons(start, end) {
  if (!rangePresetSelect) {
    return;
  }
  const presetKeys = ["today", "yesterday", "3", "7", "14", "30"];
  const matchedKey = presetKeys.find((key) => {
    const preset = presetRangeForKey(key);
    return preset.start === start && preset.end === end;
  });
  rangePresetSelect.value = matchedKey || "custom";
}
function metricState(key, value) {
  const numeric = safeNumber(value, null);
  if (numeric === null) {
    return { tone: "neutral", badge: "нет данных", hint: "показатель пока пуст" };
  }

  if (key === "stock") {
    if (numeric < 50) {
      return { tone: "risk", badge: "низкий запас", hint: "нужно контролировать остаток" };
    }
    if (numeric < 150) {
      return { tone: "warn", badge: "контроль", hint: "запас ниже комфортного" };
    }
    return { tone: "inventory", badge: "запас есть", hint: "остаток позволяет крутить рекламу" };
  }

  if (key === "drr") {
    if (numeric <= 10) {
      return { tone: "good", badge: "норма", hint: "ДРР в зеленой зоне" };
    }
    if (numeric <= 15) {
      return { tone: "warn", badge: "порог", hint: "ДРР уже требует внимания" };
    }
    return { tone: "risk", badge: "перерасход", hint: "ДРР выше комфортного уровня" };
  }

  if (key === "ctr") {
    if (numeric >= 2) {
      return { tone: "good", badge: "сильный CTR", hint: "креатив и ставка цепляют" };
    }
    if (numeric >= 1) {
      return { tone: "warn", badge: "средний CTR", hint: "есть запас по кликабельности" };
    }
    return { tone: "risk", badge: "слабый CTR", hint: "креатив или ставка проседают" };
  }

  if (key === "cr") {
    if (numeric >= 5) {
      return { tone: "good", badge: "сильный CR", hint: "трафик конвертируется в заказы" };
    }
    if (numeric >= 2) {
      return { tone: "warn", badge: "средний CR", hint: "конверсия требует контроля" };
    }
    return { tone: "risk", badge: "слабый CR", hint: "нужно проверить трафик и карточку" };
  }

  if (key === "cpc") {
    if (numeric <= 15) {
      return { tone: "good", badge: "дешевый клик", hint: "стоимость клика комфортная" };
    }
    if (numeric <= 25) {
      return { tone: "warn", badge: "дороже нормы", hint: "клик дорожает" };
    }
    return { tone: "risk", badge: "дорогой клик", hint: "стоимость трафика завышена" };
  }

  if (key === "cpo" || key === "cpo_overall") {
    if (numeric <= 300) {
      return { tone: "good", badge: "эффективно", hint: "цена заказа в зеленой зоне" };
    }
    if (numeric <= 500) {
      return { tone: "warn", badge: "на грани", hint: "цена заказа растет" };
    }
    return { tone: "risk", badge: "дорого", hint: "цена заказа требует снижения" };
  }

  if (key === "expense" || key === "cpc_cost") {
    return { tone: "cost", badge: "расход", hint: "контролируйте возврат от вложений" };
  }

  if (key === "views" || key === "clicks") {
    return { tone: "traffic", badge: "трафик", hint: "верхняя часть воронки" };
  }

  if (key === "orders" || key === "ordered_total") {
    return { tone: "orders", badge: "заказы", hint: "ключевой итог продаж" };
  }

  if (key === "revenue" || key === "revenue_total") {
    return { tone: "revenue", badge: "выручка", hint: "денежный результат за окно" };
  }

  return { tone: "neutral", badge: "метрика", hint: "сводный показатель" };
}
function metricTile(label, value, options = {}) {
  const state = options.state || { tone: "neutral", hint: "" };
  const metaItems = Array.isArray(options.metaItems) ? options.metaItems.filter((item) => item?.value) : [];
  const primaryMarkup = renderMetricLevel({
    label,
    value,
    deltaText: options.primaryDelta?.text,
    deltaTone: options.primaryDelta?.tone,
  });
  const detailMarkup = metaItems
    .map((item) => renderMetricLevel({
      label: item.label,
      value: item.value,
      deltaText: item.deltaText,
      deltaTone: item.deltaTone,
    }))
    .join("");
  return `
    <div class="metric-tile tone-${escapeHtml(state.tone)}">
      <div class="metric-level-list">
        ${primaryMarkup}
        ${detailMarkup}
      </div>
    </div>
  `;
}
function renderMetricLevel({ label, value, deltaText = "", deltaTone = "", actionMarkup = "" } = {}) {
  return `
    <div class="metric-level${actionMarkup ? " has-action" : ""}">
      ${actionMarkup ? `<div class="metric-level-action">${actionMarkup}</div>` : ""}
      ${label ? `
        <div class="metric-level-head">
          <span class="metric-level-label">${escapeHtml(label)}</span>
        </div>
      ` : ""}
      <div class="metric-level-value-row">
        <strong class="metric-level-value">${escapeHtml(value)}</strong>
        ${deltaText ? `<span class="metric-level-delta ${escapeHtml(deltaTone || "")}">(${escapeHtml(deltaText)})</span>` : ""}
      </div>
    </div>
  `;
}
function combinedOrdersTile(totals, comparison = {}) {
  const shareFromAds = computeRate(totals.orders, totals.ordered_total);
  const prevOrders = comparisonPreviousValue(comparison.orders);
  const prevAtbs = comparisonPreviousValue(comparison.atbs);
  const prevCr2 = computeRate(prevOrders, prevAtbs);
  const leftStats = [
    metricMetaItem("CPO", totals.CPO, "money", { previous: comparisonPreviousValue(comparison.cpo), invert: true }),
    metricMetaItem("CR2", computeRate(totals.orders, totals.atbs), "percent", { previous: prevCr2 }),
    metricMetaItem("% с РК", shareFromAds, "percent"),
  ].filter((item) => item?.value);
  const rightStats = [
    metricMetaItem("CPO общий", totals.CPO_overall, "money", {
      previous: comparisonPreviousValue(comparison.cpo_overall),
      invert: true,
    }),
    metricMetaItem("С доп. продажами", totals.CPO_with_rel, "money", {
      previous: comparisonPreviousValue(comparison.cpo_with_rel),
      invert: true,
    }),
  ].filter((item) => item?.value);
  return `
    <div class="metric-tile metric-tile-combined wide tone-neutral">
      <div class="metric-combined-columns">
        <div class="metric-combined-column metric-combined-left">
          <div class="metric-level-list">
            ${renderMetricLevel({
              label: "Заказы с РК",
              value: formatNumber(totals.orders, 0),
            })}
            ${leftStats
              .map((item) => renderMetricLevel({
                label: item.label,
                value: item.value,
                deltaText: item.deltaText,
                deltaTone: item.deltaTone,
              }))
              .join("")}
          </div>
        </div>
        <div class="metric-combined-column metric-combined-right">
          <div class="metric-level-list">
            ${renderMetricLevel({
              label: "Заказов всего",
              value: formatNumber(totals.ordered_total, 0),
            })}
            ${rightStats
              .map((item) => renderMetricLevel({
                label: item.label,
                value: item.value,
                deltaText: item.deltaText,
                deltaTone: item.deltaTone,
              }))
              .join("")}
          </div>
        </div>
      </div>
    </div>
  `;
}
function combinedFunnelTile(totals, comparison = {}, product = null) {
  const prevViews = comparisonPreviousValue(comparison.views);
  const prevClicks = comparisonPreviousValue(comparison.clicks);
  const prevAtbs = comparisonPreviousValue(comparison.atbs);
  const prevOrders = comparisonPreviousValue(comparison.orders);
  const prevOrderedTotal = comparisonPreviousValue(comparison.ordered_total);
  const prevExpense = comparisonPreviousValue(comparison.sum);
  const prevRevenueAds = comparisonPreviousValue(comparison.sum_price);
  const prevRevenueTotal = comparisonPreviousValue(comparison.ordered_sum_total);
  const prevCpm = computeCpm(prevExpense, prevViews);
  const prevCtr = comparisonPreviousValue(comparison.ctr);
  const prevCr1 = computeRate(prevAtbs, prevClicks);
  const prevCr2 = computeRate(prevOrders, prevAtbs);
  const prevCpl = prevAtbs ? Number(prevExpense || 0) / Number(prevAtbs) : null;
  const averageOrderPrice = totals.orders ? Number(totals.sum_price || 0) / Number(totals.orders) : null;
  const prevAverageOrderPrice = prevOrders ? Number(prevRevenueAds || 0) / Number(prevOrders) : null;
  const drrOrders = averageOrderPrice && totals.orders
    ? (Number(totals.expense_sum || 0) / (averageOrderPrice * Number(totals.orders))) * 100
    : null;
  const drrAtbs = averageOrderPrice && totals.atbs
    ? (Number(totals.expense_sum || 0) / (averageOrderPrice * Number(totals.atbs))) * 100
    : null;
  const prevDrrOrders = prevAverageOrderPrice && prevOrders
    ? (Number(prevExpense || 0) / (prevAverageOrderPrice * Number(prevOrders))) * 100
    : null;
  const prevDrrAtbs = prevAverageOrderPrice && prevAtbs
    ? (Number(prevExpense || 0) / (prevAverageOrderPrice * Number(prevAtbs))) * 100
    : null;
  const drrOrdersTotal = totals.ordered_sum_total
    ? (Number(totals.expense_sum || 0) / Number(totals.ordered_sum_total)) * 100
    : null;
  const prevDrrOrdersTotal = prevRevenueTotal
    ? (Number(prevExpense || 0) / Number(prevRevenueTotal)) * 100
    : null;
  const shareFromAds = computeRate(totals.orders, totals.ordered_total);
  const basketDrrMetric = metricMetaItem("ДРР корзин", drrAtbs, "percent", {
    previous: prevDrrAtbs,
    invert: true,
  });
  const adsOrdersDrrMetric = metricMetaItem("ДРР заказов (рк)", drrOrders, "percent", {
    previous: prevDrrOrders,
    invert: true,
  });
  const totalOrdersDrrMetric = metricMetaItem("ДРР заказов (всего)", drrOrdersTotal, "percent", {
    previous: prevDrrOrdersTotal,
    invert: true,
  });

  function drrTrendRows(product, maxDays = 7) {
    const rows = Array.isArray(product?.daily_stats) ? product.daily_stats : [];
    if (!rows.length) {
      return [];
    }
    return rows
      .filter((row) => row?.day)
      .slice()
      .sort((left, right) => String(left.day).localeCompare(String(right.day)))
      .slice(-Math.max(2, maxDays))
      .map((row) => {
        const expense = safeNumber(row.expense_sum, null);
        const sumPrice = safeNumber(row.sum_price, null);
        const orderedSumTotal = safeNumber(row.ordered_sum_total, null);
        const orders = safeNumber(row.orders, null);
        const atbs = safeNumber(row.atbs, null);
        const drrOrdersValue = (expense !== null && sumPrice !== null && sumPrice > 0)
          ? (expense / sumPrice) * 100
          : null;
        const averageOrderPrice = (sumPrice !== null && orders !== null && orders > 0)
          ? sumPrice / orders
          : null;
        const drrAtbsValue = (expense !== null && averageOrderPrice !== null && atbs !== null && atbs > 0)
          ? (expense / (averageOrderPrice * atbs)) * 100
          : null;
        const drrOrdersTotalValue = (expense !== null && orderedSumTotal !== null && orderedSumTotal > 0)
          ? (expense / orderedSumTotal) * 100
          : null;
        return {
          day: row.day,
          dayLabel: formatDateLabel(row.day),
          drrOrders: drrOrdersValue,
          drrAtbs: drrAtbsValue,
          drrOrdersTotal: drrOrdersTotalValue,
        };
      });
  }

  function renderCompactDrrSparkline(rows, valueField, tone, label) {
    if (rows.length < 2) {
      return "";
    }
    const values = rows.map((row) => row[valueField]);
    const validValues = values.filter(
      (value) => value !== null && value !== undefined && !Number.isNaN(Number(value)),
    );
    if (!validValues.length) {
      return "";
    }
    const categories = rows.map((row) => row.dayLabel || "—");
    const chartMarkup = renderHighchartsHost(
      () => ({
        chart: {
          backgroundColor: "transparent",
          height: 24,
          margin: [1, 1, 1, 1],
          spacing: [1, 1, 1, 1],
        },
        xAxis: {
          categories,
          visible: false,
          lineWidth: 0,
          tickLength: 0,
        },
        yAxis: {
          visible: false,
          min: Math.min(...validValues, 0),
          max: Math.max(...validValues, 1),
          startOnTick: false,
          endOnTick: false,
          title: {
            text: undefined,
          },
        },
        tooltip: {
          enabled: true,
          shared: true,
          useHTML: true,
          outside: true,
          hideDelay: 0,
          formatter: function formatter() {
            const point = this.point || this.points?.find((entry) => entry?.point?.custom)?.point || this.points?.[0]?.point || {};
            return buildHighchartsTooltipHtml(
              point.custom?.title || this.key || "—",
              point.custom?.lines || [`${label}: ${formatPercent(point?.y)}`],
            );
          },
        },
        plotOptions: {
          series: {
            animation: false,
            enableMouseTracking: true,
            lineWidth: 2,
            marker: {
              enabled: false,
              states: {
                hover: {
                  enabled: true,
                  radius: 3,
                },
              },
            },
            states: {
              hover: {
                lineWidthPlus: 0,
              },
            },
          },
        },
        series: [
          {
            type: "line",
            color: tone === "basket" ? "#3d82d8" : tone === "total-orders" ? "#3e9d69" : "#f17828",
            data: values.map((value, index) => ({
              y: Number(value),
              custom: {
                title: categories[index] || "—",
                lines: [`${label}: ${formatPercent(value)}`],
              },
            })),
          },
        ],
      }),
      {
        className: "metric-funnel-tab-mini-chart",
        height: 24,
        prefix: "spark",
      },
    );

    return `
      <div class="metric-funnel-tab-mini-slot" aria-label="${escapeHtml(label)} за последние 7 дней">
        <div class="chart-shell metric-funnel-tab-mini-shell">${chartMarkup}</div>
      </div>
    `;
  }

  function renderTopTab(metric, tone = "neutral", options = {}) {
    if (!metric) {
      return "";
    }
    const miniChartMarkup = options.miniChartMarkup || "";
    return `
      <div class="metric-funnel-tab tone-${escapeHtml(tone)}">
        <span class="metric-funnel-tab-label">${escapeHtml(metric.label)}</span>
        <div class="metric-funnel-tab-value-row ${miniChartMarkup ? "has-mini-chart" : ""}">
          <div class="metric-funnel-tab-value-stack">
            <strong class="metric-funnel-tab-value">${escapeHtml(metric.value)}</strong>
            ${metric.deltaText ? `<span class="metric-funnel-tab-delta ${escapeHtml(metric.deltaTone || "")}">(${escapeHtml(metric.deltaText)})</span>` : ""}
          </div>
          ${miniChartMarkup}
        </div>
      </div>
    `;
  }

  const drrTrend = drrTrendRows(product, 7);

  const columns = [
    {
      label: "Просмотры",
      value: formatNumber(totals.views, 0),
      delta: metricPrimaryDelta(totals.views, prevViews),
      meta: [
        metricMetaItem("CPM", computeCpm(totals.expense_sum, totals.views), "money", {
          previous: prevCpm,
          invert: true,
        }),
      ],
    },
    {
      label: "Клики",
      value: formatNumber(totals.clicks, 0),
      delta: metricPrimaryDelta(totals.clicks, prevClicks),
      meta: [
        metricMetaItem("CPC", totals.CPC, "money", {
          previous: comparisonPreviousValue(comparison.cpc),
          invert: true,
        }),
        metricMetaItem("CTR", totals.CTR, "percent", {
          previous: prevCtr,
        }),
      ],
    },
    {
      label: "Корзины",
      value: formatNumber(totals.atbs, 0),
      delta: metricPrimaryDelta(totals.atbs, prevAtbs),
      topMetric: basketDrrMetric,
      topTone: "basket",
      topMiniChartMarkup: renderCompactDrrSparkline(drrTrend, "drrAtbs", "basket", "ДРР корзин"),
      meta: [
        metricMetaItem("CPL", totals.atbs ? Number(totals.expense_sum || 0) / Number(totals.atbs) : null, "money", {
          previous: prevCpl,
          invert: true,
        }),
        metricMetaItem("CR1", computeRate(totals.atbs, totals.clicks), "percent", {
          previous: prevCr1,
        }),
      ],
    },
    {
      label: "Заказы с РК",
      value: formatNumber(totals.orders, 0),
      delta: metricPrimaryDelta(totals.orders, prevOrders),
      topMetric: adsOrdersDrrMetric,
      topTone: "ads-orders",
      topMiniChartMarkup: renderCompactDrrSparkline(drrTrend, "drrOrders", "orders", "ДРР заказов (рк)"),
      meta: [
        metricMetaItem("CPO", totals.CPO, "money", {
          previous: comparisonPreviousValue(comparison.cpo),
          invert: true,
        }),
        metricMetaItem("CR2", computeRate(totals.orders, totals.atbs), "percent", {
          previous: prevCr2,
        }),
        metricMetaItem("% с РК", shareFromAds, "percent"),
      ],
    },
    {
      label: "Заказов всего",
      value: formatNumber(totals.ordered_total, 0),
      delta: metricPrimaryDelta(totals.ordered_total, prevOrderedTotal),
      topMetric: totalOrdersDrrMetric,
      topTone: "total-orders",
      topMiniChartMarkup: renderCompactDrrSparkline(drrTrend, "drrOrdersTotal", "total-orders", "ДРР заказов (всего)"),
      meta: [
        metricMetaItem("CPO общий", totals.CPO_overall, "money", {
          previous: comparisonPreviousValue(comparison.cpo_overall),
          invert: true,
        }),
        metricMetaItem("С доп. продажами", totals.CPO_with_rel, "money", {
          previous: comparisonPreviousValue(comparison.cpo_with_rel),
          invert: true,
        }),
      ],
    },
  ];

  return `
    <div class="metric-funnel-stack full">
      <div class="metric-funnel-tabs-row">
        ${columns
          .map((column, index) => {
            if (!column.topMetric) {
              return "";
            }
            return `
              <div class="metric-funnel-tab-slot${column.topTone ? ` tone-${escapeHtml(column.topTone)}` : ""}" style="grid-column:${index + 1}">
                ${renderTopTab(column.topMetric, column.topTone || "neutral", { miniChartMarkup: column.topMiniChartMarkup })}
              </div>
            `;
          })
          .join("")}
      </div>
      <div class="metric-tile metric-tile-funnel-combined tone-neutral">
        <div class="metric-funnel-columns">
          ${columns
            .map((column) => `
              <div class="metric-funnel-column">
              <div class="metric-level-list">
                ${renderMetricLevel({
                  label: column.label,
                  value: column.value,
                  deltaText: column.delta?.text || "",
                  deltaTone: column.delta?.tone || "",
                })}
                ${(column.meta || [])
                  .filter((item) => item?.value)
                  .map((item) => renderMetricLevel({
                    label: item.label,
                    value: item.value,
                    deltaText: item.deltaText,
                    deltaTone: item.deltaTone,
                  }))
                    .join("")}
                </div>
              </div>
            `)
            .join("")}
        </div>
      </div>
    </div>
  `;
}
function applySidebarState(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", Boolean(collapsed));
  if (!sidebarToggleButton || !sidebarToggleIcon) {
    return;
  }
  sidebarToggleButton.hidden = false;
  sidebarToggleButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
  sidebarToggleButton.setAttribute("aria-label", collapsed ? "Развернуть навигатор" : "Свернуть навигатор");
  sidebarToggleIcon.textContent = collapsed ? "+" : "−";
  window.localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? "1" : "0");
  syncTopNavOffset();
}
function toggleSidebar() {
  applySidebarState(!document.body.classList.contains("sidebar-collapsed"));
}
function syncTopNavOffset() {
  if (!articleSidebar) {
    return;
  }
  const height = Math.ceil(articleSidebar.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--top-nav-height", `${Math.max(height, 120)}px`);
}
function bindTopNavOffset() {
  syncTopNavOffset();
  if (topNavResizeObserver || !articleSidebar || typeof ResizeObserver === "undefined") {
    return;
  }
  topNavResizeObserver = new ResizeObserver(() => {
    syncTopNavOffset();
  });
  topNavResizeObserver.observe(articleSidebar);
  window.addEventListener("resize", syncTopNavOffset);
}
function syncControlState() {
  if (filterBackButton) {
    filterBackButton.disabled = isLoading || currentPage !== "product";
  }
  if (filterRefreshButton) {
    filterRefreshButton.disabled = isLoading || !selectedArticle || currentPage !== "product";
  }
  if (articleAddButton) {
    articleAddButton.disabled = isLoading;
  }
  if (articleInput) {
    articleInput.disabled = isLoading;
  }
  articleSelectorButton.disabled = currentPage === "articles"
    ? (isLoading || !selectedArticle)
    : false;
}
function renderTrackedArticleChips() {
  if (!articleChipList) {
    syncControlState();
    return;
  }
  if (!trackedArticleIds.length) {
    articleChipList.innerHTML = '<div class="empty-chip-state">Список пуст</div>';
    animateRenderedRoot(articleChipList);
    syncControlState();
    return;
  }

  articleChipList.innerHTML = trackedArticleIds
    .map(
      (article) => `
        <span class="article-chip">
          <span>${escapeHtml(article)}</span>
          <button type="button" data-remove-article="${escapeHtml(article)}" aria-label="Удалить ${escapeHtml(article)}">×</button>
        </span>
      `,
    )
    .join("");
  animateRenderedRoot(articleChipList);
  syncControlState();
}
function addArticles(values) {
  const next = normalizeArticleIds(values);
  if (!next.length) {
    return false;
  }
  trackedArticleIds = normalizeArticleIds([...trackedArticleIds, ...next]);
  persistTrackedArticleIds();
  if (!selectedArticle) {
    selectedArticle = trackedArticleIds[0] || null;
    persistSelectedArticle();
  }
  if (articleInput) {
    articleInput.value = "";
  }
  renderTrackedArticleChips();
  renderArticleNav();
  renderSelectedArticleSummary();
  return true;
}
function removeArticle(article) {
  trackedArticleIds = trackedArticleIds.filter((item) => item !== article);
  productStore.delete(String(article));
  articleSummaryStore.delete(String(article));
  persistTrackedArticleIds();
  persistArticleSummaries();
  if (String(selectedArticle) === String(article)) {
    selectedArticle = trackedArticleIds[0] || null;
    persistSelectedArticle();
  }
  renderTrackedArticleChips();
  renderArticleNav();
  renderSelectedArticleSummary();
  if (!selectedArticle) {
    content.innerHTML = emptyBlock("Выберите артикул слева.");
    return;
  }
  if (productStore.has(String(selectedArticle))) {
    renderSelectedProduct();
    return;
  }
  content.innerHTML = emptyBlock(`Загрузка артикула ${selectedArticle}…`);
  loadCurrentProduct(selectedArticle);
}
function totalsForProduct(product) {
  return product.daily_totals || {};
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
function deriveCpo(expenseSum, orders, fallback = null) {
  const fallbackValue = numberOrNull(fallback);
  if (fallbackValue !== null) {
    return fallbackValue;
  }
  const spend = numberOrNull(expenseSum);
  const ordersCount = numberOrNull(orders);
  if (spend === null || ordersCount === null || ordersCount <= 0) {
    return null;
  }
  return spend / ordersCount;
}
function summaryFromProduct(product) {
  const totals = totalsForProduct(product);
  const range = product.range_metrics || {};
  const rawProduct = product.raw?.product_list_item || {};
  const rawInfo = product.raw?.info || {};
  const abTests = rawProduct?.ab_tests || {};
  return {
    article: String(product.article),
    productId: product.product_id ?? rawInfo.id ?? null,
    name: product.identity?.name || "",
    brand: product.identity?.brand || "",
    vendorCode: product.identity?.vendor_code || "",
    categoryKeyword: product.identity?.category_keyword || "",
    shopName: product.shop?.name || "",
    imageUrl: product.identity?.image_url || "",
    isActive: product.flags?.is_active ?? null,
    expenseSum: totals.expense_sum ?? null,
    views: totals.views ?? range.views ?? null,
    clicks: totals.clicks ?? range.clicks ?? null,
    atbs: totals.atbs ?? range.atbs ?? null,
    orders: totals.orders ?? null,
    ordersTotal: totals.ordered_total ?? range.ordered_report ?? null,
    sumPrice: totals.sum_price ?? range.sum_price ?? null,
    revenueTotal: totals.ordered_sum_total ?? range.ordered_sum_report ?? null,
    ctr: range.ctr ?? computeRate(totals.clicks ?? range.clicks, totals.views ?? range.views),
    cpc: range.cpc ?? computeRate(totals.expense_sum ?? range.sum, totals.clicks ?? range.clicks),
    cr: range.cr ?? computeRate(totals.orders ?? range.orders, totals.clicks ?? range.clicks),
    cpo: deriveCpo(totals.expense_sum, totals.orders, totals.CPO ?? range.cpo),
    drr: range.drr ?? computeRate(totals.expense_sum ?? range.sum, totals.sum_price ?? range.sum_price),
    stock: product.stock?.current ?? null,
    campaignCount: range.campaigns_count ?? (product.campaigns || []).length,
    manualCampaignCount: range.manual_campaigns_count ?? rawProduct?.campaigns_data?.manual_count ?? null,
    budget: range.budget ?? null,
    dayBudget: range.day_budget ?? null,
    spendDay: range.spend_day ?? null,
    spendWeek: range.spend_week ?? null,
    spendMonth: range.spend_month ?? null,
    dispatcherEnabled: product.flags?.dispatcher_enabled ?? null,
    dispatcherErrors: Array.isArray(product.flags?.dispatcher_errors) ? product.flags.dispatcher_errors : [],
    abTestActive: product.flags?.ab_test_active ?? null,
    abTestsCount: product.identity?.ab_tests_count ?? null,
    abTestsProgress: abTests?.progress ?? null,
    seoSetsCount: product.identity?.seo_sets_count ?? null,
    tagsCount: product.identity?.tags_count ?? null,
    progressBar: product.identity?.progress_bar ?? null,
    campaignStates: Array.isArray(product.catalog_campaign_states) ? product.catalog_campaign_states : [],
  };
}
function summaryFromCatalogArticle(article, shop) {
  const productSnapshot = article.listing_product_snapshot || {};
  const abTests = productSnapshot.ab_tests || {};
  return {
    article: String(article.article),
    productId: article.product_id ?? null,
    name: article.name || "",
    brand: article.brand || "",
    vendorCode: article.vendor_code || "",
    categoryKeyword: article.category_keyword || "",
    shopName: shop.name || "",
    imageUrl: article.image_url || "",
    isActive: article.is_active ?? null,
    expenseSum: article.expense_sum ?? null,
    views: article.views ?? null,
    clicks: article.clicks ?? null,
    atbs: article.atbs ?? null,
    orders: article.orders ?? null,
    ordersTotal: article.ordered_report ?? null,
    sumPrice: article.sum_price ?? null,
    revenueTotal: article.ordered_sum_report ?? null,
    ctr: article.ctr ?? null,
    cpc: article.cpc ?? null,
    cr: article.cr ?? null,
    cpo: deriveCpo(article.expense_sum, article.orders, article.cpo),
    drr: article.drr ?? null,
    stock: article.stock ?? null,
    campaignCount: article.campaigns_count ?? null,
    manualCampaignCount: article.manual_campaigns_count ?? null,
    budget: article.budget ?? null,
    dayBudget: article.day_budget ?? null,
    spendDay: article.spend_day ?? null,
    spendWeek: article.spend_week ?? null,
    spendMonth: article.spend_month ?? null,
    dispatcherEnabled: article.dispatcher_enabled ?? null,
    dispatcherErrors: Array.isArray(article.dispatcher_errors) ? article.dispatcher_errors : [],
    abTestActive: article.ab_test_active ?? null,
    abTestsCount: article.ab_tests_count ?? null,
    abTestsProgress: abTests?.progress ?? null,
    seoSetsCount: article.seo_sets_count ?? null,
    tagsCount: article.tags_count ?? null,
    progressBar: article.progress_bar ?? null,
    campaignStates: Array.isArray(article.campaign_states) ? article.campaign_states : [],
  };
}
function syncArticleSummaries(products = []) {
  if (!products.length) {
    return;
  }
  products.forEach((product) => {
    articleSummaryStore.set(String(product.article), summaryFromProduct(product));
  });
  persistArticleSummaries();
}
function syncCatalogSummaries(catalog) {
  if (!catalog?.shops?.length) {
    return;
  }
  catalog.shops.forEach((shop) => {
    (shop.articles || []).forEach((article) => {
      const key = String(article.article);
      if (!productStore.has(key)) {
        articleSummaryStore.set(key, summaryFromCatalogArticle(article, shop));
      }
    });
  });
  persistArticleSummaries();
}
function getArticleSummary(article) {
  if (!article) {
    return null;
  }
  const loaded = productStore.get(String(article));
  if (loaded) {
    return summaryFromProduct(loaded);
  }
  const cached = articleSummaryStore.get(String(article));
  if (cached) {
    return cached;
  }
  return {
    article: String(article),
    productId: null,
    name: "",
    brand: "",
    shopName: "",
    imageUrl: "",
    isActive: null,
    expenseSum: null,
    views: null,
    clicks: null,
    atbs: null,
    orders: null,
    ordersTotal: null,
    sumPrice: null,
    revenueTotal: null,
    ctr: null,
    cpc: null,
    cr: null,
    cpo: null,
    drr: null,
    stock: null,
    campaignCount: null,
    manualCampaignCount: null,
    vendorCode: "",
    categoryKeyword: "",
    budget: null,
    dayBudget: null,
    spendDay: null,
    spendWeek: null,
    spendMonth: null,
    dispatcherEnabled: null,
    dispatcherErrors: [],
    abTestActive: null,
    abTestsCount: null,
    abTestsProgress: null,
    seoSetsCount: null,
    tagsCount: null,
    progressBar: null,
    campaignStates: [],
  };
}
function syncModalLock() {
  document.body.classList.toggle(
    "modal-open",
    !modalShell.hidden,
  );
}
function setArticleSelectorOpen(open) {
  articleSelectorButton.setAttribute("aria-expanded", String(open));
  articleSelectorButton.classList.toggle("is-open", open);
  if (open) {
    requestAnimationFrame(() => {
      articlePickerSearch?.focus();
      articleNav?.scrollIntoView({ block: "nearest" });
    });
  }
}
function renderSelectedArticleSummary() {
  syncPageChrome();
  const totalCatalogText = catalogData?.total_shops
    ? `${formatNumber(catalogData.total_shops, 0)} каб. • ${formatNumber(catalogData.total_articles, 0)} арт.`
    : "";
  if (currentPage === "articles" && totalCatalogText) {
    articleCount.textContent = totalCatalogText;
  } else {
    articleCount.textContent = `${formatNumber(trackedArticleIds.length, 0)} шт.`;
  }
  if (articlesPageMeta) {
    articlesPageMeta.textContent = currentPage === "articles" ? totalCatalogText : "";
  }
  const currentArticle = selectedArticle || trackedArticleIds[0] || null;
  const summary = getArticleSummary(currentArticle);
  if (!summary) {
    selectedArticleTitle.textContent = "Артикул не выбран";
    selectedArticleCaption.textContent = currentPage === "articles" ? "Выберите артикул в списке" : "Откройте страницу артикулов";
    articleSelectorButton.disabled = currentPage === "articles";
    syncControlState();
    return;
  }

  selectedArticleTitle.textContent = summary.article;
  selectedArticleCaption.textContent = summary.name
    ? shortText(summary.name, 38)
    : currentPage === "articles"
      ? "Открыть страницу товара"
      : "Открыть страницу артикулов";
  articleSelectorButton.disabled = currentPage === "articles" ? !currentArticle : false;
  syncControlState();
}
const chartsService = createChartsService({
  combinedFunnelTile,
  comparisonPreviousValue,
  getCampaignChartContext,
  getChartWindowDays,
  getChartRenderContext,
  getOverviewSectionCollapsed,
  metricMetaItem,
  metricPrimaryDelta,
  metricState,
  metricTile,
  normalizeChartWindowDays,
  productChartKey,
  renderMetricLevel,
  shortText,
  totalsForProduct,
});

const {
  buildCampaignDailyRows,
  buildChartsSection,
  buildFunnelLayout,
  computeCpm,
  computeRate,
  parseChartTooltipLines,
  renderCampaignCharts,
  renderChartTooltipLine,
} = chartsService;

const productTabsService = createProductTabsService({
  buildCampaignDailyRows,
  buildChartsSection,
  campaignCompareStore,
  clusterDetailCache,
  computeCpm,
  computeRate,
  metricState,
  modalBody,
  modalNote,
  modalShell,
  modalTitle,
  normalizeProductTab,
  productStore,
  renderCampaignCharts,
  shortText,
  startDateInput,
  endDateInput,
  getOverviewSectionCollapsed,
  syncModalLock,
});

const {
  buildModalContent,
  openBidHistory,
  openBudgetHistory,
  openClusterDetail,
  renderProductTabContent,
  selectedCampaignIds,
  setCampaignCompareSelection,
} = productTabsService;

const interactionService = createInteractionService({
  articlePickerShell,
  buildModalContent,
  clamp,
  destroyMountedHighcharts,
  mountHighcharts,
  modalBody,
  modalNote,
  modalShell,
  modalTitle,
  parseChartTooltipLines,
  productStore,
  renderChartTooltipLine,
  setArticleSelectorOpen,
  syncModalLock,
  toggleHighchartsSeries,
});

const {
  closeAllMenus,
  closeModal,
  hideChartTooltips,
  openModal,
  showChartTooltip,
  toggleChartSeries,
} = interactionService;

function shortText(value, maxLength = 62) {
  if (!value) {
    return "—";
  }
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
function matchesCatalogFilter(article, query) {
  if (!query) {
    return true;
  }
  const haystack = [
    article.article,
    article.name,
    article.brand,
    article.vendor_code,
    article.category_keyword,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}
function catalogCampaignTone(statusCode) {
  const normalized = String(statusCode || "").toUpperCase();
  if (normalized === "ACTIVE") {
    return "good";
  }
  if (normalized === "PAUSED") {
    return "warn";
  }
  if (normalized === "FROZEN") {
    return "freeze";
  }
  return "muted";
}
const CATALOG_CAMPAIGN_LAYOUT = [
  { key: "unified", badge: "CPM", title: "кампания", subtitle: "Единая ставка" },
  { key: "manual_search", badge: "CPM", title: "кампания", subtitle: "Ручная ставка" },
  { key: "manual_recom", badge: "CPM", title: "кампания", subtitle: "Реком." },
  { key: "cpc", badge: "CPC", title: "кампания", subtitle: "Оплата за клики" },
];
function renderCatalogMetaPill(label, value, tone = "muted") {
  return `<span class="catalog-mini-pill tone-${escapeHtml(tone)}">${escapeHtml(label)} ${escapeHtml(String(value))}</span>`;
}
function renderCatalogCampaignStates(summary) {
  const states = Array.isArray(summary?.campaignStates) ? summary.campaignStates.filter(Boolean) : [];
  const stateMap = new Map(states.map((item) => [String(item.key || ""), item]));
  return `
    <div class="catalog-campaign-board">
      ${CATALOG_CAMPAIGN_LAYOUT.map((meta) => {
        const item = stateMap.get(meta.key);
        const tone = catalogCampaignTone(item?.status_code);
        const statusLabel = item?.status_label || "Нет РК";
        return `
          <div class="catalog-campaign-card tone-${tone}">
            <span class="catalog-campaign-badge">${escapeHtml(meta.badge)}</span>
            <div class="catalog-campaign-copy">
              <strong>${escapeHtml(meta.title)}</strong>
              <span>${escapeHtml(meta.subtitle)}</span>
              <b>${escapeHtml(statusLabel)}</b>
            </div>
          </div>
        `;
      }).join("")}
      <div class="catalog-campaign-summary">
        ${renderCatalogMetaPill("Всего РК", formatNumber(summary?.campaignCount, 0), summary?.campaignCount ? "good" : "muted")}
        ${renderCatalogMetaPill("Ручных", formatNumber(summary?.manualCampaignCount, 0), summary?.manualCampaignCount ? "warn" : "muted")}
      </div>
    </div>
  `;
}
function catalogSubline(text) {
  if (!text) {
    return "";
  }
  return `<span class="catalog-subline">${escapeHtml(text)}</span>`;
}
function renderCatalogShopMeta(shop) {
  const shopTotals = shop?.listing_meta?.shop_totals || {};
  const pills = [
    renderCatalogMetaPill("Кабинет", shop?.id ?? "—"),
    renderCatalogMetaPill("MP", shop?.marketplace || "WB"),
    renderCatalogMetaPill("Тариф", shop?.tariff_code || "—"),
    renderCatalogMetaPill("Баланс", formatMoney(shop?.balance), shop?.balance > 0 ? "good" : "muted"),
    renderCatalogMetaPill("Бонус", formatMoney(shop?.bonus), shop?.bonus > 0 ? "good" : "muted"),
    renderCatalogMetaPill("Расход", formatMoney(shopTotals?.sum), shopTotals?.sum > 0 ? "warn" : "muted"),
    renderCatalogMetaPill("Заказов", formatNumber(shopTotals?.orders, 0), shopTotals?.orders > 0 ? "good" : "muted"),
  ];
  if (shop?.has_limit) {
    pills.push(renderCatalogMetaPill("Лимит", `${formatNumber(shop?.fact_q, 0)} / ${formatNumber(shop?.limit_q, 0)}`, "warn"));
  }
  return `<div class="shop-group-meta">${pills.join("")}</div>`;
}
function renderCatalogArticleItem(shop, article) {
  const articleKey = String(article.article);
  const isActive = articleKey === String(selectedArticle);
  const summary = getArticleSummary(articleKey) || summaryFromCatalogArticle(article, shop);
  const spendMeta = [
    `Д ${formatMoney(summary.spendDay)}`,
    `Н ${formatMoney(summary.spendWeek)}`,
    `М ${formatMoney(summary.spendMonth)}`,
  ].join(" • ");
  const budgetMeta = [
    `Б ${formatMoney(summary.budget)}`,
    `Дн ${formatMoney(summary.dayBudget)}`,
  ].join(" • ");
  const orderMeta = [
    `CPO ${formatMoney(summary.cpo)}`,
    `ДРР ${formatPercent(summary.drr)}`,
  ].join(" • ");
  const activity = summary.isActive === true
    ? '<span class="catalog-status good">Активен</span>'
    : summary.isActive === false
      ? '<span class="catalog-status bad">Неактивен</span>'
      : '<span class="catalog-status muted">—</span>';
  const imageMarkup = summary.imageUrl
    ? `<img class="catalog-photo-thumb" src="${escapeHtml(summary.imageUrl)}" alt="" loading="lazy" />`
    : '<span class="catalog-photo-thumb is-empty">∿</span>';
  const campaignStatesMarkup = renderCatalogCampaignStates(summary);
  return `
    <button
      type="button"
      class="catalog-article-item ${isActive ? "is-active" : ""}"
      data-choose-article="${escapeHtml(articleKey)}"
      data-shop-id="${escapeHtml(shop.id)}"
    >
      <div class="catalog-article-table">
        <div class="catalog-cell photo">${imageMarkup}</div>
        <div class="catalog-cell product">
          <div class="catalog-product-head">
            ${activity}
            ${summary.brand ? `<span class="catalog-mini-pill tone-neutral">${escapeHtml(shortText(summary.brand, 22))}</span>` : ""}
          </div>
          <strong title="${escapeHtml(summary.name || article.name || "Без названия")}">${escapeHtml(shortText(summary.name || article.name || "Без названия", 72))}</strong>
          ${catalogSubline(`Арт ${summary.article} • SKU ${summary.vendorCode || "—"} • ID ${summary.productId || "—"}`)}
          ${catalogSubline(`${summary.categoryKeyword || "—"} • ${summary.shopName || shop.name || ""}`)}
        </div>
        <div class="catalog-cell">
          <strong>${formatMoney(summary.expenseSum)}</strong>
          ${catalogSubline(spendMeta)}
        </div>
        <div class="catalog-cell">
          <strong>${formatNumber(summary.views, 0)}</strong>
          ${catalogSubline(`Выручка РК ${formatMoney(summary.sumPrice)}`)}
        </div>
        <div class="catalog-cell">
          <strong>${formatNumber(summary.clicks, 0)}</strong>
          ${catalogSubline(`CR ${formatPercent(summary.cr)}`)}
        </div>
        <div class="catalog-cell">
          <strong>${formatPercent(summary.ctr)}</strong>
          ${catalogSubline(`Показы ${formatNumber(summary.views, 0)}`)}
        </div>
        <div class="catalog-cell">
          <strong>${formatMoney(summary.cpc)}</strong>
          ${catalogSubline(`Клики ${formatNumber(summary.clicks, 0)}`)}
        </div>
        <div class="catalog-cell">
          <strong>${formatNumber(summary.atbs, 0)}</strong>
          ${catalogSubline("Корзины с рекламы")}
        </div>
        <div class="catalog-cell">
          <strong>${formatNumber(summary.orders, 0)}</strong>
          ${catalogSubline(`Всего ${formatNumber(summary.ordersTotal, 0)}`)}
          ${catalogSubline(orderMeta)}
        </div>
        <div class="catalog-cell">
          <strong>${formatNumber(summary.stock, 0)}</strong>
          ${catalogSubline(budgetMeta)}
          ${catalogSubline(`Выручка всего ${formatMoney(summary.revenueTotal)}`)}
        </div>
        <div class="catalog-cell campaigns">
          ${campaignStatesMarkup}
        </div>
      </div>
    </button>
  `;
}
function renderArticleNav() {
  renderSelectedArticleSummary();
  if (!catalogData?.shops?.length) {
    articleNav.innerHTML = emptyBlock("Загрузка кабинетов…");
    animateRenderedRoot(articleNav);
    if (pickerMeta) {
      pickerMeta.textContent = "";
    }
    if (articlesPageMeta && currentPage === "articles") {
      articlesPageMeta.textContent = "";
    }
    return;
  }

  const query = catalogQuery.trim().toLowerCase();
  let matchedShops = 0;
  let matchedArticles = 0;
  const groupsMarkup = catalogData.shops
    .map((shop) => {
      const articles = (shop.articles || []).filter((article) => matchesCatalogFilter(article, query));
      if (!articles.length) {
        return "";
      }
      matchedShops += 1;
      matchedArticles += articles.length;
      const isCollapsed = collapsedShopIds.has(String(shop.id));
      return `
        <section class="shop-group ${isCollapsed ? "is-collapsed" : ""}">
          <button type="button" class="shop-group-head" data-toggle-shop="${escapeHtml(shop.id)}" aria-expanded="${String(!isCollapsed)}">
            <div class="shop-group-copy">
              <strong>${escapeHtml(shop.name)}</strong>
              <span>${formatNumber(articles.length, 0)} арт. • кабинет ${escapeHtml(shop.id)}</span>
            </div>
            <span class="shop-group-toggle">${isCollapsed ? "+" : "−"}</span>
          </button>
          <div class="shop-group-body" ${isCollapsed ? "hidden" : ""}>
            ${renderCatalogShopMeta(shop)}
            <div class="catalog-table-shell">
              <div class="catalog-table-head">
                <span>Фото</span>
                <span>Товар / артикул</span>
                <span>Расход</span>
                <span>Показы</span>
                <span>Клики</span>
                <span>CTR</span>
                <span>CPC</span>
                <span>Корзины</span>
                <span>Заказы / ДРР</span>
                <span>Остаток / бюджет</span>
                <span>РК / статусы</span>
              </div>
              ${articles.map((article) => renderCatalogArticleItem(shop, article)).join("")}
            </div>
          </div>
        </section>
      `;
    })
    .filter(Boolean)
    .join("");

  const matchedCatalogText = `${formatNumber(matchedShops, 0)} кабинетов • ${formatNumber(matchedArticles, 0)} артикулов`;
  if (pickerMeta) {
    pickerMeta.textContent = matchedCatalogText;
  }
  if (articlesPageMeta && currentPage === "articles") {
    articlesPageMeta.textContent = matchedCatalogText;
  }
  articleNav.innerHTML = groupsMarkup || emptyBlock("По фильтру ничего не найдено.");
  animateRenderedRoot(articleNav);
}
async function loadCatalog(start = startDateInput.value, end = endDateInput.value) {
  try {
    const payload = await fetchCatalogPayload(start, end);
    catalogData = payload;
    if (!hasPersistedShopCollapseState && !collapsedShopIds.size && payload?.shops?.length) {
      const trackedSet = new Set((trackedArticleIds || []).map((article) => String(article)));
      const preferredOpenShopIds = payload.shops
        .filter((shop) => (shop.articles || []).some((article) => {
          const articleKey = String(article.article || "");
          return articleKey === String(selectedArticle || "") || trackedSet.has(articleKey);
        }))
        .map((shop) => String(shop.id));
      const openShopIds = preferredOpenShopIds.length
        ? new Set(preferredOpenShopIds)
        : new Set(payload.shops[0] ? [String(payload.shops[0].id)] : []);
      collapsedShopIds = new Set(
        payload.shops
          .map((shop) => String(shop.id))
          .filter((shopId) => !openShopIds.has(shopId)),
      );
    }
    syncCatalogSummaries(payload);
    renderArticleNav();
    syncControlState();
    return true;
  } catch (error) {
    catalogData = null;
    articleNav.innerHTML = emptyBlock(error.message || "Не удалось загрузить каталог кабинетов.");
    if (pickerMeta) {
      pickerMeta.textContent = "";
    }
    if (articlesPageMeta) {
      articlesPageMeta.textContent = "";
    }
    syncControlState();
    return false;
  }
}
function renderSelectedProduct() {
  closeAllMenus();
  closeModal();
  destroyMountedHighcharts(content);
  if (currentPage === "articles") {
    renderSelectedArticleSummary();
    return;
  }
  content.innerHTML = "";
  if (!selectedArticle) {
    content.innerHTML = emptyBlock('Откройте страницу "Артикулы" и выберите товар.');
    animateRenderedRoot(content);
    renderSelectedArticleSummary();
    return;
  }

  const product = productStore.get(String(selectedArticle));
  if (!product) {
    content.innerHTML = emptyBlock(`Товар ${selectedArticle} еще не загружен.`);
    animateRenderedRoot(content);
    renderSelectedArticleSummary();
    return;
  }

  const totals = totalsForProduct(product);
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.article = product.article;

  const cover = node.querySelector(".product-cover");
  const meta = node.querySelector(".product-meta");
  const title = node.querySelector("h2");
  const subtitle = node.querySelector(".product-subtitle");
  const signals = node.querySelector(".product-signals");
  const panelPeriod = node.querySelector(".panel-period");
  const metricsGrid = node.querySelector(".metrics-grid");
  const overviewPanel = node.querySelector('[data-tab-panel="overview"]');
  const dailyPanel = node.querySelector('[data-tab-panel="daily"]');
  const campaignStatusPanel = node.querySelector('[data-tab-panel="campaign-status"]');
  const clustersPanel = node.querySelector('[data-tab-panel="clusters"]');
  const hoursPanel = node.querySelector('[data-tab-panel="hours"]');
  const campaignHeatmapPanel = node.querySelector('[data-tab-panel="campaign-heatmap"]');
  const bidsPanel = node.querySelector('[data-tab-panel="bids"]');
  const activeTab = getActiveTab(product);

  cover.style.backgroundImage = `linear-gradient(135deg, rgba(23,109,116,0.18), rgba(234,107,45,0.14)), url('${product.identity.image_url}')`;
  meta.innerHTML = [
    tagMarkup(`Арт ${product.article}`),
    tagMarkup(product.shop.name),
    tagMarkup(product.flags.is_active ? "Активен" : "Неактивен", product.flags.is_active ? "good" : "bad"),
    tagMarkup(product.identity.brand || "Без бренда"),
  ].join("");

  title.textContent = product.identity.name || `Артикул ${product.article}`;
  subtitle.innerHTML = `
    ${escapeHtml(product.identity.category_keyword || "—")} •
    ${escapeHtml(product.identity.vendor_code || "—")} •
    <a href="${escapeHtml(product.product_url)}" target="_blank" rel="noreferrer">страница XWAY</a>
  `;

  const stockState = metricState("stock", product.stock.current);
  const spendState = metricState("expense", totals.expense_sum);
  const adsOrdersState = metricState("orders", totals.orders);
  const totalOrdersState = metricState("ordered_total", totals.ordered_total);
  signals.innerHTML = [
    signalMarkup("Остаток", formatNumber(product.stock.current, 0), stockState.tone, stockState.hint),
    signalMarkup("Расход", formatMoney(totals.expense_sum), spendState.tone, spendState.hint),
    signalMarkup("Заказы с рекламы", formatNumber(totals.orders, 0), adsOrdersState.tone, adsOrdersState.hint),
    signalMarkup("Заказов всего", formatNumber(totals.ordered_total, 0), totalOrdersState.tone, totalOrdersState.hint),
  ].join("");

  panelPeriod.innerHTML = [
    tagMarkup(`${formatDateLabel(product.period.current_start)} → ${formatDateLabel(product.period.current_end)}`),
    tagMarkup(`${formatNumber((product.campaigns || []).length, 0)} камп.`),
  ].join("");

  metricsGrid.innerHTML = buildFunnelLayout(product);

  node.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tabTarget === activeTab);
  });

  [
    overviewPanel,
    dailyPanel,
    campaignStatusPanel,
    clustersPanel,
    hoursPanel,
    campaignHeatmapPanel,
    bidsPanel,
  ].forEach((panel) => {
    const isActive = panel.dataset.tabPanel === activeTab;
    panel.classList.toggle("is-active", isActive);
    panel.innerHTML = isActive ? renderProductTabContent(product, activeTab) : "";
  });

  if (product.errors && Object.keys(product.errors).length) {
    const warning = document.createElement("div");
    warning.className = "warning-strip";
    warning.textContent = `Не все блоки загрузились: ${Object.keys(product.errors).join(", ")}`;
    node.insertBefore(warning, node.querySelector(".tab-bar"));
  }

  if (isLoading && String(loadingArticle || "") === String(product.article)) {
    node.classList.add("is-loading");
    node.insertAdjacentHTML("beforeend", renderPageLoadingOverlay());
  }

  content.appendChild(node);
  mountHighcharts(node);
  animateRenderedRoot(node);
  renderSelectedArticleSummary();
  syncControlState();
}
function renderPageLoadingOverlay() {
  return `
    <div class="product-loading-overlay" aria-hidden="true">
      <div class="product-loading-badge">
        <span class="loading-spinner"></span>
        <span>Прогрузка товара…</span>
      </div>
    </div>
  `;
}
function mergeProductsIntoStore(products = [], mode = "merge") {
  if (mode !== "merge") {
    productStore.clear();
  }
  (products || []).forEach((product) => {
    if (product?.article !== undefined && product?.article !== null) {
      productStore.set(String(product.article), product);
    }
  });
  syncArticleSummaries(products || []);
}
function mergePayloadProducts(payload, mode = "replace") {
  if (mode !== "merge" || !currentPayload) {
    currentPayload = payload;
    return;
  }
  const merged = new Map(((currentPayload.products || [])).map((product) => [String(product.article), product]));
  (payload.products || []).forEach((product) => {
    if (product?.article !== undefined && product?.article !== null) {
      merged.set(String(product.article), product);
    }
  });
  currentPayload = {
    ...currentPayload,
    ...payload,
    products: Array.from(merged.values()),
  };
}
function handleLoadedPayload(payload, options = {}) {
  const mode = options.mode || "replace";
  mergePayloadProducts(payload, mode);
  mergeProductsIntoStore(payload.products || [], mode);
  if (options.focusArticle) {
    selectedArticle = String(options.focusArticle);
  }
  if (!trackedArticleIds.length) {
    selectedArticle = null;
  } else if (!selectedArticle || !trackedArticleIds.includes(String(selectedArticle))) {
    selectedArticle = trackedArticleIds[0] || null;
  }
  persistSelectedArticle();
  renderArticleNav();
  renderSelectedProduct();
  const hydratedProduct = productStore.get(String(options.focusArticle || selectedArticle || ""));
  if (hydratedProduct) {
    const activeTab = getActiveTab(hydratedProduct);
    if (activeTab === "overview") {
      void ensureCampaignCompareHeavyData(hydratedProduct);
    } else if (isHeavyTab(activeTab)) {
      void ensureHeavyTabData(hydratedProduct, activeTab);
    }
  }
}
async function loadProducts(articleIds, start, end, options = {}) {
  const normalizedIds = normalizeArticleIds(articleIds);
  if (!normalizedIds.length || isLoading) {
    return;
  }

  const mode = options.mode || "replace";
  const scope = options.scope || (normalizedIds.length === 1 ? "single" : "all");
  const focusArticle = options.focusArticle ? String(options.focusArticle) : (scope === "single" ? normalizedIds[0] : selectedArticle);
  const requestOptions = options.requestOptions || { campaignMode: "summary" };

  isLoading = true;
  loadingArticle = focusArticle || selectedArticle;
  setStatus(scope === "single" ? "Обновление товара…" : "Обновление всех товаров…", "loading");
  if (scope === "all") {
    trackedArticleIds = normalizedIds;
    persistTrackedArticleIds();
    renderTrackedArticleChips();
  }
  if (focusArticle) {
    selectedArticle = focusArticle;
    persistSelectedArticle();
    renderSelectedArticleSummary();
  }
  if (scope === "single" && focusArticle && !productStore.has(String(focusArticle))) {
    content.innerHTML = emptyBlock(`Загрузка артикула ${focusArticle}…`);
  }
  syncControlState();
  closeAllMenus();
  closeModal();
  if (focusArticle && productStore.has(String(focusArticle))) {
    renderSelectedProduct();
  }

  try {
    const preloadStart = chartPreloadStart(end);
    const canReuseMainPayloadForCharts = selectedRangeCoversChartPreload(start, end);
    const [payload, chartPayload] = await Promise.all([
      fetchProductsPayload(normalizedIds, start, end, "Не удалось загрузить данные.", requestOptions),
      canReuseMainPayloadForCharts || !preloadStart || !end
        ? Promise.resolve(null)
        : fetchProductsPayload(
          normalizedIds,
          preloadStart,
          end,
          "Не удалось загрузить данные графиков.",
          { campaignMode: "summary" },
        ).catch(() => null),
    ]);

    startDateInput.value = payload.range.current_start;
    endDateInput.value = payload.range.current_end;
    syncPresetButtons(payload.range.current_start, payload.range.current_end);
    persistRangeState(payload.range.current_start, payload.range.current_end);
    cacheChartProducts((chartPayload || payload).products || []);
    clearChartLoadingForArticles(normalizedIds);
    handleLoadedPayload(payload, { mode, focusArticle });
    setStatus(scope === "single" ? "Товар обновлен" : "Все товары обновлены", "idle");
  } catch (error) {
    if (mode !== "merge") {
      currentPayload = null;
      productStore.clear();
      articleNav.innerHTML = emptyBlock("Не удалось загрузить список артикулов.");
      content.innerHTML = emptyBlock(error.message || "Ошибка загрузки.");
    } else if (focusArticle && !productStore.has(String(focusArticle))) {
      content.innerHTML = emptyBlock(error.message || "Ошибка загрузки.");
    }
    renderArticleNav();
    setStatus("Ошибка", "error");
  } finally {
    isLoading = false;
    loadingArticle = null;
    syncControlState();
    renderSelectedProduct();
  }
}
function loadAllTrackedProducts() {
  if (!trackedArticleIds.length) {
    setStatus("Добавьте артикул", "error");
    return;
  }
  loadProducts(getArticleIds(), startDateInput.value, endDateInput.value, {
    mode: "replace",
    scope: "all",
    focusArticle: selectedArticle || trackedArticleIds[0],
    requestOptions: { campaignMode: "summary" },
  });
}
function currentProductRequestOptions(article = selectedArticle) {
  const product = productStore.get(String(article || ""));
  const activeTab = getActiveTab(article);
  if (isHeavyTab(activeTab)) {
    return { campaignMode: "full" };
  }
  if (!product) {
    return { campaignMode: "summary" };
  }
  const heavyCampaignIds = activeTab === "overview" ? allCampaignIds(product) : selectedCampaignIds(product);
  return {
    campaignMode: "summary",
    heavyCampaignIds,
  };
}
function loadCurrentProduct(article = selectedArticle) {
  if (!article) {
    setStatus("Выберите артикул", "error");
    return;
  }
  loadProducts([article], startDateInput.value, endDateInput.value, {
    mode: "merge",
    scope: "single",
    focusArticle: article,
    requestOptions: currentProductRequestOptions(article),
  });
}
async function fetchAndMergeSingleProduct(article, requestOptions = {}, statusMessage = "Прогрузка товара…") {
  const articleKey = String(article || "");
  if (!articleKey) {
    return null;
  }
  const hadExistingProduct = productStore.has(articleKey);
  let succeeded = false;
  isLoading = true;
  loadingArticle = articleKey;
  setStatus(statusMessage, "loading");
  syncControlState();
  renderSelectedProduct();
  try {
    const payload = await fetchProductsPayload(
      [articleKey],
      startDateInput.value,
      endDateInput.value,
      "Не удалось загрузить данные товара.",
      requestOptions,
    );
    cacheChartProducts(payload.products || []);
    clearChartLoadingForArticles([articleKey]);
    handleLoadedPayload(payload, { mode: "merge", focusArticle: articleKey });
    succeeded = true;
    return (payload.products || [])[0] || productStore.get(articleKey) || null;
  } catch (_error) {
    setStatus(hadExistingProduct ? "Часть данных не догружена" : "Ошибка", hadExistingProduct ? "idle" : "error");
    return productStore.get(articleKey) || null;
  } finally {
    isLoading = false;
    loadingArticle = null;
    syncControlState();
    renderSelectedProduct();
    if (succeeded) {
      const doneStatus = statusMessage === "Прогрузка кампаний…"
        ? "Кампании загружены"
        : statusMessage === "Прогрузка вкладки…"
          ? "Вкладка загружена"
          : "Товар обновлен";
      setStatus(doneStatus, "idle");
    }
  }
}
async function ensureCampaignCompareHeavyData(product) {
  if (!product) {
    return null;
  }
  const heavyCampaignIds = allCampaignIds(product);
  if (productHasCampaignHeavy(product, heavyCampaignIds)) {
    return product;
  }
  return fetchAndMergeSingleProduct(
    product.article,
    { campaignMode: "summary", heavyCampaignIds },
    "Прогрузка кампаний…",
  );
}
async function ensureHeavyTabData(product, tabName) {
  if (!product || !isHeavyTab(tabName) || productHasAllCampaignHeavy(product)) {
    return product;
  }
  return fetchAndMergeSingleProduct(product.article, { campaignMode: "full" }, "Прогрузка вкладки…");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (currentPage === "articles") {
    setStatus("Обновление списка…", "loading");
    const ok = await loadCatalog(startDateInput.value, endDateInput.value);
    setStatus(ok ? "Список обновлен" : "Ошибка", ok ? "idle" : "error");
    return;
  }
  loadAllTrackedProducts();
});

if (articleAddButton && articleInput) {
  articleAddButton.addEventListener("click", () => {
    addArticles([articleInput.value]);
  });
}

articleSelectorButton.addEventListener("click", () => {
  if (articleSelectorButton.disabled) {
    return;
  }
  if (currentPage === "articles") {
    if (selectedArticle) {
      openProductInNewTab(selectedArticle);
      return;
    }
    articlePickerSearch?.focus();
    return;
  }
  navigateToPage("articles");
});

articlePickerCloseButton.addEventListener("click", () => {
  setArticleSelectorOpen(false);
});

articlePickerSearch.addEventListener("input", () => {
  catalogQuery = articlePickerSearch.value || "";
  renderArticleNav();
});

if (filterBackButton) {
  filterBackButton.addEventListener("click", () => {
    navigateToPage("articles", {
      start: startDateInput?.value,
      end: endDateInput?.value,
    });
  });
}

if (filterRefreshButton) {
  filterRefreshButton.addEventListener("click", () => {
    if (!selectedArticle) {
      return;
    }
    loadCurrentProduct(selectedArticle);
  });
}

sidebarToggleButton.addEventListener("click", () => {
  toggleSidebar();
});

if (articleInput) {
  articleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addArticles([articleInput.value]);
    }
  });
}

if (rangePresetSelect) {
  rangePresetSelect.addEventListener("change", () => {
    if (rangePresetSelect.value === "custom") {
      return;
    }
    const range = presetRangeForKey(rangePresetSelect.value);
    startDateInput.value = range.start;
    endDateInput.value = range.end;
    syncPresetButtons(range.start, range.end);
    persistRangeState(range.start, range.end);
  });
}

[startDateInput, endDateInput].forEach((input) => {
  input.addEventListener("change", () => {
    syncPresetButtons(startDateInput.value, endDateInput.value);
    persistRangeState(startDateInput.value, endDateInput.value);
  });
});

articleNav.addEventListener("click", (event) => {
  event.stopPropagation();
  const shopToggle = event.target.closest("[data-toggle-shop]");
  if (shopToggle) {
    const shopId = String(shopToggle.dataset.toggleShop);
    if (collapsedShopIds.has(shopId)) {
      collapsedShopIds.delete(shopId);
    } else {
      collapsedShopIds.add(shopId);
    }
    persistCollapsedShops();
    renderArticleNav();
    return;
  }

  const button = event.target.closest("[data-choose-article]");
  if (!button) {
    return;
  }
  selectedArticle = button.dataset.chooseArticle;
  if (!trackedArticleIds.includes(String(selectedArticle))) {
    trackedArticleIds = normalizeArticleIds([selectedArticle, ...trackedArticleIds]);
    persistTrackedArticleIds();
    renderTrackedArticleChips();
  }
  persistSelectedArticle();
  renderArticleNav();
  if (currentPage === "articles") {
    openProductInNewTab(selectedArticle);
    return;
  }
  if (productStore.has(String(selectedArticle))) {
    renderSelectedProduct();
  } else {
    content.innerHTML = emptyBlock(`Загрузка артикула ${selectedArticle}…`);
  }
  loadCurrentProduct(selectedArticle);
});

if (articleChipList) {
  articleChipList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-article]");
    if (!button) {
      return;
    }
    removeArticle(button.dataset.removeArticle);
  });
}

content.addEventListener("click", (event) => {
  const chartWindowButton = event.target.closest("[data-chart-window]");
  if (chartWindowButton) {
    const nextWindow = Number(chartWindowButton.dataset.chartWindow);
    const chartKey = chartWindowButton.dataset.chartKey;
    if ([7, 14, 30].includes(nextWindow) && chartKey && getChartWindowDays(chartKey) !== nextWindow) {
      setChartWindowDays(chartKey, nextWindow);
      hideChartTooltips();
      renderSelectedProduct();
    }
    return;
  }
  const chartToggle = event.target.closest("[data-chart-toggle]");
  if (chartToggle) {
    toggleChartSeries(chartToggle);
    return;
  }

  const tabButton = event.target.closest("[data-tab-target]");
  if (tabButton) {
    const panel = tabButton.closest(".product-panel");
    const target = tabButton.dataset.tabTarget;
    const article = panel?.dataset.article || selectedArticle;
    const product = productStore.get(String(article || ""));
    setActiveTab(article, target);
    renderSelectedProduct();
    if (target === "overview") {
      void ensureCampaignCompareHeavyData(product);
    } else if (isHeavyTab(target)) {
      void ensureHeavyTabData(product, target);
    }
    return;
  }

  const toggleMenuButton = event.target.closest('[data-action="toggle-menu"]');
  if (toggleMenuButton) {
    const wrap = toggleMenuButton.closest(".menu-wrap");
    const menu = wrap.querySelector(".floating-menu");
    const nextState = menu.hidden;
    closeAllMenus(wrap);
    menu.hidden = !nextState;
    toggleMenuButton.setAttribute("aria-expanded", String(nextState));
    return;
  }

  const refreshButton = event.target.closest('[data-action="refresh-current"]');
  if (refreshButton) {
    loadCurrentProduct(refreshButton.closest(".product-panel")?.dataset.article || selectedArticle);
    return;
  }

  const backToCabinetsButton = event.target.closest('[data-action="back-to-cabinets"]');
  if (backToCabinetsButton) {
    navigateToPage("articles", {
      start: startDateInput?.value,
      end: endDateInput?.value,
    });
    return;
  }

  const budgetHistoryButton = event.target.closest('[data-action="open-budget-history"]');
  if (budgetHistoryButton) {
    const article = budgetHistoryButton.closest(".product-panel")?.dataset.article || selectedArticle;
    closeAllMenus();
    openBudgetHistory(article, budgetHistoryButton.dataset.campaignId);
    return;
  }

  const bidHistoryButton = event.target.closest('[data-action="open-bid-history"]');
  if (bidHistoryButton) {
    const article = bidHistoryButton.closest(".product-panel")?.dataset.article || selectedArticle;
    closeAllMenus();
    openBidHistory(article, bidHistoryButton.dataset.campaignId);
    return;
  }

  const clusterDetailButton = event.target.closest("[data-cluster-detail]");
  if (clusterDetailButton) {
    openClusterDetail(
      clusterDetailButton.dataset.article,
      clusterDetailButton.dataset.campaignId,
      clusterDetailButton.dataset.normqueryId,
    );
    return;
  }

  const expandButton = event.target.closest("[data-expand-panel]");
  if (expandButton) {
    const article = expandButton.closest(".product-panel").dataset.article;
    openModal(article, expandButton.dataset.expandPanel);
    return;
  }

  const overviewSectionToggle = event.target.closest("[data-overview-section-toggle]");
  if (overviewSectionToggle) {
    toggleOverviewSectionCollapsed(
      overviewSectionToggle.dataset.article || overviewSectionToggle.closest(".product-panel")?.dataset.article || selectedArticle,
      overviewSectionToggle.dataset.overviewSectionToggle,
    );
    return;
  }

  const modalButton = event.target.closest("[data-modal]");
  if (modalButton) {
    const article = modalButton.closest(".product-panel").dataset.article;
    closeAllMenus();
    openModal(article, modalButton.dataset.modal);
  }
});

content.addEventListener("change", (event) => {
  const compareSelect = event.target.closest("[data-campaign-compare-slot]");
  if (!compareSelect) {
    return;
  }
  const article = String(compareSelect.dataset.article || selectedArticle || "");
  const product = productStore.get(article);
  if (!product) {
    return;
  }
  setCampaignCompareSelection(product, compareSelect.dataset.campaignCompareSlot, compareSelect.value);
  renderSelectedProduct();
  void ensureCampaignCompareHeavyData(productStore.get(article) || product);
});

content.addEventListener("pointermove", (event) => {
  const target = event.target.closest("[data-chart-tip]");
  if (target) {
    showChartTooltip(target, event);
    return;
  }
  if (!event.target.closest(".chart-shell")) {
    hideChartTooltips();
  }
});

content.addEventListener(
  "pointerleave",
  (event) => {
    if (event.target.closest(".chart-shell")) {
      hideChartTooltips();
    }
  },
  true,
);

document.addEventListener("click", (event) => {
  if (
    !event.target.closest(".menu-wrap") &&
    !event.target.closest(".selector-wrap") &&
    !event.target.closest(".sidebar-section")
  ) {
    closeAllMenus();
  }
});

modalShell.addEventListener("click", (event) => {
  if (event.target.closest("[data-modal-close]")) {
    closeModal();
  }
});

articlePickerShell.addEventListener("click", (event) => {
  if (event.target.closest("[data-picker-close]")) {
    setArticleSelectorOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModal();
    closeAllMenus();
  }
});

const defaults = loadStoredRange();
trackedArticleIds = loadStoredTrackedArticleIds();
const selectedArticleFromUrl = loadSelectedArticleFromUrl();
if (selectedArticleFromUrl) {
  trackedArticleIds = normalizeArticleIds([selectedArticleFromUrl, ...trackedArticleIds]);
  selectedArticle = selectedArticleFromUrl;
  persistTrackedArticleIds();
  persistSelectedArticle();
} else {
  selectedArticle = loadStoredSelectedArticle(trackedArticleIds);
}
currentPage = resolveCurrentPageFromLocation();
normalizeInitialPageUrl();
collapsedShopIds = loadStoredCollapsedShops();
overviewSectionCollapseStore = loadStoredOverviewSectionCollapses();
loadStoredArticleSummaries();
applySidebarState(window.localStorage.getItem(SIDEBAR_STATE_KEY) === "1" && !selectedArticle && !trackedArticleIds.length);
bindTopNavOffset();
startDateInput.value = defaults.start;
endDateInput.value = defaults.end;
syncPresetButtons(defaults.start, defaults.end);
renderTrackedArticleChips();
renderArticleNav();
renderSelectedProduct();
if (currentPage === "articles") {
  setStatus("Загрузка списка…", "loading");
  loadCatalog(defaults.start, defaults.end).then((ok) => {
    setStatus(ok ? "Список обновлен" : "Ошибка", ok ? "idle" : "error");
  });
} else if (selectedArticle) {
  loadCurrentProduct(selectedArticle);
} else {
  setStatus('Откройте "Артикулы" и выберите товар', "error");
}
