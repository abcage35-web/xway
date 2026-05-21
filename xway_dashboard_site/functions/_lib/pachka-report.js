import { applyCatalogArticleSnapshots } from "./catalog-article-snapshots.js";
import { collectCatalog, collectCatalogChart, collectCatalogProductDetails } from "./catalog.js";
import { collectCatalogIssues } from "./catalog-issues.js";
import { collectMpvibeStocks } from "./ai/mpvibe-client.js";
import {
  collectAiCampaignBidHistory,
  collectAiCampaignBudgetHistory,
  collectAiCampaignLimits,
  collectAiCampaignSchedules,
  collectAiCampaignStatusHistory,
} from "./ai/campaign-details.js";

const PACHKA_API_ORIGIN = "https://api.pachca.com/api/shared/v1";
const DEFAULT_REPORT_DAYS = 3;
const DEFAULT_REPORT_LIMIT = 12;
const DEFAULT_STOCK_MIN_VALUE = 100;
const DEFAULT_AI_DEEP_LIMIT = 2;
const DEFAULT_AI_MODEL = "gpt-5.5";
const DEFAULT_AI_REASONING_EFFORT = "medium";
const DEFAULT_AI_TEXT_VERBOSITY = "low";
const DEFAULT_AI_TIMEOUT_MS = 20_000;
const DEFAULT_AI_DEEP_TIMEOUT_MS = 30_000;
const DEFAULT_AI_FULL_REFRESH_LIMIT = 2;

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

