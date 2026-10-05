# Входящие Plaud и почты

Метаданные источников, очередь обработки и почтовый курсор находятся в PostgreSQL.
Тексты встреч, прочитанные письма и результаты обработки сохраняются в S3-архиве
Garage. Существующие локальные файлы Plaud сохраняются для совместимости.
Архив сейчас содержит JSON, а не аудио встреч и не файлы почтовых вложений.
Письмо читается максимум на 100 000 символов; обрезанный текст отмечается в разборе.
Вложения представлены метаданными.

Для действующей CEO-установки: [запуск, перезапуск и диагностика](ru/ceo-operations.md).
Полная установка с нуля: [Telegram, LibreChat, Mail и Plaud](ru/full-startup.md).

## Первичная настройка

```sh
npm run ingestion:setup
IVA_RUNTIME_DATA_DIR="$(node --env-file=.env --input-type=module -e 'import { dataDir } from "./agent/lib/data-dir.ts"; console.log(dataDir())')"
mkdir -p "$IVA_RUNTIME_DATA_DIR/plugin-data/iva-plaud/imports"
npm run ingestion:migrate
npm run build
```

Перед этим настройте общую `.env`, включая ключи LibreChat из полной инструкции,
установите и разрешите Mail/Plaud-плагины. После сборки запустите runtime и
LibreChat, затем `npm run mail:sync -- --enable` для фиксации почтовой границы.

Setup создаёт приватные ключи в `.env` и конфигурацию `data/garage/garage.toml`
(0600), поднимает только `ceo-postgres` и `ceo-archive` проекта `iva-agent`.
Порты доступны только на loopback: PostgreSQL 55433, S3 3900. Другие установки
Ивы и их контейнеры не используются. Для изменения портов задайте
`IVA_POSTGRES_PORT` / `IVA_ARCHIVE_PORT` до первого setup. Не меняйте приватные
ключи уже работающего архива без процедуры ротации Garage.

Migration переносит только уже сохранённые локальные источники Plaud и их
результаты, не загружает историю из Plaud. Настройка `plaudSync.since` сохраняется.
Старые необработанные встречи получают статус `excluded`.

В установленном почтовом плагине необходим инструмент `mail_poll_messages` из
актуальной версии `plugins/iva-mail`. IMAP-параметры остаются в приватном конфиге
плагина. Установленный плагин — копия в `data/custom/plugins/iva-mail`, поэтому изменение
исходника `plugins/iva-mail` само по себе не обновляет действующий плагин.
После обновления плагина и сборки перезапустите runtime **этой** установки
Ивы и её почтовый MCP proxy. В текущей CEO-установке это
`iva-ceo-runtime.service` и `iva-mcp-iva-mail-mail.service`.

## Повторный запуск хранилищ

```sh
docker compose -p iva-agent --profile iva-data up -d --wait ceo-postgres ceo-archive
docker compose -p iva-agent --profile iva-data ps
```

Повторная миграция допустима и не сбрасывает обработанные версии.
Имена проекта и контейнеров фиксированы; второй экземпляр этого стека требует
изменения имён, портов и процедуры setup. Пути статуса и плагинов ниже указаны
для стандартного `ASSISTANT_DATA_DIR=data`; setup хранит Garage config в `./data/garage`.

## Поведение

- Plaud проверяется каждые 10 минут, с прежней границей «только новые».
- Почтовый INBOX проверяется каждые 10 минут со смещением на 5 минут относительно
  Plaud. Первый успешный запуск фиксирует UIDNEXT: существующие письма не импортируются.
  Это также происходит при смене UIDVALIDITY почтового ящика. Повторное включение
  не сбрасывает установленный курсор.
- Новые письма читаются через EXAMINE + BODY.PEEK, флаг «прочитано» не меняется.
  Курсор двигается только после успешной записи источника в архив и PostgreSQL.
- Очередь использует ограниченные по времени leases. Ошибка оставляет источник
  доступным для повторной попытки. На письмо создаётся один отчёт с устойчивым ID.
- Разбор появляется обычным чатом в проекте Libre «Входящие Ивы». В Telegram
  отправляется уведомление с кнопками «Открыть в Libre» и «Показать тут».
- Модель при фоновом разборе письма не получает инструменты. Она предлагает
  действия, но не отправляет ответы и не принимает просьбы отправителя за
  обязательства владельца. Поиск существующей памяти используется как контекст;
  автоматических записей письма в vault пока нет.

Для материализации чатов нужны работающий LibreChat, одинаковый
`LIBRECHAT_NOTIFICATION_SECRET` у Ивы и LibreChat, заполненный
`LIBRECHAT_PUBLIC_URL` и разрешённый аккаунт в `LIBRECHAT_NOTIFICATION_USERS`.
В Telegram дополнительно нужны бот и `TELEGRAM_NOTIFICATION_CHAT_ID`.

Отключение: `npm run mail:sync -- --disable`. Технический статус:
`data/mail-sync-status.json` и `data/plaud-sync-status.json`.

## Сохранность

Docker volumes: `iva-agent_ceo-postgres`, `iva-agent_ceo-archive-meta`,
`iva-agent_ceo-archive-data`. Не используйте `docker compose down -v` для перезапуска.
Для сохранности нужны резервные копии PostgreSQL, обоих Garage volumes,
`.env`, `data/garage/garage.toml`, локального `data` и vault на другом устройстве.
PostgreSQL следует копировать через `pg_dump` (контейнер `iva-ceo-postgres`,
пользователь `iva`, база `iva_metadata`); для файлов Garage используйте согласованный
снимок обоих volumes с остановленным `ceo-archive`.

Текущий Garage работает на одном узле (`replication_factor=1`): архив переживает
перезапуск контейнера, но потеря диска требует внешней резервной копии.

## Проверки

```sh
node --test plugins/iva-mail/poll.test.ts plugins/iva-mail/server.test.ts
IVA_RUN_INGESTION_TESTS=1 node --env-file=.env --test agent/lib/ingestion-store.integration.test.ts
```

Интеграционный тест использует отдельный случайный аккаунт, временные уведомления
и удаляет свои записи и S3-объекты. Настоящих писем не отправляет.
