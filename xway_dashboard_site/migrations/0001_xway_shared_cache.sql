CREATE TABLE IF NOT EXISTS xway_shared_cache (
  namespace TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (namespace, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_xway_shared_cache_expires_at
  ON xway_shared_cache (expires_at);

CREATE INDEX IF NOT EXISTS idx_xway_shared_cache_namespace_created_at
  ON xway_shared_cache (namespace, created_at);