function rate(numerator, denominator) {
  const left = asNumber(numerator);
  const right = asNumber(denominator);
  return left !== null && right !== null && right > 0 ? (left / right) * 100 : null;
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

function shiftedIsoDate(value, days) {
  const parsed = new Date(`${asString(value)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return asString(value);
  }
  return isoDate(shiftedDate(parsed, days));
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
      const campaignStates = Array.isArray(article.campaign_states) ? article.campaign_states : [];
      return {
        ref: `${shop.id}:${article.product_id}`,
        source: "xway",
        article: asString(article.article),
        name: asString(article.name) || `Артикул ${article.article}`,
        category: asString(article.category_keyword) || "Без категории",
        shop_id: shop.id,
        shop_name: asString(shop.name) || `Кабинет ${shop.id}`,
        enabled: article.enabled !== false && article.is_active !== false,
        stock_xway: stock,
        stock_mpvibe: null,
        spend,
        views: asNumber(article.views),
        clicks: asNumber(article.clicks),
        atbs: asNumber(article.atbs),
        revenue_ads: asNumber(article.sum_price),
        revenue_total: asNumber(article.ordered_sum_report),
        orders_ads: asNumber(article.orders),
        orders_total: asNumber(article.ordered_report),
        drr: resolveDrr(article),
        ctr: asNumber(article.ctr),
        cpc: asNumber(article.cpc),
        cr: asNumber(article.cr),
        cpo: asNumber(article.cpo),
        cpo_overall: asNumber(article.cpo_overall),
        campaigns: campaignStates.length,
        active_campaigns: campaignStates.filter((campaign) => campaign?.active).length,
        paused_campaigns: campaignStates.filter((campaign) => campaign?.status_code === "PAUSED").length,
        frozen_campaigns: campaignStates.filter((campaign) => campaign?.status_code === "FROZEN").length,
        spend_limit_active: campaignStates.some((campaign) => campaign?.spend_limit_active),
        spend_limit: campaignStates.reduce((sum, campaign) => sum + (asNumber(campaign?.spend_limit) ?? 0), 0) || null,
        spend_spent_today: campaignStates.reduce((sum, campaign) => sum + (asNumber(campaign?.spend_spent_today) ?? 0), 0) || null,
        budget_rule_active: campaignStates.some((campaign) => campaign?.budget_rule_active),
        budget_limit: campaignStates.reduce((sum, campaign) => sum + (asNumber(campaign?.budget_limit) ?? 0), 0) || null,
        budget_spent_today: campaignStates.reduce((sum, campaign) => sum + (asNumber(campaign?.budget_spent_today) ?? 0), 0) || null,
        schedule_active: campaignStates.some((campaign) => campaign?.schedule_active),
        schedule_active_slots: campaignStates.reduce((sum, campaign) => sum + (asNumber(campaign?.schedule_active_slots) ?? 0), 0) || null,
        schedule_total_slots: campaignStates.reduce((sum, campaign) => sum + (asNumber(campaign?.schedule_total_slots) ?? 0), 0) || null,
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
      category: "Только MPVibe",
      shop_id: null,
      shop_name: row.account_id ? `MPVibe account ${row.account_id}` : "MPVibe",
      enabled: true,
      stock_xway: null,
      stock_mpvibe: asNumber(row.stock_fbo),
      views: null,
      clicks: null,
      atbs: null,
      spend: null,
      revenue_ads: null,
      revenue_total: null,
      orders_ads: null,
      orders_total: null,
      drr: null,
      ctr: null,
      cpc: null,
      cr: null,
      cpo: null,
      cpo_overall: null,
      campaigns: 0,
      active_campaigns: 0,
      paused_campaigns: 0,
      frozen_campaigns: 0,
      spend_limit_active: false,
      spend_limit: null,
      spend_spent_today: null,
      budget_rule_active: false,
      budget_limit: null,
      budget_spent_today: null,
      schedule_active: false,
      schedule_active_slots: null,
      schedule_total_slots: null,
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

function pushUnique(target, value) {
  const text = asString(value);
  if (text && !target.includes(text)) {
    target.push(text);
  }
}

function aggregateRows(rows) {
  const totals = rows.reduce(
    (sum, row) => ({
      rows: sum.rows + 1,
      spend: sum.spend + (asNumber(row.spend) ?? 0),
      revenueAds: sum.revenueAds + (asNumber(row.revenue_ads) ?? 0),
      revenueTotal: sum.revenueTotal + (asNumber(row.revenue_total) ?? 0),
      ordersAds: sum.ordersAds + (asNumber(row.orders_ads) ?? 0),
      ordersTotal: sum.ordersTotal + (asNumber(row.orders_total) ?? 0),
      views: sum.views + (asNumber(row.views) ?? 0),
      clicks: sum.clicks + (asNumber(row.clicks) ?? 0),
      atbs: sum.atbs + (asNumber(row.atbs) ?? 0),
      stock: sum.stock + stockSignal(row),
      activeCampaigns: sum.activeCampaigns + (asNumber(row.active_campaigns) ?? 0),
      campaigns: sum.campaigns + (asNumber(row.campaigns) ?? 0),
    }),
    {
      rows: 0,
      spend: 0,
      revenueAds: 0,
      revenueTotal: 0,
      ordersAds: 0,
      ordersTotal: 0,
      views: 0,
      clicks: 0,
      atbs: 0,
      stock: 0,
      activeCampaigns: 0,
      campaigns: 0,
    },
  );
  return {
    ...totals,
    drrAds: rate(totals.spend, totals.revenueAds),
    drrTotal: rate(totals.spend, totals.revenueTotal),
    ctr: rate(totals.clicks, totals.views),
    cr: rate(totals.ordersAds, totals.clicks),
    cpc: totals.clicks > 0 ? totals.spend / totals.clicks : null,
    cpo: totals.ordersAds > 0 ? totals.spend / totals.ordersAds : null,
  };
}

function buildGroupMap(rows, keyGetter) {
  const grouped = new Map();
  rows.forEach((row) => {
    const key = asString(keyGetter(row)) || "unknown";
    grouped.set(key, [...(grouped.get(key) || []), row]);
  });
  return new Map([...grouped.entries()].map(([key, groupRows]) => [key, aggregateRows(groupRows)]));
}

function buildRecommendationContext(rows, stockThreshold) {
  const xwayRows = rows.filter((row) => row.source === "xway");
  const rowsWithSpend = xwayRows.filter((row) => (asNumber(row.spend) ?? 0) > 0);
  const total = aggregateRows(xwayRows);
  const category = buildGroupMap(xwayRows, (row) => row.category);
  const shop = buildGroupMap(xwayRows, (row) => row.shop_name);
  const maxSpend = rowsWithSpend.reduce((max, row) => Math.max(max, asNumber(row.spend) ?? 0), 0);
  const highDrrRows = rowsWithSpend.filter((row) => (asNumber(row.drr) ?? 0) >= 70);
  const noOrderSpendRows = rowsWithSpend.filter((row) => (asNumber(row.orders_ads) ?? 0) === 0);
  const stockNoSpendRows = xwayRows.filter((row) => stockSignal(row) > stockThreshold && (asNumber(row.spend) ?? 0) === 0);
  return {
    total,
    category,
    shop,
    maxSpend,
    highDrrRows,
    noOrderSpendRows,
    stockNoSpendRows,
  };
}

function groupStatsForRow(row, context) {
  return {
    category: context.category.get(asString(row.category) || "unknown") || null,
    shop: context.shop.get(asString(row.shop_name) || "unknown") || null,
  };
}

function rowShare(value, total) {
  const numeric = asNumber(value) ?? 0;
  const denominator = asNumber(total) ?? 0;
  return denominator > 0 ? (numeric / denominator) * 100 : null;
}

function buildReportInsights(report, context) {
  const insights = [];
  const totalDrr = context.total.drrTotal ?? context.total.drrAds;
  if (totalDrr !== null) {
    insights.push(`ДРР всего: ${formatPercent(totalDrr)} при расходе ${formatMoney(context.total.spend)}.`);
  }
  if (context.highDrrRows.length) {
    const spend = context.highDrrRows.reduce((sum, row) => sum + (asNumber(row.spend) ?? 0), 0);
    insights.push(`Высокий ДРР >= 70% у ${formatNumber(context.highDrrRows.length)} SKU, расход в зоне риска ${formatMoney(spend)}.`);
  }
  if (context.noOrderSpendRows.length) {
    const spend = context.noOrderSpendRows.reduce((sum, row) => sum + (asNumber(row.spend) ?? 0), 0);
    insights.push(`Есть расход без заказов: ${formatNumber(context.noOrderSpendRows.length)} SKU на ${formatMoney(spend)}.`);
  }
  if (context.stockNoSpendRows.length) {
    insights.push(`Есть товары с FBO > ${formatNumber(report.config.stock_min_value)} без расхода: ${formatNumber(context.stockNoSpendRows.length)} SKU.`);
  }
  if (!report.sources.mpvibe.available) {
    insights.push("MPVibe сейчас недоступен, рекомендации по остаткам строятся по XWAY и требуют последующей сверки.");
  }
  return insights;
}

function stockMismatchRecommendation(row, mpvibeAvailable) {
  const xwayStock = asNumber(row.stock_xway);
  const mpvibeStock = asNumber(row.stock_mpvibe);
  if (!mpvibeAvailable) {
    return xwayStock !== null ? "MPVibe недоступен, сверить остаток позже" : "";
  }
  if (xwayStock === null && mpvibeStock !== null) {
    return "остаток есть только в MPVibe";
  }
  if (xwayStock !== null && mpvibeStock === null) {
    return "сверить MPVibe остаток";
  }
  if (xwayStock === null || mpvibeStock === null) {
    return "";
  }
  const diff = Math.abs(xwayStock - mpvibeStock);
  const base = Math.max(xwayStock, mpvibeStock, 1);
  return diff > 20 && diff / base > 0.03 ? "сверить остатки XWAY/MPVibe" : "";
}

function limitUsage(row) {
  const spendLimit = asNumber(row.spend_limit);
  const spendToday = asNumber(row.spend_spent_today);
  const budgetLimit = asNumber(row.budget_limit);
  const budgetToday = asNumber(row.budget_spent_today);
  return {
    spend: spendLimit !== null && spendLimit > 0 && spendToday !== null ? (spendToday / spendLimit) * 100 : null,
    budget: budgetLimit !== null && budgetLimit > 0 && budgetToday !== null ? (budgetToday / budgetLimit) * 100 : null,
  };
}

function buildDrrRecommendation(row, stockThreshold, mpvibeAvailable, context) {
  const drr = asNumber(row.drr);
  const spend = asNumber(row.spend) ?? 0;
  const ordersAds = asNumber(row.orders_ads) ?? 0;
  const ordersTotal = asNumber(row.orders_total) ?? 0;
  const clicks = asNumber(row.clicks) ?? 0;
  const ctr = asNumber(row.ctr) ?? rate(row.clicks, row.views);
  const cr = asNumber(row.cr) ?? rate(row.orders_ads, row.clicks);
  const cpc = asNumber(row.cpc);
  const cpo = asNumber(row.cpo);
  const stock = stockSignal(row);
  const notes = [];
  const groups = groupStatsForRow(row, context);
  const spendShare = rowShare(spend, context.total.spend);
  const categoryDrr = groups.category?.drrTotal ?? groups.category?.drrAds ?? null;
  const shopDrr = groups.shop?.drrTotal ?? groups.shop?.drrAds ?? null;

  if (drr !== null && drr >= 100) {
    pushUnique(notes, "срочно снизить ставки/лимиты, оставить только связки с заказами");
  } else if (drr !== null && drr >= 70) {
    pushUnique(notes, "снизить ставки и убрать слабые запросы");
  } else if (drr !== null && drr >= 50) {
    pushUnique(notes, "оптимизировать ставки, оставить конверсионные связки");
  } else {
    pushUnique(notes, "контролировать ДРР, масштабировать только при достаточной марже");
  }
  if (categoryDrr !== null && drr !== null && drr > categoryDrr * 1.35) {
    pushUnique(notes, `хуже категории (${formatPercent(categoryDrr)}): перераспределить бюджет в более эффективные SKU`);
  } else if (shopDrr !== null && drr !== null && drr > shopDrr * 1.35) {
    pushUnique(notes, `хуже кабинета (${formatPercent(shopDrr)}): понизить приоритет в рекламе`);
  }
  if (spendShare !== null && spendShare >= 5 && drr !== null && drr >= 50) {
    pushUnique(notes, `занимает ${formatPercent(spendShare)} расхода отчета, править в первую очередь`);
  }
  if (spend >= Math.max(5000, context.maxSpend * 0.08) && ordersAds <= 1) {
    pushUnique(notes, "расход заметный, заказов почти нет: проверить карточку, цену и релевантность запросов");
  }
  if (clicks >= 80 && cr !== null && cr < 1) {
    pushUnique(notes, `низкая конверсия ${formatPercent(cr)} при кликах: проверить цену, отзывы, фото и оффер`);
  }
  if (ctr !== null && groups.category?.ctr && ctr < groups.category.ctr * 0.65) {
    pushUnique(notes, `CTR ниже категории (${formatPercent(groups.category.ctr)}): обновить креатив/название/поисковые фразы`);
  }
  if (cpc !== null && groups.category?.cpc && cpc > groups.category.cpc * 1.35) {
    pushUnique(notes, `CPC выше категории (${formatMoney(groups.category.cpc)}): снизить ставки`);
  }
  if (cpo !== null && ordersAds > 0 && groups.category?.cpo && cpo > groups.category.cpo * 1.35) {
    pushUnique(notes, `CPO выше категории (${formatMoney(groups.category.cpo)}): чистить неэффективные размещения`);
  }
  if (ordersAds === 0 && ordersTotal > 0) {
    pushUnique(notes, "органические заказы есть, реклама не окупается: снизить платный трафик и оставить тесты");
  }
  if (!row.enabled) {
    pushUnique(notes, "товар выключен в XWAY: проверить актуальность запуска рекламы");
  }
  if ((row.frozen_campaigns ?? 0) > 0) {
    pushUnique(notes, "есть замороженные РК: проверить бюджет/лимиты/модерацию");
  }
  const usage = limitUsage(row);
  if ((usage.spend !== null && usage.spend >= 90) || (usage.budget !== null && usage.budget >= 90)) {
    pushUnique(notes, drr !== null && drr < 50 ? "лимит почти выбран, повышать только для эффективных связок" : "лимит почти выбран, не расширять до снижения ДРР");
  }
  if (stock <= stockThreshold) {
    pushUnique(notes, "не разгонять рекламу до пополнения FBO");
  }
  const stockNote = stockMismatchRecommendation(row, mpvibeAvailable);
  if (stockNote) {
    pushUnique(notes, stockNote);
  }
  return notes.slice(0, 4).join("; ");
}

function buildStockNoSpendRecommendation(row, stockThreshold, mpvibeAvailable, context) {
  const stock = stockSignal(row);
  const notes = [];
  const groups = groupStatsForRow(row, context);
  if ((row.active_campaigns ?? 0) > 0) {
    pushUnique(notes, "РК есть, но расхода нет: проверить ставки, лимиты, расписание и статус показа");
  } else if ((row.campaigns ?? 0) > 0) {
    pushUnique(notes, "есть выключенные РК: проверить причину и включить при марже");
  } else {
    pushUnique(notes, "создать или запустить РК, если товар маржинален");
  }
  if (stock > stockThreshold * 5) {
    pushUnique(notes, "остаток высокий, приоритет для запуска");
  }
  if (groups.category && groups.category.drrTotal !== null && groups.category.drrTotal < 40) {
    pushUnique(notes, `категория эффективная (${formatPercent(groups.category.drrTotal)} ДРР), можно тестировать аккуратный запуск`);
  }
  if (groups.category && groups.category.drrTotal !== null && groups.category.drrTotal >= 70) {
    pushUnique(notes, `категория дорогая (${formatPercent(groups.category.drrTotal)} ДРР), запускать только с жестким лимитом`);
  }
  if ((row.frozen_campaigns ?? 0) > 0 || (row.paused_campaigns ?? 0) > 0) {
    pushUnique(notes, "разобрать паузы/заморозки перед запуском нового трафика");
  }
  const stockNote = stockMismatchRecommendation(row, mpvibeAvailable);
  if (stockNote) {
    pushUnique(notes, stockNote);
  }
  return notes.slice(0, 4).join("; ");
}

function buildMpvibeOnlyRecommendation(row, stockThreshold) {
  const stock = stockSignal(row);
  const notes = ["проверить маппинг/импорт в XWAY, остаток есть в MPVibe"];
  if (stock > stockThreshold * 5) {
    notes.push("остаток высокий, завести в XWAY приоритетно");
  }
  notes.push("до синхронизации учитывать FBO отдельно");
  return notes.join("; ");
}

function roundedNumber(value, digits = 2) {
  const numeric = asNumber(value);
  return numeric === null ? null : Number(numeric.toFixed(digits));
}

function cleanAiText(value, max = 280) {
  const text = asString(value)
    .replace(/\bdeep dive\b/gi, "детальной проверке")
    .replace(/\bfull_refresh_context\b/gi, "полном обновлении данных")
    .replace(/\bfocused_product_refresh\b/gi, "точечном обновлении данных")
    .replace(/\bcompact context\b/gi, "компактном отчете")
    .replace(/\bfirst_pass\b/gi, "черновом анализе")
    .replace(/\bfallback\b/gi, "резервной оценке")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanAiReportText(value, report, max = 280) {
  const text = cleanAiText(value, max);
  if (!text) {
    return "";
  }
  const mpvibeAvailable = Boolean(report?.sources?.mpvibe?.available);
  const saysMpvibeUnavailable = /(?:mpvibe|данн[а-яё\s]*mpvibe).{0,80}(?:недоступ|не доступ|нет данных|не вернул|не получ)/i.test(text);
  const saysMpvibeAvailable = /mpvibe.{0,80}(?:доступен|доступны|учтен|учтены|подтвержден|подтверждены)/i.test(text);
  if (mpvibeAvailable && saysMpvibeUnavailable) {
    return "";
  }
  if (!mpvibeAvailable && saysMpvibeAvailable) {
    return "";
  }
  return text;
}

function compactStats(stats = {}) {
  const source = stats || {};
  return {
    rows: source.rows ?? null,
    spend: roundedNumber(source.spend, 0),
    revenue_ads: roundedNumber(source.revenueAds, 0),
    revenue_total: roundedNumber(source.revenueTotal, 0),
    orders_ads: roundedNumber(source.ordersAds, 0),
    orders_total: roundedNumber(source.ordersTotal, 0),
    views: roundedNumber(source.views, 0),
    clicks: roundedNumber(source.clicks, 0),
    atbs: roundedNumber(source.atbs, 0),
    stock: roundedNumber(source.stock, 0),
    drr_ads: roundedNumber(source.drrAds, 1),
    drr_total: roundedNumber(source.drrTotal, 1),
    ctr: roundedNumber(source.ctr, 2),
    cr: roundedNumber(source.cr, 2),
    cpc: roundedNumber(source.cpc, 0),
    cpo: roundedNumber(source.cpo, 0),
    campaigns: roundedNumber(source.campaigns, 0),
    active_campaigns: roundedNumber(source.activeCampaigns, 0),
  };
}

function groupMapToAiList(groupMap, sortKey = "spend", limit = 10) {
  return [...(groupMap || new Map()).entries()]
    .map(([name, stats]) => ({
      name,
      ...compactStats(stats),
    }))
    .sort((left, right) => (asNumber(right[sortKey]) ?? 0) - (asNumber(left[sortKey]) ?? 0))
    .slice(0, limit);
}

function compactReportRow(row, fallbackRecommendation, context) {
  const groups = groupStatsForRow(row, context);
  return {
    article: row.article,
    name: shortName(row.name, 140),
    source: row.source,
    category: row.category,
    shop: row.shop_name,
    enabled: row.enabled,
    spend: roundedNumber(row.spend, 0),
    drr: roundedNumber(row.drr, 1),
    revenue_ads: roundedNumber(row.revenue_ads, 0),
    revenue_total: roundedNumber(row.revenue_total, 0),
    orders_ads: roundedNumber(row.orders_ads, 0),
    orders_total: roundedNumber(row.orders_total, 0),
    views: roundedNumber(row.views, 0),
    clicks: roundedNumber(row.clicks, 0),
    atbs: roundedNumber(row.atbs, 0),
    ctr: roundedNumber(row.ctr ?? rate(row.clicks, row.views), 2),
    cpc: roundedNumber(row.cpc, 0),
    cr: roundedNumber(row.cr ?? rate(row.orders_ads, row.clicks), 2),
    cpo: roundedNumber(row.cpo, 0),
    stock_xway: roundedNumber(row.stock_xway, 0),
    stock_mpvibe: roundedNumber(row.stock_mpvibe, 0),
    campaigns: roundedNumber(row.campaigns, 0),
    active_campaigns: roundedNumber(row.active_campaigns, 0),
    paused_campaigns: roundedNumber(row.paused_campaigns, 0),
    frozen_campaigns: roundedNumber(row.frozen_campaigns, 0),
    spend_limit_active: Boolean(row.spend_limit_active),
    spend_limit: roundedNumber(row.spend_limit, 0),
    spend_spent_today: roundedNumber(row.spend_spent_today, 0),
    budget_rule_active: Boolean(row.budget_rule_active),
    budget_limit: roundedNumber(row.budget_limit, 0),
    budget_spent_today: roundedNumber(row.budget_spent_today, 0),
    schedule_active: Boolean(row.schedule_active),
    schedule_active_slots: roundedNumber(row.schedule_active_slots, 0),
    schedule_total_slots: roundedNumber(row.schedule_total_slots, 0),
    category_benchmark: groups.category ? compactStats(groups.category) : null,
    shop_benchmark: groups.shop ? compactStats(groups.shop) : null,
    fallback_recommendation: fallbackRecommendation,
  };
}

function buildAiReportContext(report, env, context) {
  const stockThreshold = report.config?.stock_min_value ?? DEFAULT_STOCK_MIN_VALUE;
  const mpvibeAvailable = Boolean(report.sources?.mpvibe?.available);
  return {
    kind: "pachka_daily_report",
    language: "ru",
    dashboard_url: asString(env.PACHKA_REPORT_DASHBOARD_URL) || "https://xway-bt4.pages.dev/drr-analytics",
    range: report.range,
    generated_at: report.generated_at,
    thresholds: {
      stock_min_value: stockThreshold,
    },
    sources: report.sources,
    warnings: report.warnings,
    totals: {
      xway_rows: report.totals.xway_rows,
      all_rows: report.totals.all_rows,
      spend: roundedNumber(report.totals.spend, 0),
      mpvibe_only_rows: report.totals.mpvibe_only_rows,
      zero_spend_stock_rows: report.totals.zero_spend_stock_rows,
      total_metrics: compactStats(context.total),
    },
    aggregates: {
      categories_by_spend: groupMapToAiList(context.category, "spend", 12),
      categories_by_drr: groupMapToAiList(context.category, "drr_total", 12),
      shops_by_spend: groupMapToAiList(context.shop, "spend", 8),
    },
    deterministic_insights: buildReportInsights(report, context),
    recommendation_articles: {
      top_drr: report.top_drr.map((row) => row.article),
      fbo_stock_no_spend: report.stock_no_spend.map((row) => row.article),
      mpvibe_only_stock: report.mpvibe_only_stock.map((row) => row.article),
    },
    sections: {
      top_drr: report.top_drr.map((row) =>
        compactReportRow(row, buildDrrRecommendation(row, stockThreshold, mpvibeAvailable, context), context),
      ),
      fbo_stock_no_spend: report.stock_no_spend.map((row) =>
        compactReportRow(row, buildStockNoSpendRecommendation(row, stockThreshold, mpvibeAvailable, context), context),
      ),
      mpvibe_only_stock: report.mpvibe_only_stock.map((row) =>
        compactReportRow(row, buildMpvibeOnlyRecommendation(row, stockThreshold), context),
      ),
    },
  };
}

function openAiOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const chunks = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function parseJsonFromText(text) {
  const cleaned = asString(text);
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [
    fenced?.[1],
    cleaned,
    cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation.
    }
  }
  throw new Error("OpenAI returned non-JSON recommendations.");
}

function normalizeChoice(value, fallback, allowed) {
  const text = asString(value).toLowerCase();
  return allowed.includes(text) ? text : fallback;
}

function supportsGpt5Controls(model) {
  return /^gpt-5(?:[.-]|$)/i.test(asString(model));
}

function openAiGenerationOptions(env, model) {
  if (!supportsGpt5Controls(model)) {
    return {};
  }
  return {
    reasoning: {
      effort: normalizeChoice(env.PACHKA_REPORT_AI_REASONING_EFFORT, DEFAULT_AI_REASONING_EFFORT, ["none", "low", "medium", "high", "xhigh"]),
    },
    text: {
      verbosity: normalizeChoice(env.PACHKA_REPORT_AI_TEXT_VERBOSITY, DEFAULT_AI_TEXT_VERBOSITY, ["low", "medium", "high"]),
    },
  };
}

function analystProfileInstructions() {
  return [
    "Профиль аналитика для XWAY:",
    "- Пиши как операционный performance-аналитик, а не как генератор общих советов.",
    "- Цель рекомендации: дать владельцу рекламы следующее конкретное действие на сегодня.",
    "- Логика диагностики: сначала оцени расход/ДРР/заказы; затем CTR, CPC, CR, CPO; затем сравни с категорией и кабинетом; затем статусы РК, лимиты, расписание; только после этого решай, нужны ли кластеры.",
    "- Углубляйся в кластеры только если компактные метрики не объясняют проблему или явно указывают на ставки/запросы/размещения.",
    "- В рекомендации должны быть: причина из данных, действие, и при необходимости ограничение по риску.",
    "- Если данных недостаточно, пиши какую проверку сделать, а не придумывай вывод.",
    "- Не используй пустые формулировки: 'проанализировать', 'оптимизировать', 'улучшить' без объекта проверки и критерия.",
    "- Не советуй масштабировать рекламу при низком FBO или неподтвержденной марже.",
    "- Не говори 'срочно', если расход небольшой и нет явного риска быстрого слива бюджета.",
    "- MPVibe используй только для остатков и маппинга. Доступность MPVibe бери строго из sources.mpvibe.available.",
    "- Если MPVibe недоступен, отчет должен оставаться полезным по XWAY-данным и только отметить необходимость последующей сверки остатков.",
  ].join("\n");
}

async function callOpenAiJson(env, { model, instructions, input, timeoutMs }) {
  const apiKey = asString(env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions,
        input: [
          "Верни только валидный JSON без markdown-блока.",
          "Контекст:",
          JSON.stringify(input),
        ].join("\n"),
        max_output_tokens: 2200,
        ...openAiGenerationOptions(env, model),
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
      throw new Error(payload?.error?.message || text || `OpenAI request failed (${response.status})`);
    }
    return parseJsonFromText(openAiOutputText(payload));
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function recommendationEntries(payload) {
  const raw = payload?.recommendations || payload?.row_recommendations || {};
  const entries = [];
  const visit = (value, fallbackArticle = "") => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, fallbackArticle));
      return;
    }
    if (value && typeof value === "object") {
      const article = asString(value.article || fallbackArticle);
      const recommendation = value.recommendation ?? value.text ?? value.value;
      if (article && recommendation !== undefined && recommendation !== null && typeof recommendation !== "object") {
        entries.push([article, recommendation]);
        return;
      }
      Object.entries(value).forEach(([key, child]) => visit(child, key));
      return;
    }
    if (fallbackArticle && value !== undefined && value !== null) {
      entries.push([fallbackArticle, value]);
    }
  };
  visit(raw);
  return entries;
}

function reportArticleSet(report) {
  return new Set(
    [...(report.top_drr || []), ...(report.stock_no_spend || []), ...(report.mpvibe_only_stock || [])]
      .map((row) => asString(row.article))
      .filter(Boolean),
  );
}

function publicFullContextSummary(fullContext) {
  if (!fullContext) {
    return null;
  }
  return {
    mode: fullContext.mode,
    auto_refresh: Boolean(fullContext.auto_refresh),
    refreshed_at: fullContext.refreshed_at || null,
    articles: fullContext.articles || [],
    product_refs: fullContext.product_refs || [],
    sources: fullContext.sources || {},
    data_manifest: fullContext.data_manifest || [],
  };
}

function normalizeAiAnalysis(payload, { report, model, usedDeepDive = false, deepDiveArticles = [], deepDiveError = null, fullContext = null } = {}) {
  const allowedArticles = reportArticleSet(report);
  const recommendationsByArticle = new Map();
  recommendationEntries(payload).forEach(([article, recommendation]) => {
    const key = asString(article);
    const value = cleanAiReportText(recommendation, report);
    if (key && value && allowedArticles.has(key)) {
      recommendationsByArticle.set(key, value);
    }
  });
  const insights = (payload?.insights || payload?.report_insights || [])
    .map((value) => cleanAiReportText(value, report, 360))
    .filter(Boolean)
    .slice(0, 6);
  const analysisNote = cleanAiReportText(payload?.analysis_note || payload?.decision || "", report, 360);
  return {
    available: true,
    model,
    used_deep_dive: usedDeepDive,
    deep_dive_articles: deepDiveArticles,
    deep_dive_error: deepDiveError,
    full_context: publicFullContextSummary(fullContext),
    analysis_note: analysisNote,
    insights,
    recommendationsByArticle,
  };
}

function normalizeDeepDiveArticles(payload, report, limit) {
  const allowed = new Map(
    [...(report.top_drr || []), ...(report.stock_no_spend || [])]
      .filter((row) => row.source === "xway")
      .map((row) => [asString(row.article), row]),
  );
  const requested = (payload?.deep_dive_articles || payload?.articles_for_deep_dive || [])
    .map((item) => (typeof item === "string" ? { article: item } : item))
    .map((item) => ({
      article: asString(item?.article),
      reason: cleanAiText(item?.reason || item?.why || "", 180),
      focus: Array.isArray(item?.focus) ? item.focus.map(asString).filter(Boolean).slice(0, 5) : [],
    }))
    .filter((item) => item.article && allowed.has(item.article));

  const unique = [];
  const seen = new Set();
  requested.forEach((item) => {
    if (!seen.has(item.article)) {
      seen.add(item.article);
      unique.push(item);
    }
  });

  if (!unique.length && payload?.need_deep_dive) {
    [...allowed.values()]
      .sort((left, right) => (asNumber(right.spend) ?? 0) - (asNumber(left.spend) ?? 0))
      .slice(0, limit)
      .forEach((row) => {
        unique.push({
          article: row.article,
          reason: "нужно проверить кампании, ставки и кластеры для точной рекомендации",
          focus: ["campaigns", "clusters", "bids"],
        });
      });
  }

  return unique.slice(0, limit);
}

function compactDailyRow(row) {
  return {
    day: row?.day ?? row?.date ?? null,
    views: roundedNumber(row?.views, 0),
    clicks: roundedNumber(row?.clicks, 0),
    orders: roundedNumber(row?.orders, 0),
    spend: roundedNumber(row?.expense_sum ?? row?.spend, 0),
    revenue: roundedNumber(row?.sum_price ?? row?.revenue, 0),
    drr: roundedNumber(row?.DRR ?? row?.drr, 1),
    cpo: roundedNumber(row?.CPO ?? row?.cpo, 0),
  };
}

function compactClusterForAi(cluster) {
  return {
    id: cluster?.normquery_id,
    name: shortName(cluster?.name, 110),
    views: roundedNumber(cluster?.views, 0),
    clicks: roundedNumber(cluster?.clicks, 0),
    orders: roundedNumber(cluster?.orders, 0),
    expense: roundedNumber(cluster?.expense, 0),
    ctr: roundedNumber(cluster?.ctr, 2),
    cr: roundedNumber(cluster?.cr, 2),
    cpc: roundedNumber(cluster?.cpc, 0),
    cpo: roundedNumber(cluster?.cpo, 0),
    bid: roundedNumber(cluster?.bid, 0),
    bid_rule_active: Boolean(cluster?.bid_rule_active),
    bid_rule_target_place: cluster?.bid_rule_target_place ?? null,
    bid_rule_max_cpm: roundedNumber(cluster?.bid_rule_max_cpm, 0),
    fixed: Boolean(cluster?.fixed),
    excluded: Boolean(cluster?.excluded),
    is_main: Boolean(cluster?.is_main),
    position: roundedNumber(cluster?.position, 0),
    latest_org_pos: roundedNumber(cluster?.latest_org_pos, 0),
    latest_promo_pos: roundedNumber(cluster?.latest_promo_pos, 0),
  };
}

function topClustersForAi(items, key, limit = 8, includeExcluded = false) {
  return [...(items || [])]
    .filter((cluster) => includeExcluded || !cluster?.excluded)
    .sort((left, right) => (asNumber(right?.[key]) ?? 0) - (asNumber(left?.[key]) ?? 0))
    .slice(0, limit)
    .map(compactClusterForAi);
}

function compactCampaignForAi(campaign) {
  const metrics = campaign?.metrics || {};
  const clusters = campaign?.clusters || {};
  return {
    id: campaign?.id,
    wb_id: campaign?.wb_id,
    name: shortName(campaign?.name, 120),
    type: campaign?.payment_type,
    status: campaign?.status_xway || campaign?.status,
    query_main: shortName(campaign?.query_main, 90),
    bid: roundedNumber(campaign?.bid, 0),
    mp_bid: roundedNumber(campaign?.mp_bid, 0),
    budget: roundedNumber(campaign?.budget, 0),
    spend_day: roundedNumber(campaign?.spend?.DAY, 0),
    schedule_active: Boolean(campaign?.schedule_active),
    budget_rule_active: Boolean(campaign?.budget_rule_config?.is_active || campaign?.budget_rule?.is_active),
    metrics: {
      views: roundedNumber(metrics.views, 0),
      clicks: roundedNumber(metrics.clicks, 0),
      orders: roundedNumber(metrics.orders, 0),
      spend: roundedNumber(metrics.sum, 0),
      revenue: roundedNumber(metrics.sum_price, 0),
      ctr: roundedNumber(metrics.ctr, 2),
      cr: roundedNumber(metrics.cr, 2),
      cpc: roundedNumber(metrics.cpc, 0),
      cpo: roundedNumber(metrics.cpo, 0),
      drr: roundedNumber(metrics.sum && metrics.sum_price ? (Number(metrics.sum) / Number(metrics.sum_price)) * 100 : null, 1),
    },
    clusters: {
      available: Boolean(clusters.available),
      total: clusters.total_clusters ?? 0,
      loaded: Array.isArray(clusters.items) ? clusters.items.length : 0,
      excluded: clusters.excluded ?? null,
      fixed: clusters.fixed ?? null,
      top_by_spend: topClustersForAi(clusters.items, "expense", 8),
      top_by_views: topClustersForAi(clusters.items, "views", 8),
      excluded_with_spend: topClustersForAi(clusters.items, "expense", 4, true).filter((cluster) => cluster.excluded && (asNumber(cluster.expense) ?? 0) > 0),
    },
    errors: {
      schedule: campaign?.schedule_error || null,
      bid_history: campaign?.bid_history_error || null,
      budget_history: campaign?.budget_history_error || null,
      clusters: campaign?.cluster_errors || null,
    },
  };
}

function compactProductForAi(product) {
  const metrics = product?.range_metrics || {};
  const campaigns = [...(product?.campaigns || [])]
    .sort((left, right) => (asNumber(right?.metrics?.sum) ?? 0) - (asNumber(left?.metrics?.sum) ?? 0))
    .slice(0, 5)
    .map(compactCampaignForAi);
  return {
    article: product?.article,
    product: {
      name: shortName(product?.identity?.name, 140),
      category: product?.identity?.category_keyword,
      shop: product?.shop?.name,
      enabled: product?.flags?.enabled,
      stock: roundedNumber(product?.stock?.current ?? product?.stock?.list_stock, 0),
    },
    totals: {
      views: roundedNumber(metrics.views, 0),
      clicks: roundedNumber(metrics.clicks, 0),
      atbs: roundedNumber(metrics.atbs, 0),
      orders: roundedNumber(metrics.orders, 0),
      total_orders: roundedNumber(metrics.ordered_report, 0),
      spend: roundedNumber(metrics.sum, 0),
      revenue_ads: roundedNumber(metrics.sum_price, 0),
      revenue_total: roundedNumber(metrics.ordered_sum_report, 0),
      ctr: roundedNumber(metrics.ctr, 2),
      cr: roundedNumber(metrics.cr, 2),
      cpc: roundedNumber(metrics.cpc, 0),
      cpo: roundedNumber(metrics.cpo, 0),
      drr: roundedNumber(metrics.drr, 1),
    },
    daily_latest: (product?.daily_stats || []).slice(-7).map(compactDailyRow),
    schedule_aggregate: product?.schedule_aggregate || null,
    campaigns,
    errors: product?.errors || null,
  };
}

function compactDeepDivePayload(payload) {
  return {
    range: payload?.range || null,
    not_found: payload?.not_found || [],
    products: (payload?.products || []).map(compactProductForAi),
  };
}

function reportRowsByArticle(report) {
  const rows = [...(report.top_drr || []), ...(report.stock_no_spend || []), ...(report.mpvibe_only_stock || [])];
  const byArticle = new Map();
  rows.forEach((row) => {
    const article = asString(row.article);
    if (article && !byArticle.has(article)) {
      byArticle.set(article, row);
    }
  });
  return byArticle;
}

function priorityRecommendationRows(report) {
  return [...(report.top_drr || []), ...(report.stock_no_spend || [])]
    .filter((row) => row.source === "xway" && asString(row.article))
    .sort((left, right) => {
      const leftScore = (asNumber(left.spend) ?? 0) * Math.max(asNumber(left.drr) ?? 1, 1) + stockSignal(left);
      const rightScore = (asNumber(right.spend) ?? 0) * Math.max(asNumber(right.drr) ?? 1, 1) + stockSignal(right);
      return rightScore - leftScore;
    });
}

function buildFullRefreshArticleList(report, deepDiveArticles, limit) {
  const rowsByArticle = reportRowsByArticle(report);
  const articles = [];
  const pushArticle = (article, reason = "") => {
    const key = asString(article);
    const row = rowsByArticle.get(key);
    if (!key || !row || row.source !== "xway" || articles.some((item) => item.article === key)) {
      return;
    }
    articles.push({
      article: key,
      reason: reason || "автообновление полного набора данных для рекомендации",
      focus: ["catalog", "campaigns", "charts", "issues", "clusters"],
    });
  };

  (deepDiveArticles || []).forEach((item) => pushArticle(item.article, item.reason));
  priorityRecommendationRows(report).forEach((row) => pushArticle(row.article));
  return articles.slice(0, limit);
}

function productRefsForArticles(report, articles) {
  const rowsByArticle = reportRowsByArticle(report);
  return articles
    .map((item) => rowsByArticle.get(asString(item.article))?.ref)
    .map(asString)
    .filter((ref) => /^\d+:\d+$/.test(ref));
}

function compactCatalogChartRow(row) {
  return {
    day: row?.day,
    views: roundedNumber(row?.views, 0),
    clicks: roundedNumber(row?.clicks, 0),
    atbs: roundedNumber(row?.atbs, 0),
    orders: roundedNumber(row?.orders, 0),
    ordered_total: roundedNumber(row?.ordered_total, 0),
    spend: roundedNumber(row?.expense_sum, 0),
    revenue_ads: roundedNumber(row?.sum_price, 0),
    revenue_total: roundedNumber(row?.ordered_sum_total, 0),
    ctr: roundedNumber(row?.CTR ?? rate(row?.clicks, row?.views), 2),
    cr: roundedNumber(row?.CR ?? rate(row?.orders, row?.clicks), 2),
    drr: roundedNumber(row?.DRR ?? rate(row?.expense_sum, row?.ordered_sum_total || row?.sum_price), 1),
    campaign_type_metrics: row?.metrics_by_campaign_type || null,
  };
}

function compactChartRows(rows, limit = 7) {
  const source = Array.isArray(rows) ? rows : [];
  return {
    latest: source.slice(-limit).map(compactCatalogChartRow),
    top_spend_days: [...source]
      .sort((left, right) => (asNumber(right?.expense_sum) ?? 0) - (asNumber(left?.expense_sum) ?? 0))
      .slice(0, 5)
      .map(compactCatalogChartRow),
    worst_drr_days: [...source]
      .filter((row) => asNumber(row?.DRR ?? rate(row?.expense_sum, row?.ordered_sum_total || row?.sum_price)) !== null)
      .sort((left, right) =>
        (asNumber(right?.DRR ?? rate(right?.expense_sum, right?.ordered_sum_total || right?.sum_price)) ?? 0) -
        (asNumber(left?.DRR ?? rate(left?.expense_sum, left?.ordered_sum_total || left?.sum_price)) ?? 0),
      )
      .slice(0, 5)
      .map(compactCatalogChartRow),
  };
}

function compactCatalogChartPayload(payload) {
  if (!payload) {
    return null;
  }
  return {
    generated_at: payload.generated_at,
    range: payload.range,
    requested_products: payload.requested_products || [],
    loaded_products_count: payload.loaded_products_count,
    complete: payload.complete,
    totals: payload.totals,
    campaign_type_meta: payload.campaign_type_meta,
    rows: compactChartRows(payload.rows),
    product_rows: (payload.product_rows || []).map((product) => ({
      product_ref: product.product_ref,
      rows: compactChartRows(product.rows),
    })),
    errors: payload.errors || [],
  };
}

function compactCatalogDetailsPayload(payload) {
  if (!payload) {
    return null;
  }
  return {
    generated_at: payload.generated_at,
    range: payload.range,
    requested_products: payload.requested_products || [],
    loaded_products_count: payload.loaded_products_count,
    rows: (payload.rows || []).map((row) => ({
      product_ref: row.product_ref,
      campaign_states: (row.campaign_states || []).map((campaign) => ({
        id: campaign.id,
        status_code: campaign.status_code,
        active: campaign.active,
        spend_limit_active: campaign.spend_limit_active,
        spend_limit: roundedNumber(campaign.spend_limit, 0),
        spend_spent_today: roundedNumber(campaign.spend_spent_today, 0),
        budget_rule_active: campaign.budget_rule_active,
        budget_limit: roundedNumber(campaign.budget_limit, 0),
        budget_spent_today: roundedNumber(campaign.budget_spent_today, 0),
        schedule_active: campaign.schedule_active,
      })),
      campaign_type_totals: row.campaign_type_totals || null,
      best_order_time: row.best_order_time || null,
      errors: row.errors || {},
    })),
    errors: payload.errors || [],
  };
}

function compactTurnoverPayload(payload) {
  const rows = flattenCatalogRows(payload);
  return {
    generated_at: payload?.generated_at || null,
    range: payload?.range || null,
    rows: rows.map((row) => ({
      ref: row.ref,
      article: row.article,
      orders_total: roundedNumber(row.orders_total, 0),
      revenue_total: roundedNumber(row.revenue_total, 0),
      spend: roundedNumber(row.spend, 0),
      stock_xway: roundedNumber(row.stock_xway, 0),
    })),
  };
}

function compactIssuesPayload(payload) {
  if (!payload) {
    return null;
  }
  return {
    generated_at: payload.generated_at,
    range: payload.range,
    requested_products: payload.requested_products || [],
    loaded_products_count: payload.loaded_products_count,
    rows: (payload.rows || []).map((row) => ({
      product_ref: row.product_ref,
      issues_count: Array.isArray(row.issues) ? row.issues.length : 0,
      campaigns_count: Array.isArray(row.campaigns) ? row.campaigns.length : 0,
      issues: (row.issues || []).slice(0, 10),
      campaigns: (row.campaigns || []).slice(0, 10),
      error: row.error || null,
    })),
  };
}

async function timedRecommendationSource(name, timeoutMs, fn) {
  try {
    const payload = await withTimeout(fn(), timeoutMs, `${name} timed out.`);
    return { name, payload, error: null };
  } catch (error) {
    return {
      name,
      payload: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function collectFocusedCampaignSource(env, articles, range, fn, extraBody = {}) {
  const payloads = await Promise.all(
    articles.map((article) =>
      fn({
        env,
        request: new Request("https://xway.internal/api/ai/focused-campaign-source", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            article,
            start: range.start,
            end: range.end,
            ...extraBody,
          }),
        }),
      }),
    ),
  );
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    articles: payloads.map((payload) => payload.article).filter(Boolean),
    payloads,
  };
}

async function collectFullRecommendationContext(env, report, articleItems, { forceRefresh = false, timeoutMs = DEFAULT_AI_DEEP_TIMEOUT_MS } = {}) {
  const articles = [...new Set((articleItems || []).map((item) => asString(item.article)).filter(Boolean))];
  const productRefs = productRefsForArticles(report, articleItems);
  if (!articles.length || !productRefs.length) {
    return null;
  }

  const refresh = Boolean(forceRefresh || String(env.PACHKA_REPORT_AI_AUTO_REFRESH || "1") !== "0");
  const sourceTimeoutMs = Math.max(5_000, timeoutMs);
  const turnoverStart = shiftedIsoDate(report.range.end, -2);
  const sources = await Promise.all([
    timedRecommendationSource("campaign_schedules", Math.min(sourceTimeoutMs, 12_000), () =>
      collectFocusedCampaignSource(env, articles, report.range, collectAiCampaignSchedules, {
        refresh,
      }),
    ),
    timedRecommendationSource("campaign_limits", Math.min(sourceTimeoutMs, 12_000), () =>
      collectFocusedCampaignSource(env, articles, report.range, collectAiCampaignLimits, {
        refresh,
      }),
    ),
    timedRecommendationSource("campaign_budget_history", Math.min(sourceTimeoutMs, 12_000), () =>
      collectFocusedCampaignSource(env, articles, report.range, collectAiCampaignBudgetHistory, {
        refresh,
      }),
    ),
    timedRecommendationSource("campaign_bid_history", Math.min(sourceTimeoutMs, 12_000), () =>
      collectFocusedCampaignSource(env, articles, report.range, collectAiCampaignBidHistory, {
        refresh,
      }),
    ),
    timedRecommendationSource("campaign_status_history", Math.min(sourceTimeoutMs, 12_000), () =>
      collectFocusedCampaignSource(env, articles, report.range, collectAiCampaignStatusHistory, {
        refresh,
        limit: 60,
      }),
    ),
    timedRecommendationSource("catalog_details", Math.min(sourceTimeoutMs, 18_000), () =>
      collectCatalogProductDetails(env, {
        productRefs,
        start: report.range.start,
        end: report.range.end,
        includeCampaignDetails: true,
        includeBestTime: true,
        forceRefresh: refresh,
      }),
    ),
    timedRecommendationSource("catalog_chart", Math.min(sourceTimeoutMs, 18_000), () =>
      collectCatalogChart(env, {
        productRefs,
        start: report.range.start,
        end: report.range.end,
        includeCampaignTypes: true,
        forceRefresh: refresh,
        deadlineMs: Math.min(sourceTimeoutMs, 18_000),
      }),
    ),
    timedRecommendationSource("turnover_3d", Math.min(sourceTimeoutMs, 12_000), () =>
      collectCatalog(env, {
        productRefs,
        start: turnoverStart,
        end: report.range.end,
        mode: "compact",
        includeAux: false,
        forceRefresh: refresh,
      }),
    ),
    timedRecommendationSource("issues_yesterday", Math.min(sourceTimeoutMs, 12_000), () =>
      collectCatalogIssues(env, {
        productRefs,
        start: report.range.end,
        end: report.range.end,
        forceRefresh: refresh,
        deadlineMs: Math.min(sourceTimeoutMs, 12_000),
      }),
    ),
  ]);
  const byName = Object.fromEntries(sources.map((source) => [source.name, source]));
  return {
    mode: "focused_product_refresh",
    auto_refresh: refresh,
    refreshed_at: new Date().toISOString(),
    articles,
    product_refs: productRefs,
    data_manifest: [
      "Focused campaign schedules: configured show-time slots from schedule-get",
      "Focused campaign limits: spend limits, spent amounts, remaining limits and budget rules",
      "Focused campaign budget history: budget top-ups and auto-deposit diagnostics",
      "Focused campaign bid history: bid changes by campaign",
      "Focused campaign status history: MP/status and pause logs with bounded row limit",
      "Catalog details: campaign states, spend/budget limits, schedules, campaign type totals and best order time",
      "Catalog chart: absolute daily metrics and campaign-type breakdown for report range",
      "Turnover 3d: fresh orders/revenue/spend/stock for the last 3 days ending on report end date",
      "Issues yesterday: campaign/product issue rows for report end date",
    ],
    sources: Object.fromEntries(sources.map((source) => [source.name, { available: Boolean(source.payload), error: source.error }])),
    campaign_schedules: byName.campaign_schedules?.payload || null,
    campaign_limits: byName.campaign_limits?.payload || null,
    campaign_budget_history: byName.campaign_budget_history?.payload || null,
    campaign_bid_history: byName.campaign_bid_history?.payload || null,
    campaign_status_history: byName.campaign_status_history?.payload || null,
    catalog_details: compactCatalogDetailsPayload(byName.catalog_details?.payload),
    catalog_chart: compactCatalogChartPayload(byName.catalog_chart?.payload),
    turnover_3d: compactTurnoverPayload(byName.turnover_3d?.payload),
    issues_yesterday: compactIssuesPayload(byName.issues_yesterday?.payload),
  };
}

function shouldUseAiRecommendations(env, options = {}) {
  if (options.skipAi || options.aiRecommendations === false) {
    return false;
  }
  if (String(env.PACHKA_REPORT_AI_RECOMMENDATIONS || "1") === "0") {
    return false;
  }
  return Boolean(asString(env.OPENAI_API_KEY));
}

async function buildAiReportRecommendations(env, report, recommendationContext, options = {}) {
  if (!shouldUseAiRecommendations(env, options)) {
    return {
      available: false,
      reason: asString(env.OPENAI_API_KEY) ? "disabled" : "OPENAI_API_KEY is not configured",
    };
  }

  const model = asString(env.PACHKA_REPORT_AI_MODEL) || DEFAULT_AI_MODEL;
  const timeoutMs = clampInteger(env.PACHKA_REPORT_AI_TIMEOUT_MS, DEFAULT_AI_TIMEOUT_MS, 5_000, 60_000);
  const deepTimeoutMs = clampInteger(env.PACHKA_REPORT_AI_DEEP_TIMEOUT_MS, DEFAULT_AI_DEEP_TIMEOUT_MS, 5_000, 60_000);
  const deepLimit = clampInteger(env.PACHKA_REPORT_AI_DEEP_LIMIT, DEFAULT_AI_DEEP_LIMIT, 0, 5);
  const fullRefreshLimit = clampInteger(env.PACHKA_REPORT_AI_FULL_REFRESH_LIMIT, DEFAULT_AI_FULL_REFRESH_LIMIT, 0, 8);
  const reportContext = buildAiReportContext(report, env, recommendationContext);
  const decisionInstructions = [
    analystProfileInstructions(),
    "",
    "Ты аналитик XWAY. Нужно подготовить осмысленные рекомендации для ежедневного markdown-отчета.",
    "Этап 1: сделай черновой диагноз и реши, достаточно ли компактного отчета или нужно углубиться в данные XWAY по кампаниям и кластерам.",
    "После твоего решения система сама догрузит по приоритетным SKU только нужные точечные методы: расписания, лимиты, пополнения бюджета, ставки, статусы, график, оборачиваемость и ошибки.",
    "Углубляйся только когда это реально нужно: высокий ДРР при заметном расходе, расход без заказов, активные РК без расхода, подозрение на ставки/поисковые фразы/лимиты/расписание или когда compact context не объясняет причину.",
    "Для каждого article дай черновую рекомендацию: 1 короткое предложение, максимум 260 символов.",
    "Поле recommendations обязательно: заполни его для каждого article из sections.top_drr, sections.fbo_stock_no_spend и sections.mpvibe_only_stock, даже если просишь углубление.",
    "Формат JSON: {\"need_deep_dive\":boolean,\"deep_dive_articles\":[{\"article\":\"...\",\"reason\":\"...\",\"focus\":[\"clusters\",\"bids\",\"campaigns\",\"daily\"]}],\"insights\":[\"...\"],\"recommendations\":{\"article\":\"короткая рекомендация\"},\"diagnostic_gaps\":[\"...\"]}.",
  ].join("\n");

  try {
    const decision = await callOpenAiJson(env, {
      model,
      timeoutMs,
      instructions: decisionInstructions,
      input: reportContext,
    });
    const requestedDeepDive = deepLimit > 0 ? normalizeDeepDiveArticles(decision, report, deepLimit) : [];
    const firstPass = normalizeAiAnalysis(decision, {
      report,
      model,
      usedDeepDive: false,
      deepDiveArticles: requestedDeepDive,
    });

    const fullContextArticles = String(env.PACHKA_REPORT_AI_FULL_REFRESH || "1") === "0"
      ? requestedDeepDive
      : buildFullRefreshArticleList(report, requestedDeepDive, Math.max(deepLimit, fullRefreshLimit));
    const fullContext = await collectFullRecommendationContext(env, report, fullContextArticles, {
      forceRefresh: Boolean(options.forceRefresh),
      timeoutMs: deepTimeoutMs,
    });
    const fullContextErrors = Object.entries(fullContext?.sources || {})
      .filter(([, source]) => source?.error)
      .map(([name, source]) => `${name}: ${source.error}`);

    const finalInstructions = [
      analystProfileInstructions(),
      "",
      "Ты редактор-аналитик XWAY. Этап 2: пересобери финальные рекомендации для markdown-отчета.",
      "Используй компактный отчет, черновик первого этапа и focused_product_refresh.",
      "focused_product_refresh собран сервером автоматически через точечные методы, без тяжелого полного product payload: расписания показов, лимиты, пополнения бюджета, ставки, статусы, график с РК-разбивкой, 3-дневная оборачиваемость и ошибки за вчера.",
      "Сделай самопроверку: убери шаблонные советы, противоречия источникам, неподтвержденные выводы и рекомендации без действия.",
      "Сам реши, какие выводы важны: ставки, лимиты, расписание, статус РК, карточка/цена/конверсия, остатки или маппинг MPVibe. Не упоминай кластеры, если focused_product_refresh или compact report не вернули кластерные данные.",
      "Доступность MPVibe бери только из report.sources.mpvibe.available.",
      "Не выдумывай данные. Если углубление не удалось, опирайся на компактные метрики и явно не ссылайся на кластеры.",
      "Не используй служебные слова deep_dive, full_refresh_context, focused_product_refresh, compact context, first_pass или fallback в пользовательском тексте.",
      "Каждая рекомендация: максимум 1-2 предложения, без воды. Формула: 'потому что [метрика/сравнение], сделать [конкретное действие]; не делать [ограничение], если оно важно'.",
      "Поле recommendations обязательно: заполни его для каждого article из отчета, не группируй без article-ключа.",
      "Формат JSON: {\"analysis_note\":\"...\",\"insights\":[\"...\"],\"recommendations\":{\"article\":\"финальная рекомендация\"},\"self_review\":[\"какие черновые выводы были исправлены\"]}.",
    ].join("\n");
    try {
      const finalPayload = await callOpenAiJson(env, {
        model,
        timeoutMs,
        instructions: finalInstructions,
        input: {
          report: reportContext,
          first_pass: decision,
          focused_product_refresh: fullContext,
          full_refresh_errors: fullContextErrors,
        },
      });
      return normalizeAiAnalysis(finalPayload, {
        report,
        model,
        usedDeepDive: Boolean(fullContext),
        deepDiveArticles: fullContextArticles,
        deepDiveError: fullContextErrors.join(" | ") || null,
        fullContext,
      });
    } catch (error) {
      return {
        ...firstPass,
        used_deep_dive: Boolean(fullContext),
        deep_dive_articles: fullContextArticles,
        deep_dive_error: fullContextErrors.join(" | ") || (error instanceof Error ? error.message : String(error)),
        full_context: publicFullContextSummary(fullContext),
      };
    }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function aiRecommendationFor(row, fallback, aiAnalysis) {
  const aiText = aiAnalysis?.recommendationsByArticle?.get(asString(row.article));
  return aiText || fallback;
}

function publicAiSummary(aiAnalysis) {
  if (!aiAnalysis) {
    return { available: false };
  }
  return {
    available: Boolean(aiAnalysis.available),
    model: aiAnalysis.model || null,
    used_deep_dive: Boolean(aiAnalysis.used_deep_dive),
    deep_dive_articles: aiAnalysis.deep_dive_articles || [],
    deep_dive_error: aiAnalysis.deep_dive_error || null,
    full_context: aiAnalysis.full_context || null,
    recommendations_count: aiAnalysis.recommendationsByArticle?.size || 0,
    insights_count: aiAnalysis.insights?.length || 0,
    reason: aiAnalysis.reason || null,
  };
}

function markdownCell(value) {
  return asString(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ") || "-";
}

function markdownTable(headers, rows) {
  if (!rows.length) {
    return "Нет строк.\n";
  }
  const headerLine = `| ${headers.map(markdownCell).join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  return `${[headerLine, separatorLine, ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`)].join("\n")}\n`;
}

function buildReportFileName(report) {
  return `xway-report-${report.range.end}.md`;
}

function buildPachkaMarkdown(report, env, context = null, aiAnalysis = null) {
  const prefix = asString(env.PACHKA_REPORT_MESSAGE_PREFIX) || "Ежедневный отчет XWAY";
  const stockThreshold = report.config?.stock_min_value ?? DEFAULT_STOCK_MIN_VALUE;
  const mpvibeAvailable = Boolean(report.sources?.mpvibe?.available);
  const recommendationContext = context || buildRecommendationContext(report.rows || [], stockThreshold);
  const fallbackInsights = buildReportInsights(report, recommendationContext);
  const aiInsights = aiAnalysis?.available ? [aiAnalysis.analysis_note, ...(aiAnalysis.insights || [])].filter(Boolean) : [];
  const insights = aiInsights.length ? aiInsights : fallbackInsights;
  const lines = [
    `# ${prefix}`,
    "",
    `Период: ${report.range.start} - ${report.range.end}`,
    `Сформировано: ${report.generated_at}`,
    "",
    "## Сводка",
    "",
    markdownTable(
      ["Метрика", "Значение"],
      [
        ["Расход", formatMoney(report.totals.spend)],
        ["SKU XWAY", formatNumber(report.totals.xway_rows)],
        ["MPVibe-only FBO", formatNumber(report.totals.mpvibe_only_rows)],
        [`Остатки > ${formatNumber(stockThreshold)} без расхода`, formatNumber(report.totals.zero_spend_stock_rows)],
        ["MPVibe", report.sources.mpvibe.available ? "доступен" : "недоступен"],
      ],
    ),
  ];
  if (report.warnings.length) {
    lines.push("");
    lines.push("## Предупреждения");
    lines.push("");
    report.warnings.forEach((warning) => lines.push(`- ${warning}`));
  }
  if (insights.length) {
    lines.push("");
    lines.push("## Общие выводы");
    lines.push("");
    insights.forEach((insight) => lines.push(`- ${insight}`));
  }
  lines.push("");
  lines.push("## Топ ДРР");
  lines.push("");
  lines.push(markdownTable(
    ["#", "Артикул", "Товар", "ДРР", "Расход", "FBO XWAY", "FBO MPVibe", "Рекомендация"],
    report.top_drr.map((row, index) => [
      String(index + 1),
      row.article,
      shortName(row.name, 90),
      formatPercent(row.drr),
      formatMoney(row.spend),
      formatNumber(row.stock_xway),
      formatNumber(row.stock_mpvibe),
      aiRecommendationFor(
        row,
        buildDrrRecommendation(row, stockThreshold, mpvibeAvailable, recommendationContext),
        aiAnalysis,
      ),
    ]),
  ));
  lines.push("");
  lines.push(`## FBO > ${formatNumber(stockThreshold)} без расхода`);
  lines.push("");
  lines.push(markdownTable(
    ["#", "Артикул", "Товар", "Кабинет", "FBO XWAY", "FBO MPVibe", "Расход", "Рекомендация"],
    report.stock_no_spend.map((row, index) => [
      String(index + 1),
      row.article,
      shortName(row.name, 90),
      row.shop_name,
      formatNumber(row.stock_xway),
      formatNumber(row.stock_mpvibe),
      formatMoney(row.spend),
      aiRecommendationFor(
        row,
        buildStockNoSpendRecommendation(row, stockThreshold, mpvibeAvailable, recommendationContext),
        aiAnalysis,
      ),
    ]),
  ));
  lines.push("");
  lines.push(`## Только MPVibe FBO > ${formatNumber(stockThreshold)}`);
  lines.push("");
  lines.push(markdownTable(
    ["#", "Артикул", "Товар", "FBO MPVibe", "Рекомендация"],
    report.mpvibe_only_stock.map((row, index) => [
      String(index + 1),
      row.article,
      shortName(row.name, 90),
      formatNumber(row.stock_mpvibe),
      aiRecommendationFor(row, buildMpvibeOnlyRecommendation(row, stockThreshold), aiAnalysis),
    ]),
  ));
  lines.push("");
  lines.push("---");
  lines.push(`Источник: ${asString(env.PACHKA_REPORT_DASHBOARD_URL) || "https://xway-bt4.pages.dev/drr-analytics"}`);
  return lines.join("\n");
}

