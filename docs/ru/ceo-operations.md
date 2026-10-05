# Запуск и обслуживание текущей CEO-установки

Эта памятка относится к checkout `/home/iva-agent`.
Для установки с нуля используйте [полную инструкцию](full-startup.md).
Все команды ниже выполняются от владельца установки из этого каталога:

```bash
cd /home/iva-agent
```

## Какие компоненты запускаются

| Компонент                        | Сервис или контейнер              | Адрес по умолчанию в этой установке |
| -------------------------------- | --------------------------------- | ----------------------------------- |
| Ива, API и встроенные расписания | `iva-ceo-runtime.service`         | `127.0.0.1:8533`                    |
| Telegram bridge                  | `iva-ceo-telegram-poll.service`   | Исходящий long polling              |
| Почтовый MCP proxy               | `iva-mcp-iva-mail-mail.service`   | `127.0.0.1:8730`                    |
| Plaud MCP proxy                  | `iva-mcp-iva-plaud-plaud.service` | Порт из состояния плагина           |
| LibreChat                        | `iva-librechat`                   | `127.0.0.1:3080`                    |
| MongoDB LibreChat                | `iva-librechat-mongodb`           | `127.0.0.1:27018`                   |
| PostgreSQL метаданных            | `iva-ceo-postgres`                | `127.0.0.1:55433`                   |
| Garage S3                        | `iva-ceo-archive`                 | `127.0.0.1:3900`                    |

Порты API и контейнеров берутся из `.env`, порт плагина — из
`data/custom/plugins.json`. Если настройки изменены, используйте актуальные значения.
Контейнеры принадлежат Compose-проекту `iva-agent`; команды ниже задают его явно.

На этом сервере есть другая Ива. Не используйте для CEO generic-команды
`npm run iva -- restart` / `stop` и не перезапускайте `iva.service`,
`iva-telegram-poll.service` или контейнер `iva-storage-postgres-1`: они относятся
к другой установке. Команды `plugin trust/update` тоже могут пересобрать ядро и
перегенерировать стандартные systemd units; обновление установленных плагинов
проводите с учётом этой отдельной CEO-конфигурации.

## Обычный запуск после остановки

Секреты, конфигурация и сборка уже подготовлены. Достаточно:

```bash
docker compose -p iva-agent --profile iva-data up -d --wait ceo-postgres ceo-archive
docker compose -p iva-agent --profile librechat up -d librechat
systemctl --user start iva-mcp-iva-mail-mail.service iva-mcp-iva-plaud-plaud.service
systemctl --user start iva-ceo-runtime.service iva-ceo-telegram-poll.service
```

Docker поднимает MongoDB как зависимость LibreChat. Почта и Plaud проверяются
внутри работающего runtime: отдельные процессы `mail:sync` / `plaud:sync` постоянно
держать открытыми не нужно. `start` не перезапускает уже работающий сервис.
После перезагрузки сервера автозапуск systemd зависит от `enable` и user lingering:

```bash
systemctl --user is-enabled iva-ceo-runtime.service iva-ceo-telegram-poll.service
systemctl --user is-enabled iva-mcp-iva-mail-mail.service iva-mcp-iva-plaud-plaud.service
loginctl show-user "$USER" -p Linger
```

Для автозапуска после reboot включите эти четыре units через `systemctl --user enable`
и, если нужно запускать их до SSH-входа, `loginctl enable-linger "$USER"`.
Docker daemon тоже должен автоматически стартовать; контейнеры используют
`restart: unless-stopped`. Контейнер, остановленный вручную, запускается командами выше.

## После изменений кода или общей `.env`

```bash
npm ci
npm run build
systemctl --user restart iva-ceo-runtime.service iva-ceo-telegram-poll.service
```

При изменении только `.env` без изменения кода пересборка не требуется.
При изменении `iva-mail.env` перезапустите только почтовый proxy:

