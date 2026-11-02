# Протокол локального агента

Все команды работают с одним DISCOVERY_DATA_ROOT. На Windows это абсолютный путь на D:, на Linux — абсолютный путь в постоянном хранилище. Данные и файлы подтверждения хранятся вне Git. CLI выводит один JSON-результат, при ошибке возвращает код 2; он не отправляет сообщений на сайты.

## Импорт наблюдений

```bash
python -m autobid.command_center.agent ingest /absolute/path/observations.json
```

Файл — массив от 1 до 200 объектов, до 4 МБ. Обязательны source_id, external_id, canonical_url, title, observed_at с часовым поясом. Время будущего не принимается. Импорт не скачивает URL.

```json
[
  {
    "source_id": "freelance",
    "external_id": "13089",
    "canonical_url": "https://freelance.ru/task/view/13089",
    "title": "Пример схемы данных — не реальное наблюдение",
    "description": "Текст, который агент действительно увидел на странице",
    "listing_kind": "order",
    "availability": "unknown",
    "requested_formats": ["DXF"],
    "observed_at": "2026-11-02T12:00:00+03:00"
  }
]
```

Неизвестное поле пропускайте; явный null означает наблюдаемое отсутствие значения. Повторное наблюдение обновляет запись по паре источник + ID, не создаёт второй заказ. Сокращённое наблюдение не стирает ранее известный бюджет. Все поля проверяются до записи пакета; при остановке процесса часть корректного пакета может сохраниться, повторный импорт безопасен для карточек.

Допустимы поля Listing: description, detail_complete (bool), listing_kind (order/vacancy/unknown), cad_categories (массив строк), budget_min/budget_max (число либо строка десятичного числа), currency, budget_unit, bids_count (целое, 0 не означает неизвестное), published_at, raw_date, availability (open/closed/unknown), requested_formats, explicit_constraints. Нельзя передавать approval/state/пароли/токены.

Поддерживаемые источники и идентификаторы:

- fl: числовой ID и HTTPS URL /projects/ID/slug.html.
- freelance: числовой ID; /task/view/ID или прежний /projects/slug-ID.html.
- telegram: channel_name/message_id в нижнем регистре; t.me/channel_name/message_id или t.me/s/channel_name/message_id.
- kwork: числовой ID; /projects/ID, /projects/view/ID или /projects?id=ID. Это разрешённые форматы ссылок, не утверждение о работоспособности публичного доступа.
- freelancer: числовой ID из API; /projects/category/slug, возможно /details.

Импорт не подтверждает вход в аккаунт. В UI он отображается отдельно от встроенного сборщика.

## Черновик и одобрение

```bash
python -m autobid.command_center.agent draft freelance 13089
python -m autobid.command_center.agent draft freelance 13089 --revision 1 --text-file /private/reply.txt
```

Первый вызов создаёт начальный черновик или возвращает сохранённый. Изменение требует актуальной revision; несовпадение блокирует запись. Изменение одобренного текста снимает одобрение. Одобрять может только владелец в панели. Команды approve у CLI нет.

Текущий шаблон использует заголовок и известные форматы, не LLM. Анализ и персонализацию выполняет dot до одобрения. Цена, сроки, валюта и состав работ должны быть понятны из текста. Не выдумывать обязательства для заполнения обязательных полей формы.

## Очередь и отправка

```bash
python -m autobid.command_center.agent queue
python -m autobid.command_center.agent claim --source freelance
```

В queue попадает только текст, который владелец одобрил и передал кнопкой «Откликнуться». claim атомарно выдаёт одну запись или null. Запись содержит точный текст, revision, recipient canonical_url и claim_token. После выдачи состояние sending, повторный claim эту запись не вернёт. Сохраните ответ в приватном журнале перед внешним действием.

Перед нажатием на сайте ещё раз проверить заказ и уже существующий отклик. У queue нет автоматической аренды/таймаута, позволяющих молча повторить отправку после падения.

После проверки результата создать локальный JSON-файл:

```json
{
  "source_id": "freelance",
  "external_id": "13089",
  "claim_token": "<токен из claim>",
  "outcome": "sent",
  "evidence": "В исходящих виден этот текст, проверено время и получатель",
  "delivery_url": "https://freelance.ru/task/view/13089"
}
```

```bash
python -m autobid.command_center.agent result /private/outcome.json
```

outcome:

- sent — отправка подтверждена наблюдением на площадке. evidence обязателен; delivery_url необязателен, только HTTPS того же хоста, без query/fragment в сохранённой ссылке.
- not_sent — точно установлено, что отправки не было. Возвращает черновик, увеличивает revision и требует нового одобрения.
- uncertain — результат неизвестен. Блокирует повтор до ручной проверки.

Сервер проверяет наличие evidence и соответствие claim_token, но не может самостоятельно доказать правдивость наблюдения агента. Не записывать sent по одному факту клика.

После перезапуска:

```bash
python -m autobid.command_center.agent active
python -m autobid.command_center.agent status
```

active возвращает незавершённые sending/uncertain вместе с приватными claim_token. Сначала проверить площадку; затем записать sent или not_sent с доказательством. Никогда не интерпретировать отсутствие ответа CLI как разрешение повторно отправить сообщение.

Локальная база — граница доверия: пользователь, имеющий доступ к файлам, может изменить её. CLI — протокол для доверенного агента, не изоляция от злонамеренного кода с доступом к тому же компьютеру.
