function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function uniqueArticles(rawArticles) {
  const seen = new Set();
  const articles = [];
  for (const rawArticle of rawArticles || []) {
    const article = asString(rawArticle);
    if (!article || seen.has(article)) {
      continue;
    }
    seen.add(article);
    articles.push(article);
  }
  return articles;
}

function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function resolvePriceWithSpp(product) {
  const prices = [];
  for (const size of Array.isArray(product?.sizes) ? product.sizes : []) {
    const price = asNumber(size?.price?.product);
    if (price !== null && price > 0) {
      prices.push(price / 100);
    }
  }
  if (!prices.length) {
    return null;
  }
  return Math.min(...prices);
}

function normalizeWbProduct(product) {
  const article = asString(product?.id);
  if (!article) {
    return null;
  }
  return {
    article,
    root: asNumber(product?.root),
    feedbacks: asNumber(product?.feedbacks),
    nm_feedbacks: asNumber(product?.nmFeedbacks),
    rating: asNumber(product?.nmReviewRating ?? product?.reviewRating),
    feedback_points: asNumber(product?.feedbackPoints),
    price_spp: resolvePriceWithSpp(product),
    total_quantity: asNumber(product?.totalQuantity),
  };
}

export async function collectWbCards({ articles } = {}) {
  const requestedArticles = uniqueArticles(articles);
  if (!requestedArticles.length) {
    return {
      ok: true,
      generated_at: new Date().toISOString(),
      requested_articles: [],
      rows: [],
      errors: [],
    };
  }

  const rows = [];
  const errors = [];
  for (const chunk of chunkItems(requestedArticles, 80)) {
    const url = new URL("https://card.wb.ru/cards/v4/detail");
    url.searchParams.set("appType", "1");
    url.searchParams.set("curr", "rub");
    url.searchParams.set("dest", "-1257786");
    url.searchParams.set("spp", "30");
    url.searchParams.set("ab_testing", "false");
    url.searchParams.set("nm", chunk.join(";"));

    try {
      const response = await fetch(url.toString(), {
        headers: {
          accept: "application/json, text/plain, */*",
          "user-agent": "Mozilla/5.0",
        },
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text.slice(0, 260) || response.statusText);
      }
      const payload = text ? JSON.parse(text) : {};
      for (const product of Array.isArray(payload?.products) ? payload.products : []) {
        const row = normalizeWbProduct(product);
        if (row) {
          rows.push(row);
        }
      }
    } catch (error) {
      errors.push({
        articles: chunk,
        error: error instanceof Error ? error.message : "WB cards request failed.",
      });
    }
  }

  const found = new Set(rows.map((row) => row.article));
  for (const article of requestedArticles) {
    if (!found.has(article)) {
      errors.push({ articles: [article], error: "WB card was not returned." });
    }
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    requested_articles: requestedArticles,
    rows,
    errors,
  };
}