```bash
systemctl --user restart iva-mcp-iva-mail-mail.service
```

Если поменялись переменные, передаваемые в LibreChat через Compose, пересоздайте
его контейнер, сохраняя volumes:

```bash
docker compose -p iva-agent --profile librechat up -d --build --force-recreate librechat
```

Не запускайте одновременно `npm run start:ui` и CEO runtime на одном порту.
Изменение паролей PostgreSQL/S3 в `.env` само по себе не меняет доступы в уже
созданных хранилищах; для них нужна отдельная ротация.

## Входящие и проверка после запуска

Текущие настройки `data/settings.json`: `mailSync.enabled=true`,
`plaudSync.enabled=true`. Граница Plaud — `2026-10-04T20:27:59.131Z`
(4 октября, 23:27:59 по Минску); старые встречи исключены.
Почтовый курсор уже установлен в PostgreSQL. Повторное включение не сбрасывает
его и не загружает существующие письма.

```bash
systemctl --user is-active iva-ceo-runtime.service iva-ceo-telegram-poll.service
systemctl --user is-active iva-mcp-iva-mail-mail.service iva-mcp-iva-plaud-plaud.service
docker compose -p iva-agent --profile iva-data --profile librechat ps
npm run mail:sync
npm run plaud:sync
cat data/mail-sync-status.json data/plaud-sync-status.json
```

`mail:sync` и `plaud:sync` здесь — разовые реальные проверки. Статус-файлы обновляет
штатное расписание, прямой ручной запуск их не обновляет. После следующего тика
в них ожидаются `lastExitCode: 0` и `lastSuccessAt`. При отсутствии новых источников
счётчики `imported`, `processed`, `pending`, `errors` могут быть нулевыми.

Для проверки полного почтового пути отправьте новое письмо в подключённый ящик.
После проверки Ивой появится чат в проекте Libre **«Входящие Ивы»** и уведомление
в Telegram с кнопками **«Открыть в Libre»** / **«Показать тут»**. Войти нужно аккаунтом
из `LIBRECHAT_NOTIFICATION_USERS`; обычные напоминания остаются в колокольчике.
Откройте чат отчёта и продолжайте обсуждение стандартным полем ввода.
Для Plaud запишите встречу после указанной границы и дождитесь транскрипта в облаке.

Расписание: Plaud в минуты `00, 10, …, 50`, почта в `05, 15, …, 55` каждого часа.
Почтовый разбор пока не пишет письмо автоматически в vault. Plaud сохраняет
карточки встреч и явные обязательства в CEO-память. Дайджест и отчёты rollup
включаются отдельно.

Включить или выключить последующие проверки:

```bash
npm run mail:sync -- --enable
npm run mail:sync -- --disable
npm run plaud:sync -- --enable
npm run plaud:sync -- --disable
```

Выберите нужную команду, не выполняйте весь блок подряд. `--enable` также делает
немедленную проверку. Отключение сохраняет архив, курсор и границу Plaud.

## Логи и остановка

```bash
journalctl --user -u iva-ceo-runtime.service -n 100 --no-pager
journalctl --user -u iva-ceo-telegram-poll.service -n 100 --no-pager
journalctl --user -u iva-mcp-iva-mail-mail.service -n 100 --no-pager
docker compose -p iva-agent --profile iva-data logs --tail 100 ceo-postgres ceo-archive
```

Для остановки этой установки:

```bash
systemctl --user stop iva-ceo-telegram-poll.service iva-ceo-runtime.service
systemctl --user stop iva-mcp-iva-mail-mail.service iva-mcp-iva-plaud-plaud.service
docker compose -p iva-agent --profile librechat --profile iva-data stop librechat librechat-mongodb ceo-postgres ceo-archive
```

Не используйте `down -v`: volumes содержат историю и архив.
Список состояния, пределы импорта, первичная настройка PostgreSQL/Garage и требования
к резервным копиям: [входящие и архив](../incoming-storage.md).
