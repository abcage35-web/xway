const SHARED_CACHE_TABLE = "xway_shared_cache";
const DEFAULT_MAX_VALUE_BYTES = 1800000;
const D1_FAILURE_BACKOFF_MS = 60000;

let d1UnavailableUntil = 0;

function byteLength(value) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
}

function shouldSkipD1() {
  return Date.now() < d1UnavailableUntil;
}

function rememberD1Failure(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/no such table|SQLITE_ERROR|D1_ERROR|database/i.test(message)) {
    d1UnavailableUntil = Date.now() + D1_FAILURE_BACKOFF_MS;
  }
}

export function sharedD1CacheBinding(env) {
  const db = env?.XWAY_SHARED_CACHE_DB || env?.XWAY_D1 || env?.DB;
  return db && typeof db.prepare === "function" ? db : null;
}

export function hasSharedD1Cache(env) {
  return Boolean(sharedD1CacheBinding(env));
}

function wrapValue(value) {
  return {
    created_at: new Date().toISOString(),
    value,
  };
}

function unwrapValue(payload) {
  if (!payload || typeof payload !== "object") {
    return payload ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "value")) {
    return payload.value;
  }
  return payload;
}

export async function readSharedCache(env, namespace, key, { maxAgeMs = null } = {}) {
  const db = sharedD1CacheBinding(env);
  if (!db || shouldSkipD1()) {
    return null;
  }

  try {
    const now = Date.now();
    const row = await db
      .prepare(
        `SELECT value_json, created_at, expires_at
         FROM ${SHARED_CACHE_TABLE}
         WHERE namespace = ? AND cache_key = ? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .bind(String(namespace), String(key), now)
      .first();

    if (!row?.value_json) {
      return null;
    }

    const createdAt = Number(row.created_at || 0);
    if (maxAgeMs !== null && Number.isFinite(createdAt) && now - createdAt > maxAgeMs) {
      return null;
    }

    return unwrapValue(JSON.parse(row.value_json));
  } catch (error) {
    rememberD1Failure(error);
    return null;
  }
}

export async function writeSharedCache(env, namespace, key, value, { ttlMs = null, maxBytes = DEFAULT_MAX_VALUE_BYTES } = {}) {
  const db = sharedD1CacheBinding(env);
  if (!db || shouldSkipD1()) {
    return false;
  }

  try {
    const valueJson = JSON.stringify(wrapValue(value));
    const sizeBytes = byteLength(valueJson);
    if (maxBytes !== null && sizeBytes > maxBytes) {
      return false;
    }

    const now = Date.now();
    const expiresAt = ttlMs === null ? null : now + Math.max(0, Number(ttlMs) || 0);
    await db
      .prepare(
        `INSERT INTO ${SHARED_CACHE_TABLE} (namespace, cache_key, value_json, size_bytes, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, cache_key) DO UPDATE SET
           value_json = excluded.value_json,
           size_bytes = excluded.size_bytes,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .bind(String(namespace), String(key), valueJson, sizeBytes, now, expiresAt)
      .run();
    return true;
  } catch (error) {
    rememberD1Failure(error);
    return false;
  }
}

export async function deleteSharedCache(env, namespace, key) {
  const db = sharedD1CacheBinding(env);
  if (!db || shouldSkipD1()) {
    return false;
  }

  try {
    await db
      .prepare(`DELETE FROM ${SHARED_CACHE_TABLE} WHERE namespace = ? AND cache_key = ?`)
      .bind(String(namespace), String(key))
      .run();
    return true;
  } catch (error) {
    rememberD1Failure(error);
    return false;
  }
}