function buildPachkaMessage(report) {
  return `Файл отчета XWAY за ${report.range.start} - ${report.range.end} приложен.`;
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
    stock_min_value: clampInteger(env.PACHKA_REPORT_STOCK_MIN_VALUE, DEFAULT_STOCK_MIN_VALUE, 0, 1_000_000),
    cron: asString(env.PACHKA_REPORT_CRON) || "0 6 * * *",
    ai_recommendations: String(env.PACHKA_REPORT_AI_RECOMMENDATIONS || "1") !== "0",
    ai_model: asString(env.PACHKA_REPORT_AI_MODEL) || DEFAULT_AI_MODEL,
    ai_reasoning_effort: normalizeChoice(env.PACHKA_REPORT_AI_REASONING_EFFORT, DEFAULT_AI_REASONING_EFFORT, ["none", "low", "medium", "high", "xhigh"]),
    ai_deep_limit: clampInteger(env.PACHKA_REPORT_AI_DEEP_LIMIT, DEFAULT_AI_DEEP_LIMIT, 0, 5),
    ai_full_refresh: String(env.PACHKA_REPORT_AI_FULL_REFRESH || "1") !== "0",
    ai_auto_refresh: String(env.PACHKA_REPORT_AI_AUTO_REFRESH || "1") !== "0",
    ai_full_refresh_limit: clampInteger(env.PACHKA_REPORT_AI_FULL_REFRESH_LIMIT, DEFAULT_AI_FULL_REFRESH_LIMIT, 0, 8),
  };
}

