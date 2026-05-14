function parseFeedbackRoots(env) {
  const raw = String(env.WB_FEEDBACK_ROOTS_JSON || "").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parseDate(value) {
  const text = asString(value);
  const parsed = text ? new Date(text) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function addDays(date, amount) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function feedbackDate(row) {
  return parseDate(row?.createdDate || row?.created_date || row?.date || row?.created);
}

function normalizeFeedbacks(payload) {
  if (Array.isArray(payload?.feedbacks)) {
    return payload.feedbacks;
  }
  if (Array.isArray(payload?.data?.feedbacks)) {
    return payload.data.feedbacks;
  }
  if (Array.isArray(payload?.feedbacksHtml)) {
    return payload.feedbacksHtml;
  }
  return [];
}

function ratingValue(row) {
  const numeric = Number(row?.productValuation ?? row?.valuation ?? row?.rating ?? row?.grade);
  return Number.isFinite(numeric) ? numeric : null;
}

function textValue(row) {
  return asString(row?.text || row?.pros || row?.cons || row?.comment).slice(0, 700);
}

function summarizeRecentFeedbacks(rows, end, days) {
  const endDate = parseDate(end) || new Date();
  const startDate = addDays(endDate, -(days - 1));
  const recent = rows.filter((row) => {
    const date = feedbackDate(row);
    return date && date.getTime() >= startDate.getTime() && date.getTime() <= endDate.getTime() + 86400000 - 1;
  });
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let ratingSum = 0;
  let ratingCount = 0;
  for (const row of recent) {
    const rating = ratingValue(row);
    if (rating !== null) {
      const key = Math.max(1, Math.min(5, Math.round(rating)));
      distribution[key] += 1;
      ratingSum += rating;
      ratingCount += 1;
    }
  }
  const negativeSamples = recent
    .filter((row) => {
      const rating = ratingValue(row);
      return rating !== null && rating <= 3 && textValue(row);
    })
    .slice(0, 12)
    .map((row) => ({
      date: feedbackDate(row)?.toISOString().slice(0, 10) || null,
      rating: ratingValue(row),
      text: textValue(row),
    }));

  return {
    days,
    count: recent.length,
    average_rating: ratingCount ? ratingSum / ratingCount : null,
    low_rating_count: distribution[1] + distribution[2] + distribution[3],
    distribution,
    negative_samples: negativeSamples,
  };
}

export async function collectWbPublicFeedbacks(env, { article, end, days = 30 } = {}) {
  const roots = parseFeedbackRoots(env);
  const rootId = asString(roots[asString(article)]);
  if (!rootId) {
    return {
      available: false,
      error: "WB feedback root id is not configured for this article. Set WB_FEEDBACK_ROOTS_JSON, for example {\"282727300\":\"606943940\"}.",
    };
  }

  const url = `https://feedbacks1.wb.ru/feedbacks/v2/${encodeURIComponent(rootId)}`;
  const response = await fetch(url, { headers: { accept: "application/json, text/plain, */*" } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`WB feedback request failed (${response.status}): ${text.slice(0, 240) || response.statusText}`);
  }
  const payload = text ? JSON.parse(text) : {};
  const rows = normalizeFeedbacks(payload);
  return {
    available: true,
    article: asString(article),
    root_id: rootId,
    lifetime: {
      valuation: payload.valuation ?? payload?.data?.valuation ?? null,
      feedback_count: payload.feedbackCount ?? payload?.data?.feedbackCount ?? rows.length,
      feedback_count_with_text: payload.feedbackCountWithText ?? payload?.data?.feedbackCountWithText ?? null,
    },
    recent: summarizeRecentFeedbacks(rows, end, days),
  };
}
