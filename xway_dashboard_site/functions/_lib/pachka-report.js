import { applyCatalogArticleSnapshots } from "./catalog-article-snapshots.js";
import { collectCatalog } from "./catalog.js";
import { collectMpvibeStocks } from "./ai/mpvibe-client.js";

const PACHKA_API_ORIGIN = "https://api.pachca.com/api/shared/v1";
const DEFAULT_REPORT_DAYS = 3;
const DEFAULT_REPORT_LIMIT = 12;
const STOCK_MIN_VALUE = 5;

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function asNumber(value) {
  const numeric = Number(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

function formatNumber(value, digits = 0) {
  const numeric = asNumber(value);
  if (numeric === null) {
    return "-";
  }
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits }).format(numeric);
}

function formatMoney(value) {
  const numeric = asNumber(value);
  if (numeric === null) {
    return "-";
  }
  return `${formatNumber(numeric)} ₽`;
}

function formatPercent(value) {
  const numeric = asNumber(value);
  if (numeric === null) {
    return "-";
  }
  return `${formatNumber(numeric, Math.abs(numeric) >= 100 ? 0 : 1)}%`;
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftedDate(baseDate, days) {
  const next = new Date(baseDate.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function reportToday(offsetMinutes) {
  const now = new Date(Date.now() + offsetMinutes * 60_000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function buildReportRange(env, options = {}) {
  const days = clampInteger(options.days ?? env.PACHKA_REPORT_DAYS, DEFAULT_REPORT_DAYS, 1, 30);
  const offsetMinutes = clampInteger(env.PACHKA_REPORT_TIMEZONE_OFFSET_MINUTES, 240, -720, 840);
  const end = shiftedDate(reportToday(offsetMinutes), -1);
  return {
    start: isoDate(shiftedDate(end, -(days - 1))),
    end: isoDate(end),
    days,
  };
}

function resolveDrr(article) {
  const explicit = asNumber(article?.drr);
  if (explicit !== null) {
    return explicit;
  }
  const spend = asNumber(article?.expense_sum);
  const revenue = asNumber(article?.sum_price);
  return spend !== null && revenue !== null && revenue > 0 ? (spend / revenue) * 100 : null;
}

function flattenCatalogRows(payload) {
  return (payload?.shops || []).flatMap((shop) =>
    (shop.articles || []).map((article) => {
      const spend = asNumber(article.expense_sum);
      const stock = asNumber(article.stock);
      return {
        ref: `${shop.id}:${article.product_id}`,
        source: "xway",
        article: asString(article.article),
        name: asString(article.name) || `Артикул ${article.article}`,
        shop_id: shop.id,
        shop_name: asString(shop.name) || `Кабинет ${shop.id}`,
        stock_xway: stock,
        stock_mpvibe: null,
        spend,
        revenue_ads: asNumber(article.sum_price),
        revenue_total: asNumber(article.ordered_sum_report),
        orders_ads: asNumber(article.orders),
        orders_total: asNumber(article.ordered_report),
        drr: resolveDrr(article),
        campaigns: Array.isArray(article.campaign_states) ? article.campaign_states.length : 0,
        active_campaigns: Array.isArray(article.campaign_states) ? article.campaign_states.filter((campaign) => campaign?.active).length : 0,
      };
    }),
  );
}

function mergeMpvibeRows(xwayRows, mpvibeRows) {
  const xwayArticleSet = new Set(xwayRows.map((row) => row.article));
  const stockByArticle = new Map((mpvibeRows || []).map((row) => [asString(row.article), row]));
  const merged = xwayRows.map((row) => ({
    ...row,
    stock_mpvibe: asNumber(stockByArticle.get(row.article)?.stock_fbo),
  }));
  const mpvibeOnlyRows = (mpvibeRows || [])
    .filter((row) => !xwayArticleSet.has(asString(row.article)) && (asNumber(row.stock_fbo) ?? 0) > 0)
    .map((row) => ({
      ref: `mpvibe:${row.card_id ?? row.article}`,
      source: "mpvibe",
      article: asString(row.article),
      name: asString(row.name) || `Артикул ${row.article}`,
      shop_id: null,
      shop_name: row.account_id ? `MPVibe account ${row.account_id}` : "MPVibe",
      stock_xway: null,
      stock_mpvibe: asNumber(row.stock_fbo),
      spend: null,
      revenue_ads: null,
      revenue_total: null,
      orders_ads: null,
      orders_total: null,
      drr: null,
      campaigns: 0,
      active_campaigns: 0,
    }));
  return [...merged, ...mpvibeOnlyRows];
}

function stockSignal(row) {
  return row.stock_xway ?? row.stock_mpvibe ?? 0;
}

function topRows(rows, limit, predicate, sortValue) {
  return rows
    .filter(predicate)
    .sort((left, right) => (sortValue(right) ?? Number.NEGATIVE_INFINITY) - (sortValue(left) ?? Number.NEGATIVE_INFINITY))
    .slice(0, limit);
}

function shortName(value, max = 54) {
  const text = asString(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rowLine(row, index, metric) {
  const stockText = `FBO XWAY/MPVibe ${formatNumber(row.stock_xway)}/${formatNumber(row.stock_mpvibe)}`;
  if (metric === "drr") {
    return `${index + 1}. ${row.article} ${shortName(row.name)} — ДРР ${formatPercent(row.drr)}, расход ${formatMoney(row.spend)}, ${stockText}`;
  }
  return `${index + 1}. ${row.article} ${shortName(row.name)} — ${stockText}, расход ${formatMoney(row.spend)}`;
}

function buildMessage(report, env) {
  const prefix = asString(env.PACHKA_REPORT_MESSAGE_PREFIX) || "Ежедневный отчет XWAY";
  const lines = [
    `${prefix}`,
    `Период: ${report.range.start} - ${report.range.end}`,
    `Расход: ${formatMoney(report.totals.spend)} · SKU XWAY: ${formatNumber(report.totals.xway_rows)} · MPVibe-only FBO: ${formatNumber(report.totals.mpvibe_only_rows)}`,
    `Остатки без расхода: ${formatNumber(report.totals.zero_spend_stock_rows)} · MPVibe: ${report.sources.mpvibe.available ? "доступен" : "недоступен"}`,
  ];
  if (report.warnings.length) {
    lines.push(`Предупреждения: ${report.warnings.join("; ")}`);
  }
  lines.push("");
  lines.push("Топ ДРР:");
  lines.push(...(report.top_drr.length ? report.top_drr.map((row, index) => rowLine(row, index, "drr")) : ["Нет строк с расходом и ДРР."]));
  lines.push("");
  lines.push("FBO без расхода:");
  lines.push(...(report.stock_no_spend.length ? report.stock_no_spend.map((row, index) => rowLine(row, index, "stock")) : ["Нет строк с FBO остатком и нулевым расходом."]));
  if (report.mpvibe_only_stock.length) {
    lines.push("");
    lines.push("Только MPVibe FBO:");
    lines.push(...report.mpvibe_only_stock.map((row, index) => `${index + 1}. ${row.article} ${shortName(row.name)} — FBO ${formatNumber(row.stock_mpvibe)}`));
  }
  lines.push("");
  lines.push(`${asString(env.PACHKA_REPORT_DASHBOARD_URL) || "https://xway-bt4.pages.dev/drr-analytics"}`);
  return lines.join("\n");
}

export function pachkaReportConfig(env) {
  return {
    enabled: String(env.PACHKA_REPORT_ENABLED || "1") !== "0",
    token_configured: Boolean(asString(env.PACHKA_ACCESS_TOKEN)),
    entity_configured: Boolean(asString(env.PACHKA_ENTITY_ID || env.PACHKA_CHAT_ID)),
    secret_configured: Boolean(asString(env.PACHKA_REPORT_SECRET)),
    entity_type: asString(env.PACHKA_ENTITY_TYPE) || "discussion",
    days: clampInteger(env.PACHKA_REPORT_DAYS, DEFAULT_REPORT_DAYS, 1, 30),
    limit: clampInteger(env.PACHKA_REPORT_LIMIT, DEFAULT_REPORT_LIMIT, 1, 50),
    cron: asString(env.PACHKA_REPORT_CRON) || "0 6 * * *",
  };
}

export async function buildPachkaReport(env, options = {}) {
  const range = buildReportRange(env, options);
  const config = pachkaReportConfig(env);
  const limit = clampInteger(options.limit ?? config.limit, config.limit, 1, 50);
  const catalog = await applyCatalogArticleSnapshots(
    env,
    await collectCatalog(env, {
      start: range.start,
      end: range.end,
      mode: "compact",
      includeAux: false,
      forceRefresh: Boolean(options.forceRefresh),
    }),
  );
  const xwayRows = flattenCatalogRows(catalog);
  const requestedArticles = [...new Set(xwayRows.map((row) => row.article).filter(Boolean))];
  const warnings = [];
  let mpvibeRows = [];
  let mpvibeAvailable = false;
  try {
    const mpvibe = await collectMpvibeStocks(env, {
      articles: requestedArticles,
      start: range.start,
      end: range.end,
      includeAllWithStock: true,
    });
    mpvibeRows = Array.isArray(mpvibe.rows) ? mpvibe.rows : [];
    mpvibeAvailable = Boolean(mpvibe.available);
    if (mpvibe.errors?.length && !mpvibeAvailable) {
      warnings.push(`MPVibe: ${asString(mpvibe.errors[0]?.error) || "нет доступных остатков"}`);
    }
  } catch (error) {
    warnings.push(`MPVibe: ${error instanceof Error ? error.message : "не удалось загрузить остатки"}`);
  }

  const rows = mergeMpvibeRows(xwayRows, mpvibeRows);
  const topDrr = topRows(rows, limit, (row) => (row.spend ?? 0) > 0 && row.drr !== null, (row) => row.drr);
  const stockNoSpend = topRows(rows, limit, (row) => stockSignal(row) > STOCK_MIN_VALUE && (row.spend ?? 0) === 0, stockSignal);
  const mpvibeOnlyStock = topRows(rows, limit, (row) => row.source === "mpvibe" && (row.stock_mpvibe ?? 0) > 0, (row) => row.stock_mpvibe);
  const report = {
    ok: true,
    generated_at: new Date().toISOString(),
    range,
    sources: {
      xway: { available: true },
      mpvibe: { available: mpvibeAvailable, rows: mpvibeRows.length },
    },
    warnings,
    totals: {
      xway_rows: xwayRows.length,
      all_rows: rows.length,
      mpvibe_only_rows: rows.filter((row) => row.source === "mpvibe").length,
      spend: rows.reduce((sum, row) => sum + (row.spend ?? 0), 0),
      zero_spend_stock_rows: rows.filter((row) => stockSignal(row) > STOCK_MIN_VALUE && (row.spend ?? 0) === 0).length,
    },
    top_drr: topDrr,
    stock_no_spend: stockNoSpend,
    mpvibe_only_stock: mpvibeOnlyStock,
  };
  return {
    ...report,
    message: buildMessage(report, env),
    config: { ...config, days: range.days, limit },
  };
}

export async function sendPachkaMessage(env, content) {
  const token = asString(env.PACHKA_ACCESS_TOKEN);
  const entityId = asString(env.PACHKA_ENTITY_ID || env.PACHKA_CHAT_ID);
  const entityType = asString(env.PACHKA_ENTITY_TYPE) || "discussion";
  if (!token || !entityId) {
    throw new Error("Pachka is not configured. Set PACHKA_ACCESS_TOKEN and PACHKA_ENTITY_ID.");
  }
  const response = await fetch(`${PACHKA_API_ORIGIN}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      accept: "application/json",
    },
    body: JSON.stringify({
      message: {
        entity_type: entityType,
        entity_id: Number(entityId),
        content,
        link_preview: false,
      },
    }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(`Pachka request failed (${response.status}): ${text.slice(0, 240) || response.statusText}`);
  }
  return payload;
}

export async function sendPachkaReport(env) {
  if (String(env.PACHKA_REPORT_ENABLED || "1") === "0") {
    return {
      ok: true,
      skipped: true,
      reason: "Pachka report is disabled.",
      sent_at: null,
      report: null,
      pachka: null,
    };
  }
  const report = await buildPachkaReport(env);
  const pachka = await sendPachkaMessage(env, report.message);
  return {
    ok: true,
    sent_at: new Date().toISOString(),
    report,
    pachka,
  };
}