export async function buildPachkaReport(env, options = {}) {
  const range = buildReportRange(env, options);
  const config = pachkaReportConfig(env);
  const limit = clampInteger(options.limit ?? config.limit, config.limit, 1, 50);
  const stockMinValue = clampInteger(options.stockMinValue ?? config.stock_min_value, config.stock_min_value, 0, 1_000_000);
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
  const hasReportableStock = (row) => stockSignal(row) > stockMinValue;
  const stockNoSpend = topRows(rows, limit, (row) => hasReportableStock(row) && (row.spend ?? 0) === 0, stockSignal);
  const mpvibeOnlyStock = topRows(rows, limit, (row) => row.source === "mpvibe" && hasReportableStock(row), stockSignal);
  const recommendationContext = buildRecommendationContext(rows, stockMinValue);
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
      mpvibe_only_rows: rows.filter((row) => row.source === "mpvibe" && hasReportableStock(row)).length,
      spend: rows.reduce((sum, row) => sum + (row.spend ?? 0), 0),
      zero_spend_stock_rows: rows.filter((row) => hasReportableStock(row) && (row.spend ?? 0) === 0).length,
      stock_min_value: stockMinValue,
    },
    top_drr: topDrr,
    stock_no_spend: stockNoSpend,
    mpvibe_only_stock: mpvibeOnlyStock,
    config: { ...config, days: range.days, limit, stock_min_value: stockMinValue },
  };
  const aiAnalysis = await buildAiReportRecommendations(env, report, recommendationContext, options);
  const markdown = buildPachkaMarkdown(report, env, recommendationContext, aiAnalysis);
  const fileName = buildReportFileName(report);
  const fileSize = new TextEncoder().encode(markdown).length;
  return {
    ...report,
    ai_recommendations: publicAiSummary(aiAnalysis),
    message: buildPachkaMessage(report),
    markdown,
    file: {
      name: fileName,
      type: "text/markdown; charset=utf-8",
      size: fileSize,
    },
  };
}

