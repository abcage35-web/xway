# xway

## Cloudflare Pages через GitHub

Этот репозиторий сейчас делится на две части:

- `xway_dashboard_site/` — Vite/React фронт, его можно деплоить в Cloudflare Pages.
- `xway_dashboard_server.py` и `xway_api.py` — Python backend. Cloudflare Pages его не запускает, поэтому API нужно держать на отдельном хосте или переносить на Workers отдельно.

Что уже подготовлено в репозитории:

- React SPA использует корневой `index.html`, поэтому dev-сервер и Cloudflare Pages больше не могут случайно открыть старый статический UI;
- билд фронта создаёт `dist/index.html`, чтобы Cloudflare Pages мог отдавать SPA как обычный entrypoint;
- в `xway_dashboard_site/functions/api/[[path]].js` добавлен гибридный Pages backend;
- нативно в Cloudflare уже работают `/api/health`, `/api/catalog`, `/api/catalog-chart`, `/api/products` и `/api/cluster-detail`;
- внешний `API_ORIGIN` теперь нужен только если ты хочешь оставить запасной proxy на не перенесённые маршруты;
- фронт продолжает ходить на `/api/*`, а на Cloudflare этот путь либо обрабатывается нативно, либо проксируется через переменную `API_ORIGIN`.

### Настройки проекта в Cloudflare

При создании проекта в Cloudflare Pages через GitHub укажите:

- Repository: `abcage35-web/xway`
- Production branch: `main`
- Root directory: `xway_dashboard_site`
- Build command: `npm run build`
- Build output directory: `dist`

В `Settings -> Variables and Secrets` добавьте:

- `API_ORIGIN` = необязательно, URL резервного backend, например `https://api.example.com`
- `XWAY_STORAGE_STATE_JSON` или `XWAY_STORAGE_STATE_BASE64` = storage state с cookies для прямых запросов в XWAY API из Cloudflare Functions
- либо более простой вариант: `XWAY_COOKIE_HEADER` и `XWAY_CSRF_TOKEN`

### Что важно

- Для полностью нативной работы на Cloudflare теперь достаточно фронта + одного из вариантов auth:
  `XWAY_STORAGE_STATE_JSON`, `XWAY_STORAGE_STATE_BASE64`, `XWAY_COOKIE_HEADER`, либо `XWAY_SESSIONID`.
- Отдельный Python backend нужен только если ты сознательно хочешь сохранить запасной proxy через `API_ORIGIN`.
- Для React SPA отдельный `_redirects` не нужен, если в сборке есть корневой `index.html` и нет верхнеуровневого `404.html`.
