const SHARED_CACHE_TABLE = "xway_shared_cache";
const DEFAULT_MAX_VALUE_BYTES = 500000;
const D1_FAILURE_BACKOFF_MS = 60000;
const CHUNK_MARKER = "__xway_chunked_v1";

let d1UnavailableUntil = 0;

function byteLength(value) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
}

function chunkCacheKey(key, index) {
  return `${key}::${CHUNK_MARKER}:${index}`;
}

function isChunkedPayload(payload) {
  return Boolean(payload && typeof payload === "object" && payload[CHUNK_MARKER] === true);
}

function splitByByteLength(value, maxBytes) {
  if (maxBytes === null || byteLength(value) <= maxBytes) {
    return [value];
  }

  const chunks = [];
  let offset = 0;
  while (offset < value.length) {
    let low = 1;
    let high = value.length - offset;
    let best = 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = value.slice(offset, offset + mid);
      if (byteLength(candidate) <= maxBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    chunks.push(value.slice(offset, offset + best));
    offset += best;
  }
  return chunks;
}

async function readChunkedValue(db, namespace, key, manifest, now) {
  const chunkCount = Number(manifest.chunk_count || 0);
  if (!Number.isFinite(chunkCount) || chunkCount <= 0 || chunkCount > 10000) {
    return null;
  }

  const chunks = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const row = await db
      .prepare(
        `SELECT value_json
         FROM ${SHARED_CACHE_TABLE}
         WHERE namespace = ? AND cache_key = ? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .bind(String(namespace), chunkCacheKey(key, index), now)
      .first();
    if (!row?.value_json) {
      return null;
    }
    chunks.push(row.value_json);
  }

  return unwrapValue(JSON.parse(chunks.join("")));
}

async function deleteSharedCacheChunks(db, namespace, key) {
  const existing = await db
    .prepare(`SELECT value_json FROM ${SHARED_CACHE_TABLE} WHERE namespace = ? AND cache_key = ?`)
    .bind(String(namespace), String(key))
    .first();
  if (!existing?.value_json) {
    return;
  }

  let manifest = null;
  try {
    manifest = JSON.parse(existing.value_json);
  } catch {
    return;
  }
  if (!isChunkedPayload(manifest)) {
    return;
  }

  const chunkCount = Number(manifest.chunk_count || 0);
  if (!Number.isFinite(chunkCount) || chunkCount <= 0 || chunkCount > 10000) {
    return;
  }

  for (let index = 0; index < chunkCount; index += 1) {
    await db
      .prepare(`DELETE FROM ${SHARED_CACHE_TABLE} WHERE namespace = ? AND cache_key = ?`)
      .bind(String(namespace), chunkCacheKey(key, index))
      .run();
  }
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

    const payload = JSON.parse(row.value_json);
    if (isChunkedPayload(payload)) {
      return readChunkedValue(db, namespace, key, payload, now);
    }
    return unwrapValue(payload);
  } catch (error) {
    rememberD1Failure(error);
    return null;
  }
}

export async function readSharedCacheMany(env, namespace, keys, { maxAgeMs = null } = {}) {
  const db = sharedD1CacheBinding(env);
  if (!db || shouldSkipD1()) {
    return new Map();
  }

  const uniqueKeys = [...new Set((keys || []).map((key) => String(key || "").trim()).filter(Boolean))];
  const valuesByKey = new Map();
  if (!uniqueKeys.length) {
    return valuesByKey;
  }

  try {
    const now = Date.now();
    const chunkedKeys = [];
    for (let offset = 0; offset < uniqueKeys.length; offset += 80) {
      const keyChunk = uniqueKeys.slice(offset, offset + 80);
      const placeholders = keyChunk.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `SELECT cache_key, value_json, created_at
           FROM ${SHARED_CACHE_TABLE}
           WHERE namespace = ? AND cache_key IN (${placeholders}) AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .bind(String(namespace), ...keyChunk, now)
        .all();

      for (const row of result?.results || []) {
        if (!row?.cache_key || !row?.value_json) {
          continue;
        }
        const createdAt = Number(row.created_at || 0);
        if (maxAgeMs !== null && Number.isFinite(createdAt) && now - createdAt > maxAgeMs) {
          continue;
        }
        const payload = JSON.parse(row.value_json);
        if (isChunkedPayload(payload)) {
          chunkedKeys.push(String(row.cache_key));
          continue;
        }
        valuesByKey.set(String(row.cache_key), unwrapValue(payload));
      }
    }

    for (const key of chunkedKeys) {
      const value = await readSharedCache(env, namespace, key, { maxAgeMs });
      if (value !== null && value !== undefined) {
        valuesByKey.set(key, value);
      }
    }
    return valuesByKey;
  } catch (error) {
    rememberD1Failure(error);
    return new Map();
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
    const now = Date.now();
    const expiresAt = ttlMs === null ? null : now + Math.max(0, Number(ttlMs) || 0);
    await deleteSharedCacheChunks(db, namespace, key);

    if (maxBytes !== null && sizeBytes > maxBytes) {
      const chunks = splitByByteLength(valueJson, maxBytes);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
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
          .bind(String(namespace), chunkCacheKey(key, index), chunk, byteLength(chunk), now, expiresAt)
          .run();
      }

      const manifestJson = JSON.stringify({
        [CHUNK_MARKER]: true,
        chunk_count: chunks.length,
        total_size_bytes: sizeBytes,
        created_at: new Date(now).toISOString(),
      });
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
        .bind(String(namespace), String(key), manifestJson, sizeBytes, now, expiresAt)
        .run();
      return true;
    }

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
    await deleteSharedCacheChunks(db, namespace, key);
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