async function pachkaJsonFetch(token, pathname, init = {}) {
  const response = await fetch(`${PACHKA_API_ORIGIN}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.headers || {}),
    },
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

function uploadParam(payload, key) {
  return payload?.[key] ?? payload?.[key.replace(/-/g, "_")];
}

async function uploadPachkaMarkdownFile(token, report) {
  const paramsPayload = await pachkaJsonFetch(token, "/uploads", { method: "POST" });
  const params = paramsPayload?.data || paramsPayload;
  const fileName = report.file.name;
  const keyTemplate = uploadParam(params, "key");
  const directUrl = uploadParam(params, "direct_url");
  if (!keyTemplate || !directUrl) {
    throw new Error("Pachka upload parameters are incomplete.");
  }
  const markdownBytes = new TextEncoder().encode(report.markdown);
  const form = new FormData();
  [
    "Content-Disposition",
    "acl",
    "policy",
    "x-amz-credential",
    "x-amz-algorithm",
    "x-amz-date",
    "x-amz-signature",
    "key",
  ].forEach((field) => {
    const value = uploadParam(params, field);
    if (value !== null && value !== undefined) {
      form.append(field, String(value));
    }
  });
  form.append("file", new Blob([markdownBytes], { type: report.file.type }), fileName);

  const uploadResponse = await fetch(directUrl, {
    method: "POST",
    body: form,
  });
  const uploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    throw new Error(`Pachka file upload failed (${uploadResponse.status}): ${uploadText.slice(0, 240) || uploadResponse.statusText}`);
  }

  return {
    key: String(keyTemplate).replace("${filename}", fileName),
    name: fileName,
    file_type: "file",
    size: markdownBytes.length,
  };
}

export async function sendPachkaMessage(env, content, files = []) {
  const token = asString(env.PACHKA_ACCESS_TOKEN);
  const entityId = asString(env.PACHKA_ENTITY_ID || env.PACHKA_CHAT_ID);
  const entityType = asString(env.PACHKA_ENTITY_TYPE) || "discussion";
  if (!token || !entityId) {
    throw new Error("Pachka is not configured. Set PACHKA_ACCESS_TOKEN and PACHKA_ENTITY_ID.");
  }
  return pachkaJsonFetch(token, "/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      message: {
        entity_type: entityType,
        entity_id: Number(entityId),
        content,
        ...(files.length ? { files } : {}),
        link_preview: false,
      },
    }),
  });
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
  const token = asString(env.PACHKA_ACCESS_TOKEN);
  if (!token) {
    throw new Error("Pachka is not configured. Set PACHKA_ACCESS_TOKEN and PACHKA_ENTITY_ID.");
  }
  const file = await uploadPachkaMarkdownFile(token, report);
  const pachka = await sendPachkaMessage(env, report.message, [file]);
  return {
    ok: true,
    sent_at: new Date().toISOString(),
    report,
    file,
    pachka,
  };
}
