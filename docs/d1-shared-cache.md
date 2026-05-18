# D1 shared cache

This project can keep loaded XWAY/API data in a shared Cloudflare D1 cache so the next user does not have to reload the same payload from XWAY again.

## Binding

Create a D1 database and bind it to the Pages project with this exact binding name:

```text
XWAY_SHARED_CACHE_DB
```

Recommended database name:

```text
xway-shared-cache
```

Set a stable cache namespace for production:

```text
XWAY_CACHE_NAMESPACE=xway-production
```

This prevents D1 keys from changing after every Pages deployment.

If you configure bindings through `wrangler.jsonc`, add the `database_id` returned by Cloudflare:

```jsonc
"d1_databases": [
  {
    "binding": "XWAY_SHARED_CACHE_DB",
    "database_name": "xway-shared-cache",
    "database_id": "<D1_DATABASE_ID>"
  }
]
```

If you configure bindings in the Cloudflare dashboard, use:

`Workers & Pages -> xway-dashboard-site -> Settings -> Functions -> D1 database bindings`

## Migration

Apply the migration from the site folder:

```powershell
cd xway_dashboard_site
npx.cmd wrangler d1 migrations apply xway-shared-cache --remote
```

The migration file is:

```text
xway_dashboard_site/migrations/0001_xway_shared_cache.sql
```

## How it works

- Browser IndexedDB remains the fastest per-user cache.
- D1 stores shared server-side API responses for catalog endpoints when the payload is not too large.
- D1 also stores granular XWAY source responses: shops, cabinet listings, product stats, `stata`, campaign daily slices and campaign schedules.
- `refresh=1` / `force_refresh=1` bypasses cache reads and overwrites the shared cache with fresh data.
- If the D1 binding or migration is absent, the app falls back to the previous behavior: memory cache and `XWAY_AI_CACHE` KV where configured.

Check status through:

```text
/api/health
```

Expected field:

```json
{
  "shared_cache": {
    "d1": true
  }
}
```
