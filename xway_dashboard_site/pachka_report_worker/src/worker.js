const DEFAULT_REPORT_URL = "https://xway-bt4.pages.dev/api/pachka-report/send";

function responseJson(payload, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function timingSafeEqual(left, right) {
  const leftValue = asString(left);
  const rightValue = asString(right);
  if (!leftValue || !rightValue || leftValue.length !== rightValue.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < leftValue.length; index += 1) {
    diff |= leftValue.charCodeAt(index) ^ rightValue.charCodeAt(index);
  }
  return diff === 0;
}

async function triggerPachkaReport(env, cron = "manual") {
  const reportUrl = asString(env.XWAY_PACHKA_REPORT_URL) || DEFAULT_REPORT_URL;
  const secret = asString(env.PACHKA_REPORT_SECRET);
  if (!secret) {
    throw new Error("PACHKA_REPORT_SECRET is not configured.");
  }
  const response = await fetch(reportUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pachka-report-secret": secret,
      "x-xway-report-cron": cron,
    },
    body: "{}",
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(`XWAY Pachka report failed (${response.status}): ${text.slice(0, 240) || response.statusText}`);
  }
  return payload;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return responseJson({ ok: true, cron: "0 6 * * *", target_configured: Boolean(asString(env.XWAY_PACHKA_REPORT_URL)), secret_configured: Boolean(asString(env.PACHKA_REPORT_SECRET)) });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      if (!timingSafeEqual(request.headers.get("x-pachka-report-secret"), env.PACHKA_REPORT_SECRET)) {
        return responseJson({ ok: false, error: "Invalid Pachka report secret." }, { status: 401 });
      }
      try {
        return responseJson(await triggerPachkaReport(env, "manual"));
      } catch (error) {
        return responseJson({ ok: false, error: error instanceof Error ? error.message : "Pachka report cron failed." }, { status: 502 });
      }
    }
    return responseJson({ ok: false, error: "Not found." }, { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(triggerPachkaReport(env, controller.cron));
  },
};
