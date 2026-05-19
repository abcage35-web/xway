import { readSharedCacheMany, writeSharedCache } from "./shared-cache.js";
import { cloneValue, mapWithConcurrency, sanitizeOrigin } from "./utils.js";

const SNAPSHOT_VERSION = "v1";
const SNAPSHOT_WRITE_LIMIT = 1000;

const CAMPAIGN_DETAIL_FIELDS = [
  "budget_limit",
  "budget_spent_today",
  "budget_rule_active",
  "spend_limit",
  "spend_spent_today",
  "spend_limit_active",
  "schedule_active",
  "schedule_active_slots",
  "schedule_total_slots",
];

function snapshotNamespace(env) {
  const originNamespace = sanitizeOrigin(env.XWAY_CACHE_NAMESPACE || env.CF_PAGES_URL || env.API_ORIGIN || "xway");
  return `catalog-article-snapshot:${originNamespace}`;
}

function normalizeIsoDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeProductRef(value) {
  const text = String(value || "").trim();
  return /^\d+:\d+$/.test(text) ? text : null;
}

function snapshotKey(start, end, productRef) {
  return `${SNAPSHOT_VERSION}:${start}:${end}:${productRef}`;
}

function metricNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = typeof value === "number" ? value : Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function campaignTypeTotalsHasSignal(totals) {
  if (!totals || typeof totals !== "object" || Array.isArray(totals)) {
    return false;
  }
  return Object.values(totals).some((metrics) => {
    if (!metrics || typeof metrics !== "object") {
      return false;
    }
    return ["views", "clicks", "atbs", "orders", "spend", "revenue"].some((field) => (metricNumber(metrics[field]) ?? 0) > 0);
  });
}

function mergeCampaignTypeTotalsPreservingSignal(baseTotals, incomingTotals) {
  if (incomingTotals === undefined) {
    return baseTotals;
  }
  if (campaignTypeTotalsHasSignal(incomingTotals) || !campaignTypeTotalsHasSignal(baseTotals)) {
    return incomingTotals;
  }
  return baseTotals;
}

function hasKnownValue(value) {
  return value !== null && value !== undefined;
}

function mergeCampaignStatesPreservingDetails(baseStates = [], incomingStates = []) {
  if (!Array.isArray(incomingStates) || !incomingStates.length) {
    return baseStates;
  }

  const baseByKey = new Map((Array.isArray(baseStates) ? baseStates : []).map((state) => [state.key, state]));
  const incomingKeys = new Set();
  const mergedIncoming = incomingStates.map((incomingState) => {
    incomingKeys.add(incomingState.key);
    const baseState = baseByKey.get(incomingState.key);
    if (!baseState) {
      return incomingState;
    }
    const mergedState = { ...baseState, ...incomingState };
    CAMPAIGN_DETAIL_FIELDS.forEach((field) => {
      if (!hasKnownValue(incomingState[field]) && hasKnownValue(baseState[field])) {
        mergedState[field] = baseState[field];
      }
    });
    return mergedState;
  });

  const baseOnly = (Array.isArray(baseStates) ? baseStates : []).filter((state) => !incomingKeys.has(state.key));
  return [...mergedIncoming, ...baseOnly];
}

function isArticleDisabled(article) {
  return article?.enabled === false || article?.is_active === false;
}

function articleHasCampaignSignals(article) {
  if (!article || isArticleDisabled(article)) {
    return false;
  }
  return (
    (Array.isArray(article.campaign_states) && article.campaign_states.length > 0) ||
    (metricNumber(article.campaigns_count) ?? 0) > 0 ||
    (metricNumber(article.manual_campaigns_count) ?? 0) > 0 ||
    (metricNumber(article.expense_sum) ?? 0) > 0
  );
}

function articleHasOrderSignals(article) {
  if (!article || isArticleDisabled(article)) {
    return false;
  }
  return (
    (metricNumber(article.orders) ?? 0) > 0 ||
    (metricNumber(article.ordered_report) ?? 0) > 0 ||
    (metricNumber(article.ordered_sum_report) ?? 0) > 0 ||
    (metricNumber(article.sum_price) ?? 0) > 0
  );
}

function normalizeSnapshotRow(rawRow) {
  const productRef = normalizeProductRef(rawRow?.product_ref ?? rawRow?.productRef);
  const article = rawRow?.article && typeof rawRow.article === "object" ? rawRow.article : rawRow;
  if (!productRef || !article || typeof article !== "object") {
    return null;
  }

  return {
    product_ref: productRef,
    article: article.article ?? null,
    product_id: article.product_id ?? null,
    campaigns_count: article.campaigns_count ?? null,
    manual_campaigns_count: article.manual_campaigns_count ?? null,
    campaign_states: Array.isArray(article.campaign_states) ? cloneValue(article.campaign_states) : [],
    campaign_type_totals:
      article.campaign_type_totals && typeof article.campaign_type_totals === "object" && !Array.isArray(article.campaign_type_totals)
        ? cloneValue(article.campaign_type_totals)
        : article.campaign_type_totals === null
          ? null
          : undefined,
    best_order_time: article.best_order_time && typeof article.best_order_time === "object" ? cloneValue(article.best_order_time) : null,
    updated_at: new Date().toISOString(),
  };
}

