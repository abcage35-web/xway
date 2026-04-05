import { XwayApiClient } from "./xway-client.js";

function parseInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIsoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function filterDatedMapping(rows, start = null, end = null) {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  const filtered = {};
  for (const [day, payload] of Object.entries(rows || {})) {
    const parsedDay = parseIsoDate(day);
    if (startDate && parsedDay && parsedDay.getTime() < startDate.getTime()) {
      continue;
    }
    if (endDate && parsedDay && parsedDay.getTime() > endDate.getTime()) {
      continue;
    }
    filtered[day] = payload;
  }
  return filtered;
}

async function safeCall(fn, defaultValue) {
  try {
    return [await fn(), null];
  } catch (error) {
    return [defaultValue, error instanceof Error ? error.message : String(error)];
  }
}

export async function collectClusterDetail(
  env,
  {
    shopId,
    productId,
    campaignId,
    normqueryId,
    start = null,
    end = null,
  } = {},
) {
  const normalizedShopId = parseInteger(shopId);
  const normalizedProductId = parseInteger(productId);
  const normalizedCampaignId = parseInteger(campaignId);
  const normalizedNormqueryId = parseInteger(normqueryId);

  if (
    normalizedShopId === null ||
    normalizedProductId === null ||
    normalizedCampaignId === null ||
    normalizedNormqueryId === null
  ) {
    throw new Error("shop_id, product_id, campaign_id и normquery_id обязательны");
  }

  const client = new XwayApiClient(env, { start, end });
  const [historyPayload, historyError] = await safeCall(
    () =>
      client.campaignNormqueryHistory(
        normalizedShopId,
        normalizedProductId,
        normalizedCampaignId,
        normalizedNormqueryId,
      ),
    [],
  );
  const [bidPayload, bidError] = await safeCall(
    () =>
      client.campaignNormqueryBidHistory(
        normalizedShopId,
        normalizedProductId,
        normalizedCampaignId,
        normalizedNormqueryId,
      ),
    [],
  );
  const [additionalPayload, additionalError] = await safeCall(
    () =>
      client.campaignAdditionalStatsForNormqueries(
        normalizedShopId,
        normalizedProductId,
        normalizedCampaignId,
        [normalizedNormqueryId],
        client.range.current_start,
        client.range.current_end,
      ),
    {},
  );
  const [positionsPayload, positionsError] = await safeCall(
    () => client.productNormqueriesPositions(normalizedShopId, normalizedProductId, [normalizedNormqueryId]),
    {},
  );

  return {
    ok: true,
    range: client.range,
    history: historyPayload || [],
    bid_history: bidPayload || [],
    daily: filterDatedMapping(
      additionalPayload?.[String(normalizedNormqueryId)] || {},
      client.range.current_start,
      client.range.current_end,
    ),
    position: positionsPayload?.[String(normalizedNormqueryId)] ?? null,
    errors: Object.fromEntries(
      Object.entries({
        history: historyError,
        bid_history: bidError,
        daily: additionalError,
        position: positionsError,
      }).filter(([, value]) => Boolean(value)),
    ),
  };
}
