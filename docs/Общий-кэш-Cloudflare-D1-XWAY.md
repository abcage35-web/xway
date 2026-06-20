# Cloudflare D1: общий кэш XWAY

Проект может хранить загруженные XWAY/API-данные в общем кэше Cloudflare D1. Это нужно, чтобы следующий пользователь не загружал тот же ответ из XWAY заново.

## Привязка

Создайте базу D1 и привяжите ее к Pages-проекту с точным именем привязки:

```text
XWAY_SHARED_CACHE_DB
```

Рекомендуемое имя базы:

```text
xway-shared-cache
```

Задайте стабильный namespace кэша для продакшена:

```text
XWAY_CACHE_NAMESPACE=xway-production
```

Это защищает ключи D1 от изменения после каждого деплоя Pages.

Если привязки настраиваются через `wrangler.jsonc`, добавьте `database_id`, который вернул Cloudflare:

```jsonc
"d1_databases": [
  {
    "binding": "XWAY_SHARED_CACHE_DB",
    "database_name": "xway-shared-cache",
    "database_id": "<D1_DATABASE_ID>"
  }
]
```

Если привязки настраиваются в dashboard Cloudflare, используйте:

`Workers & Pages -> xway-dashboard-site -> Settings -> Functions -> D1 database bindings`

## Миграция

Примените миграцию из папки сайта:

```powershell
cd xway_dashboard_site
npx.cmd wrangler d1 migrations apply xway-shared-cache --remote
```

Файл миграции:

```text
xway_dashboard_site/migrations/0001_xway_shared_cache.sql
```

## Как это работает

- Browser IndexedDB остается самым быстрым кэшем на уровне конкретного пользователя.
- D1 хранит общие серверные API-ответы для эндпоинтов каталога, если ответ не слишком большой.
- D1 также хранит детальные ответы источника XWAY: кабинеты, листинги кабинетов, статистику товаров, `stata`, дневные срезы кампаний и расписания кампаний.
- `refresh=1` / `force_refresh=1` пропускает чтение из кэша и перезаписывает общий кэш свежими данными.
- Если привязка D1 или миграция отсутствуют, приложение возвращается к прежнему поведению: кэш в памяти и KV `XWAY_AI_CACHE`, если KV настроен.

Проверка статуса:

```text
/api/health
```

Ожидаемое поле:

```json
{
  "shared_cache": {
    "d1": true
  }
}
```