export async function writeCatalogArticleSnapshots(env, payload) {
  const start = normalizeIsoDate(payload?.start);
  const end = normalizeIsoDate(payload?.end);
  if (!start || !end) {
    throw new Error("Snapshot start/end must be ISO dates.");
  }

  const rawRows = Array.isArray(payload?.rows) ? payload.rows.slice(0, SNAPSHOT_WRITE_LIMIT) : [];
  const snapshots = rawRows.map(normalizeSnapshotRow).filter(Boolean);
  const namespace = snapshotNamespace(env);
  const results = await mapWithConcurrency(snapshots, 8, async (snapshot) => {
    const saved = await writeSharedCache(env, namespace, snapshotKey(start, end, snapshot.product_ref), snapshot);
    return saved ? "saved" : "skipped";
  });
  const saved = results.filter((result) => result === "saved").length;
  return {
    ok: true,
    saved,
    skipped: rawRows.length - saved,
    requested: rawRows.length,
    range: {
      current_start: start,
      current_end: end,
    },
  };
}

async function readCatalogArticleSnapshots(env, { start, end, productRefs }) {
  const keysByRef = new Map();
  productRefs.forEach((productRef) => {
    const normalizedRef = normalizeProductRef(productRef);
    if (normalizedRef) {
      keysByRef.set(snapshotKey(start, end, normalizedRef), normalizedRef);
    }
  });
  if (!keysByRef.size) {
    return new Map();
  }

  const valuesByKey = await readSharedCacheMany(env, snapshotNamespace(env), [...keysByRef.keys()]);
  const snapshotsByRef = new Map();
  valuesByKey.forEach((snapshot, key) => {
    const productRef = keysByRef.get(key);
    if (productRef && snapshot && typeof snapshot === "object") {
      snapshotsByRef.set(productRef, snapshot);
    }
  });
  return snapshotsByRef;
}

function applySnapshotToArticle(article, snapshot) {
  if (!snapshot || typeof snapshot !== "object" || isArticleDisabled(article)) {
    return article;
  }

  let changed = false;
  const next = { ...article };

  if (Array.isArray(snapshot.campaign_states) && (snapshot.campaign_states.length || articleHasCampaignSignals(article))) {
    next.campaign_states = mergeCampaignStatesPreservingDetails(article.campaign_states, snapshot.campaign_states);
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, "campaign_type_totals")) {
    next.campaign_type_totals = mergeCampaignTypeTotalsPreservingSignal(article.campaign_type_totals, snapshot.campaign_type_totals);
    changed = true;
  }

  if (snapshot.best_order_time && articleHasOrderSignals(article)) {
    next.best_order_time = cloneValue(snapshot.best_order_time);
    changed = true;
  }

  if (snapshot.campaigns_count !== null && snapshot.campaigns_count !== undefined && article.campaigns_count === null) {
    next.campaigns_count = snapshot.campaigns_count;
    changed = true;
  }
  if (snapshot.manual_campaigns_count !== null && snapshot.manual_campaigns_count !== undefined && article.manual_campaigns_count === null) {
    next.manual_campaigns_count = snapshot.manual_campaigns_count;
    changed = true;
  }

  return changed ? next : article;
}

export async function applyCatalogArticleSnapshots(env, payload) {
  const start = normalizeIsoDate(payload?.range?.current_start);
  const end = normalizeIsoDate(payload?.range?.current_end);
  const shops = Array.isArray(payload?.shops) ? payload.shops : [];
  if (!start || !end || !shops.length) {
    return payload;
  }

  const productRefs = shops.flatMap((shop) =>
    (Array.isArray(shop.articles) ? shop.articles : []).map((article) => `${shop.id}:${article.product_id}`),
  );
  const snapshotsByRef = await readCatalogArticleSnapshots(env, { start, end, productRefs });
  if (!snapshotsByRef.size) {
    return payload;
  }

  let changed = false;
  const nextShops = shops.map((shop) => ({
    ...shop,
    articles: (Array.isArray(shop.articles) ? shop.articles : []).map((article) => {
      const ref = `${shop.id}:${article.product_id}`;
      const snapshot = snapshotsByRef.get(ref);
      if (!snapshot) {
        return article;
      }
      const nextArticle = applySnapshotToArticle(article, snapshot);
      if (nextArticle !== article) {
        changed = true;
      }
      return nextArticle;
    }),
  }));

  return changed ? { ...payload, shops: nextShops } : payload;
}
