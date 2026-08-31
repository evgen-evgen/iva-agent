# Пользователи Telegram и изоляция памяти

Iva остаётся одним ядром обработки, но каждый аутентифицированный пользователь приватного чата
получает отдельный tenant с непрозрачным ID. Сообщение и промпт не могут выбирать tenant.
Группы, супергруппы и каналы в первой версии отклоняются до записи памяти и запуска модели.

Private-пользователи автоматически попадают в `tenants.sqlite` с ролью `user`.
`TELEGRAM_OWNER_USER_IDS` — единственный ID доступа в `.env`; он даёт права владельца: модель, thinking, restart/update,
maintenance, shell, плагины и интеграции владельца. Обычному пользователю остаются его
диалог, задачи, память и персонализация.

```dotenv
TELEGRAM_OWNER_USER_IDS=123456789
```

Данные лежат в `data/tenants.sqlite` и
`data/tenants/t_<32 hex>/`: `state.sqlite`, `settings.json`, `runtime/jobs/` и `vault/`.
Trace и usage остаются общими операционными журналами, но содержат только непрозрачный
tenant ID и недоступны обычному пользователю как источник памяти.

## Перенос старой однопользовательской установки

Остановите writers и отдельно скопируйте `.env`, `data/` и старый vault. Укажите ровно
одного active owner, перезапустите Iva для синхронизации registry и сначала выполните
только проверку:

```bash
node --env-file=.env scripts/migrate-tenant-owner.ts
```

Команда покажет source/target, количество и размер файлов, SHA-256 и совместимое
структурированное состояние. При нуле или нескольких owners она останавливается до
изменения vault. После проверки примените:

```bash
node --env-file=.env scripts/migrate-tenant-owner.ts --apply
```

Миграция использует staging, сверяет хэши, делает backup, публикует tenant-vault,
переносит settings/tasks/cursors и архивирует старый vault. Данные для отката находятся в
`data/tenant-migration-backups/<migration-id>/rollback.json`. Второго пользователя не
добавляйте, пока миграция и `iva doctor` не завершились успешно.

## Backup и восстановление

Копируйте вместе `.env`, `data/tenants.sqlite`, весь `data/tenants/` и, если нужна
операционная история, `data/trace` с `data/usage.jsonl`. Один Git-репозиторий vault не
содержит registry, задач, настроек, metadata вложений и job cursors. Восстанавливайте всё
при остановленных Iva и poll bridge, сохраняйте владельца/права файлов, затем запускайте
`iva doctor`.

Ручные фоновые запуски идут через тот же tenant-dispatcher:

```bash
npm run memory -- daily   # weekly | monthly | yearly
npm run brain
```
