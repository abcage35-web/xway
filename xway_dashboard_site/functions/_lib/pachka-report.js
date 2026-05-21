import { applyCatalogArticleSnapshots } from "./catalog-article-snapshots.js";
import { collectCatalog } from "./catalog.js";
import { collectMpvibeStocks } from "./ai/mpvibe-client.js";

const PACHKA_API_ORIGIN = "https://api.pachca.com/api/shared/v1";
const DEFAULT_REPORT_DAYS = 3;
const DEFAULT_REPORT_LIMIT = 12;
const DEFAULT_STOCK_MIN_VALUE = 100;

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

function buildPachkaMarkdown(report, env, context = null) {
  const prefix = asString(env.PACHKA_REPORT_MESSAGE_PREFIX) || "Ежедневный отчет XWAY";
  const stockThreshold = report.config?.stock_min_value ?? DEFAULT_STOCK_MIN_VALUE;
  const mpvibeAvailable = Boolean(report.sources?.mpvibe?.available);
  const recommendationContext = context || buildRecommendationContext(report.rows || [], stockThreshold);
  const insights = buildReportInsights(report, recommendationContext);
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
      buildDrrRecommendation(row, stockThreshold, mpvibeAvailable, recommendationContext),
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
      buildStockNoSpendRecommendation(row, stockThreshold, mpvibeAvailable, recommendationContext),
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
      buildMpvibeOnlyRecommendation(row, stockThreshold),
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
  const markdown = buildPachkaMarkdown(report, env, recommendationContext);
  const fileName = buildReportFileName(report);
  const fileSize = new TextEncoder().encode(markdown).length;
  return {
    ...report,
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
