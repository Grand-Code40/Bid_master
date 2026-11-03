# Проверка производной v23 — 2026-11-03

Исходный архив: `bid-v23-sanitized-f0bb19a.tar.gz`.
SHA256: `9b75020dcd52705ef3738fab0966aee5c37f394dde32875cfe1574751c5460c5`.
Проверены 65 записей исходного MANIFEST.sha256; baseline сохранён отдельным commit.
Это очищенная производная, не подтверждение побайтового совпадения с production.

## Локальные результаты

Node 24.17.0; Windows. Все базы синтетические SQLite :memory:, сеть в тестах
запрещена offline-guard. Никаких клиентских данных, рабочих D1/сессий или live отправок.

- Полученный baseline: build PASS, 206/206 на schema.sql и 206/206 на generated migrations.
- Текущее дерево: build PASS, **260/260** на schema.sql и **260/260** на generated migrations.
- `drizzle-kit generate`: No schema changes, nothing to migrate.
- Браузерная QA на loopback с синтетической базой: одобрение текста, отключённая
  отправка и её preflight, очередь с явной пометкой, единый Inbox, статусы каналов
  и локальная отметка просмотра. Ошибок console не обнаружено; upstream отсутствует.
- Старая Python-версия: 132/132 до начала работы; Python product-код этой веткой не менялся.

Команды из panel/:

```sh
node scripts/build-local.mjs
node --import ./scripts/offline-guard.mjs --test
USE_GENERATED_MIGRATIONS=1 node --import ./scripts/offline-guard.mjs --test
```

Для PowerShell: `$env:USE_GENERATED_MIGRATIONS='1'` перед вторым запуском.
`npm test` также включает offline guard. CI проверяет обе схемы на Node 24 без секретов.

## Что проверяют новые сценарии

- Параллельные одинаковые review operations возвращают один сохранённый результат;
  изменённое reuse ID отвергается. Сохранены старые operation hashes.
- Управляемые порядки confirm/cancel/claim вместо нестабильной exclusivity-проверки.
- Свежий preflight, точные snapshot/аккаунты/условия, timeout/смена транспорта/закрытый
  заказ/guard, один submit, readback mismatch, terminal executor ledger и uncertain.
- Сбой записи после внешнего действия оставляет durable sending; replay и recovery
  не вызывают submit снова. Старые подтверждения не запускают автоматический drain.
- Owner identity/Origin, writer не получает sender capability, MCP не может одобрять
  или отправлять, служебные claim tokens не попадают в публичный projection.
- Gmail account binding, restricted query, MIME/auth/unsafe rejection, bounded page,
  дубли, cursor/account isolation, 401/403/429/Retry-After, таймауты и частичные сбои.
- Отдельные email/platform kinds, происхождение, immutable content, owner isolation,
  пагинация смешанного Inbox, старые новые события и локальная отметка просмотра.
- UI сохраняет attempt ID после неизвестного ответа, предлагает read-only recovery,
  не отождествляет очередь с отправкой и D1 refresh с provider sync.
- Upgrade заполненной v23 сохраняет старые таблицы/строки/guards/history/viewed/session
  bytes; новые таблицы пусты. schema.sql и generated migration согласны по колонкам
  и уникальным ограничениям.

## Независимое ревью

Проверены code/consent/owner/migration границы. Три Important замечания подтверждены
RED-регрессиями и исправлены одним проходом: операция не может мутировать другой
отклик под занятым operation ID; явный refresh/завершённый импорт возобновляет обход
старых входящих; конфликт полного Gmail письма с сохранённым отрывком отмечается
как пропуск и не блокирует следующие письма. Старые строки и provenance не меняются.
После исправлений: 260/260 на каждой схеме. Live границы reviewer отдельно не подтверждал.

## Что эти проверки НЕ подтверждают

- Реальный браузерный исполнитель, его устойчивый журнал, авторизация и readback
  площадок пока не подключены/не проверены. Контракт сам по себе не отправляет.
- Реальный Gmail OAuth, права конкретного аккаунта, фильтр и доставка почты в hosted
  Worker не проверены. Личный Gmail tool агента не заменяет Worker-подключение.
- Прямое получение полных чатов FL.ru/Freelance.ru/В Масштабе не реализовано;
  доступен честно маркированный импорт наблюдений. Weblancer paused.
- Production Site/Gateway/D1 не разворачивались и не мигрировались. SQLite fixture
  проверяет наши SQL/CAS, но не заменяет испытание Cloudflare D1 runtime.
- Нет подтверждения прочтения сообщения заказчиком, платформенного exactly-once
  без добросовестного executor ledger, фонового Gmail расписания или Pub/Sub watch.

До live проверки нужны приватное подключение исполнителя/Gmail, сверка реального
production diff и backup. Любая конкретная отправка требует отдельного одобрения
владельца заказа и текста. Эти пределы остаются открытыми в Issue #1.
