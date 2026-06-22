import { errorResponse } from "./utils.js";

export const ACCESS_PERMISSIONS = Object.freeze({
  READ_REPORTS: "read_reports",
  RUN_ANALYSIS: "run_analysis",
  SEND_PACHKA: "send_pachka",
});

export const ACCESS_ROLES = Object.freeze({
  VIEWER: "viewer",
  ANALYST: "analyst",
  OPERATOR: "operator",
});

const ROLE_PERMISSIONS = Object.freeze({
  [ACCESS_ROLES.VIEWER]: [ACCESS_PERMISSIONS.READ_REPORTS],
  [ACCESS_ROLES.ANALYST]: [ACCESS_PERMISSIONS.READ_REPORTS, ACCESS_PERMISSIONS.RUN_ANALYSIS],
  [ACCESS_ROLES.OPERATOR]: [ACCESS_PERMISSIONS.SEND_PACHKA],
});

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

function bearerTokenFromHeader(value) {
  const match = asString(value).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function accessTokenFromRequest(request) {
  const headers = request?.headers;
  if (!headers) {
    return "";
  }
  return (
    bearerTokenFromHeader(headers.get("authorization")) ||
    asString(headers.get("x-xway-access-token")) ||
    asString(headers.get("x-xway-ai-key")) ||
    asString(headers.get("x-xway-api-key"))
  );
}

export function hasAccessTokenHeader(request) {
  return Boolean(accessTokenFromRequest(request));
}

function normalizeRole(role) {
  const value = asString(role).toLowerCase();
  if (value === "viewer" || value === "reader" || value === "read" || value === "просмотр") {
    return ACCESS_ROLES.VIEWER;
  }
  if (value === "analyst" || value === "analysis" || value === "analytics" || value === "анализ" || value === "аналитик") {
    return ACCESS_ROLES.ANALYST;
  }
  if (value === "operator" || value === "pachka_operator" || value === "send_pachka" || value === "оператор") {
    return ACCESS_ROLES.OPERATOR;
  }
  return "";
}

function splitTokens(value) {
  return asString(value)
    .split(/[,\n]/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function addToken(entries, token, role, name = "") {
  const normalizedRole = normalizeRole(role);
  const normalizedToken = bearerTokenFromHeader(token) || asString(token);
  if (!normalizedToken || !normalizedRole) {
    return;
  }
  entries.push({
    token: normalizedToken,
    role: normalizedRole,
    name: asString(name) || normalizedRole,
  });
}

function addRoleTokens(entries, value, role, namePrefix) {
  splitTokens(value).forEach((token, index) => addToken(entries, token, role, `${namePrefix}${index ? `-${index + 1}` : ""}`));
}

function addProjectToken(entries, value) {
  splitTokens(value).forEach((token, index) => {
    const name = `xway-token${index ? `-${index + 1}` : ""}`;
    addToken(entries, token, ACCESS_ROLES.ANALYST, name);
    addToken(entries, token, ACCESS_ROLES.OPERATOR, name);
  });
}

function addJsonTokenConfig(entries, rawConfig) {
  const raw = asString(rawConfig);
  if (!raw) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  if (Array.isArray(payload)) {
    payload.forEach((item, index) => {
      if (typeof item === "string") {
        return;
      }
      const roles = Array.isArray(item?.roles) ? item.roles : [item?.role];
      roles.forEach((role) => addToken(entries, item?.token || item?.value || item?.secret, role, item?.name || `json-token-${index + 1}`));
    });
    return;
  }

  if (Array.isArray(payload?.tokens)) {
    addJsonTokenConfig(entries, JSON.stringify(payload.tokens));
    return;
  }

  for (const [key, value] of Object.entries(payload || {})) {
    const keyRole = normalizeRole(key);
    if (keyRole) {
      if (Array.isArray(value)) {
        value.forEach((token, index) => addToken(entries, token, keyRole, `${keyRole}-${index + 1}`));
      } else {
        addRoleTokens(entries, value, keyRole, keyRole);
      }
      continue;
    }

    if (typeof value === "string") {
      addToken(entries, key, value, key);
    } else if (value && typeof value === "object") {
      const roles = Array.isArray(value.roles) ? value.roles : [value.role];
      roles.forEach((role) => addToken(entries, key, role, value.name || key));
    }
  }
}

export function configuredAccessTokens(env) {
  const entries = [];
  addProjectToken(entries, env.XWAY_TOKEN);
  addRoleTokens(entries, env.XWAY_VIEWER_TOKEN || env.XWAY_VIEWER_TOKENS, ACCESS_ROLES.VIEWER, "viewer");
  addRoleTokens(entries, env.XWAY_ANALYST_TOKEN || env.XWAY_ANALYST_TOKENS, ACCESS_ROLES.ANALYST, "analyst");
  addRoleTokens(entries, env.XWAY_OPERATOR_TOKEN || env.XWAY_OPERATOR_TOKENS, ACCESS_ROLES.OPERATOR, "operator");
  addJsonTokenConfig(entries, env.XWAY_ACCESS_TOKENS_JSON);

  // Backward compatibility for already configured ChatGPT Actions / Codex API access.
  addToken(entries, env.XWAY_AI_API_KEY, ACCESS_ROLES.ANALYST, "legacy-ai-api-key");
  return entries;
}

export function accessRoleSummary(env) {
  const roles = {
    [ACCESS_ROLES.VIEWER]: false,
    [ACCESS_ROLES.ANALYST]: false,
    [ACCESS_ROLES.OPERATOR]: false,
  };
  configuredAccessTokens(env).forEach((entry) => {
    roles[entry.role] = true;
  });
  return {
    roles,
    permissions: ROLE_PERMISSIONS,
    xway_token_configured: Boolean(asString(env.XWAY_TOKEN)),
    legacy_ai_api_key_as_analyst: Boolean(asString(env.XWAY_AI_API_KEY)),
  };
}

export function resolveAccessPrincipal(context) {
  const provided = accessTokenFromRequest(context.request);
  if (!provided) {
    return {
      authenticated: false,
      role: null,
      permissions: [],
      name: null,
    };
  }

  const matches = configuredAccessTokens(context.env).filter((entry) => timingSafeEqual(provided, entry.token));
  if (!matches.length) {
    return {
      authenticated: false,
      role: null,
      permissions: [],
      name: null,
    };
  }

  const roles = [...new Set(matches.map((entry) => entry.role))];
  const permissions = [...new Set(matches.flatMap((entry) => ROLE_PERMISSIONS[entry.role] || []))];
  return {
    authenticated: true,
    role: roles.join("+"),
    permissions,
    name: matches.map((entry) => entry.name).filter(Boolean).join("+") || roles.join("+"),
  };
}

export function requireAccessPermission(context, permission, { errorPrefix = "XWAY API" } = {}) {
  const configured = configuredAccessTokens(context.env);
  if (!configured.length) {
    return {
      ok: false,
      principal: null,
      response: errorResponse(500, "XWAY role access is not configured. Set XWAY_TOKEN."),
    };
  }

  const principal = resolveAccessPrincipal(context);
  if (!principal.authenticated) {
    return {
      ok: false,
      principal,
      response: errorResponse(401, `Unauthorized ${errorPrefix} request.`),
    };
  }

  if (!principal.permissions.includes(permission)) {
    return {
      ok: false,
      principal,
      response: errorResponse(403, `Role ${principal.role} does not have ${permission} permission.`),
    };
  }

  return { ok: true, principal, response: null };
}
