Мы тестируем память Iva для CEO-agent.

Сейчас нужно только проанализировать готовый stock benchmark.
Код не изменяй и ничего не запускай повторно.

Сначала прочитай:

- evals/ceo-memory/v1/README.md
- evals/ceo-memory/v1/rubric.md
- evals/ceo-memory/v1/questions.json
- evals/ceo-memory/v1/expected/truth.json

Затем найди последний прогон в:

data/ceo-memory-benchmarks/

Проанализируй:

- run.json
- stock/artifact-validation.json
- stock/answers/answers.json
- stock/review\.md
- stock/vault/
- stock/snapshots/
- stock/rollup-\*.log
- stock/processing-server.log

Нужно:

1. Оценить каждый ответ по rubric: 2 / 1 / 0.
2. Отдельно отметить critical errors.
3. Посчитать итоговый балл.
4. Проверить current truth, history, commitments и entity linking.
5. Найти расхождения между ответами и фактическим содержимым vault.
6. Разделить проблемы на:
   - проблема модели;
   - проблема prompt/rollup;
   - проблема структуры памяти;
   - проблема benchmark runner.
7. Не предлагать исправления до завершения анализа.
8. Создать полный отчёт:
   <директория-прогона>/stock/analysis.md

Важно: код выхода 2 может означать провал artifact contract, а не аварийное завершение. Ответы и snapshots при этом должны сохраниться.