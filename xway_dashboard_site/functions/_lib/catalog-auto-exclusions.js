import { XwayApiClient } from "./xway-client.js";
import { mapWithConcurrency, parseCatalogChartProductRefs } from "./utils.js";

const AUTO_EXCLUSIONS_DEFAULT_DEADLINE_MS = 16000;
const AUTO_EXCLUSIONS_MIN_PROCESSED_BEFORE_DEADLINE = 1;

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toBooleanOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on", "да"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off", "нет"].includes(normalized)) {
    return false;
  }
  return null;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (value === null || value === undefined || value === "") {
    return [];
  }
  return String(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function safeCall(fn, defaultValue) {
  try {
    return [await fn(), null];
  } catch (error) {
    return [defaultValue, error instanceof Error ? error.message : String(error)];
  }
}

function normalizeCursor(value, total) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(parsed, Math.max(total, 0));
}

function normalizeLimit(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, max));
}

function normalizeDeadlineMs(value, fallback = AUTO_EXCLUSIONS_DEFAULT_DEADLINE_MS) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(3000, Math.min(parsed, 25000));
}

function splitPauseReasonTokens(value) {
  if (Array.isArray(value)) {
    return value.flatMap(splitPauseReasonTokens);
  }
  if (value && typeof value === "object") {
    return [
      ...splitPauseReasonTokens(value.pause_reasons),
      ...splitPauseReasonTokens(value.paused_limiter),
      ...splitPauseReasonTokens(value.reason),
      ...splitPauseReasonTokens(value.status),
    ];
  }
  return String(value || "")
    .split(/[;,\s/]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hasCampaignFreezeSignal(campaign, statusCode) {
  if (campaign?.is_freeze || campaign?.is_frozen || campaign?.frozen || campaign?.freeze) {
    return true;
  }
  const normalizedStatus = String(statusCode || "").trim().toUpperCase();
  const rawStatusText = [campaign?.status_xway, campaign?.status, campaign?.freeze_status].map((value) => String(value || "").toLowerCase()).join(" ");
  if (/заморож|freeze|frozen/.test(rawStatusText)) {
    return true;
  }
  if (normalizedStatus !== "PAUSED") {
    return false;
  }
  const pausePayload = campaign?.pause_reasons || {};
  const pauseTokens = splitPauseReasonTokens(pausePayload);
  const pausedUser = pausePayload?.paused_user ?? campaign?.paused_user ?? null;
  return Boolean(pausedUser) || pauseTokens.some((token) => ["user", "manual", "freeze", "frozen"].includes(token) || /замороз/.test(token));
}

function normalizeCampaignStatusCode(campaign) {
  const raw = campaign?.status_xway ?? campaign?.status ?? null;
  const normalized = String(raw || "").trim().toUpperCase();
  let statusCode = normalized || null;
  if (["PAUSED", "PAUSE", "ПАУЗА", "ПРИОСТАНОВЛЕНА", "ПРИОСТАНОВЛЕН", "ОСТАНОВЛЕНА", "ОСТАНОВЛЕН"].includes(normalized)) {
    statusCode = "PAUSED";
  } else if (["ACTIVE", "АКТИВНА", "АКТИВЕН", "АКТИВНАЯ", "АКТИВНЫЙ"].includes(normalized)) {
    statusCode = "ACTIVE";
  } else if (["FROZEN", "FREEZE", "ЗАМОРОЖЕНА", "ЗАМОРОЖЕН", "ЗАМОРОЗКА"].includes(normalized)) {
    statusCode = "FROZEN";
  }
  if (hasCampaignFreezeSignal(campaign, statusCode)) {
    return "FROZEN";
  }
  return statusCode;
}

function formatCampaignStatusLabel(statusCode) {
  const normalized = String(statusCode || "").trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  return {
    ACTIVE: "Активна",
    PAUSED: "Пауза",
    FROZEN: "Заморожена",
  }[normalized] || normalized;
}

function resolveCampaignDisplayStatus(statusCode) {
  const normalized = String(statusCode || "").trim().toUpperCase();
  const normalizedLower = normalized.toLowerCase();
  if (normalized === "ACTIVE" || /актив/.test(normalizedLower)) {
    return "active";
  }
  if (normalized === "FROZEN" || /заморож|freeze|frozen/.test(normalizedLower)) {
    return "freeze";
  }
  if (normalized === "PAUSED" || /приост|pause|paused|stop|неактив/.test(normalizedLower)) {
    return "paused";
  }
  return "muted";
}

function resolveCampaignPaymentType(campaign) {
  const paymentTypeRaw = String(campaign?.payment_type || "").trim().toLowerCase();
  const campaignName = String(campaign?.name || "").trim().toLowerCase();
  const auctionMode = String(campaign?.auction_mode || "").trim().toLowerCase();
  const autoType = String(campaign?.auto_type || "").trim().toLowerCase();
  if (["cpc", "click", "clicks"].includes(paymentTypeRaw)) {
    return "cpc";
  }
  if (["cpm", "view", "views"].includes(paymentTypeRaw)) {
    return "cpm";
  }
  if (/оплата\s+за\s+клики|cpc|click|клик/i.test([campaignName, auctionMode, autoType].join(" "))) {
    return "cpc";
  }
  return "cpm";
}

function formatCampaignName(campaign) {
  const id = campaign?.id ?? campaign?.campaign_id ?? campaign?.external_id ?? null;
  const name = String(campaign?.name || "").trim();
  return name ? `РК ${id} · ${name}` : `РК ${id}`;
}

function normalizeAutoExclusionRule(source) {
  const payload = source?.result && typeof source.result === "object" ? source.result : source;
  const rule = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  if (!rule) {
    return null;
  }
  return {
    active: toBooleanOrNull(rule.active),
    fixed: toBooleanOrNull(rule.fixed),
    days: toNumber(rule.days ?? rule.preset),
    boost: toNumber(rule.boost),
    efficiency: toNumber(rule.efficiency),
    popularity: toNumber(rule.popularity),
    popularity_above: toNumber(rule.popularity_above ?? rule.popularityAbove),
    ctr: toNumber(rule.ctr),
    ctr_view: toNumber(rule.ctr_view ?? rule.ctrView),
    cpc: toNumber(rule.cpc),
    cpc_view: toNumber(rule.cpc_view ?? rule.cpcView),
    queries_to_exclude: normalizeStringArray(rule.queries_to_exclude ?? rule.queriesToExclude),
    queries_not_to_exclude: normalizeStringArray(rule.queries_not_to_exclude ?? rule.queriesNotToExclude),
  };
}

function hasAutoExclusionConditions(rule) {
  if (!rule) {
    return false;
  }
  return (
    rule.boost !== null ||
    rule.efficiency !== null ||
    rule.popularity !== null ||
    rule.popularity_above !== null ||
    rule.ctr !== null ||
    rule.cpc !== null ||
    Boolean(rule.queries_to_exclude?.length)
  );
}

function isAutoExclusionConfigured(rule) {
  if (!rule) {
    return false;
  }
  if (rule.active !== true) {
    return false;
  }
  if (rule.fixed === false) {
    return true;
  }
  return hasAutoExclusionConditions(rule);
}

function buildAutoExclusionCampaign(campaign, autoRuleSource, autoRuleError = null) {
  const statusCode = normalizeCampaignStatusCode(campaign);
  const autoRule = normalizeAutoExclusionRule(autoRuleSource);
  return {
    id: Number(campaign?.id ?? campaign?.campaign_id ?? campaign?.external_id),
    name: campaign?.name ?? null,
    label: formatCampaignName(campaign),
    payment_type: resolveCampaignPaymentType(campaign),
    status_code: statusCode,
    status_label: formatCampaignStatusLabel(statusCode),
    display_status: resolveCampaignDisplayStatus(statusCode),
    place_count_setting: toNumber(campaign?.place_count_setting ?? campaign?.placeCountSetting ?? campaign?.raw?.place_count_setting),
    rule_exists: Boolean(autoRule),
    configured: isAutoExclusionConfigured(autoRule),
    auto_rule: autoRule,
    rule_error: autoRuleError || null,
  };
}

async function collectSingleCatalogAutoExclusion(client, [shopId, productId]) {
  const productRef = `${shopId}:${productId}`;
  const [stata, error] = await safeCall(() => client.productStata(shopId, productId), {});
  if (error) {
    return {
      product_ref: productRef,
      campaigns: [],
      checkable_campaigns_count: 0,
      configured_count: 0,
      missing_count: 0,
      cpc_skipped_count: 0,
      error,
    };
  }

  const allCampaignRows = Array.isArray(stata?.campaign_wb) ? stata.campaign_wb : [];
  let cpcSkippedCount = 0;
  const campaigns = [];
  for (const campaign of allCampaignRows) {
    const displayStatus = resolveCampaignDisplayStatus(normalizeCampaignStatusCode(campaign));
    if (displayStatus !== "active" && displayStatus !== "paused") {
      continue;
    }
    const paymentType = resolveCampaignPaymentType(campaign);
    if (paymentType === "cpc") {
      cpcSkippedCount += 1;
      continue;
    }
    const campaignId = Number(campaign?.id ?? campaign?.campaign_id ?? campaign?.external_id);
    const [autoRuleSource, autoRuleError] = Number.isFinite(campaignId)
      ? await safeCall(() => client.campaignAutoExcludeRule(shopId, productId, campaignId), null)
      : [null, "campaign id is missing"];
    const normalized = buildAutoExclusionCampaign(campaign, autoRuleSource, autoRuleError);
    if (Number.isFinite(normalized.id)) {
      campaigns.push(normalized);
    }
  }

  return {
    product_ref: productRef,
    campaigns,
    checkable_campaigns_count: campaigns.length,
    configured_count: campaigns.filter((campaign) => campaign.configured).length,
    missing_count: campaigns.filter((campaign) => !campaign.configured).length,
    cpc_skipped_count: cpcSkippedCount,
  };
}

export async function collectCatalogAutoExclusions(env, { productRefs = [], start = null, end = null, forceRefresh = false, cursor = null, limitProducts = null, deadlineMs = null } = {}) {
  const client = new XwayApiClient(env, { start, end, forceRefresh });
  const parsedRefs = parseCatalogChartProductRefs(productRefs);
  const cursorIndex = normalizeCursor(cursor, parsedRefs.length);
  const remainingRefs = parsedRefs.slice(cursorIndex);
  const maxProducts = normalizeLimit(limitProducts, remainingRefs.length, remainingRefs.length || 1);
  const targetRefs = remainingRefs.slice(0, maxProducts);
  const normalizedDeadlineMs = normalizeDeadlineMs(deadlineMs);
  const startedAt = Date.now();
  const rows = [];
  let processedProductsCount = 0;

  for (const ref of targetRefs) {
    const [row] = await mapWithConcurrency([ref], 1, (item) => collectSingleCatalogAutoExclusion(client, item));
    rows.push(row);
    processedProductsCount += 1;
    if (
      processedProductsCount >= AUTO_EXCLUSIONS_MIN_PROCESSED_BEFORE_DEADLINE &&
      Date.now() - startedAt >= normalizedDeadlineMs &&
      cursorIndex + processedProductsCount < parsedRefs.length
    ) {
      break;
    }
  }

  const nextIndex = cursorIndex + processedProductsCount;
  const complete = nextIndex >= parsedRefs.length;

  return {
    ok: true,
    generated_at: new Date().toISOString().slice(0, 10),
    range: client.range,
    rows,
    requested_products: parsedRefs.map(([shopId, productId]) => `${shopId}:${productId}`),
    loaded_products_count: rows.length,
    processed_products_count: processedProductsCount,
    remaining_products_count: Math.max(parsedRefs.length - nextIndex, 0),
    complete,
    next_cursor: complete ? null : String(nextIndex),
  };
}
