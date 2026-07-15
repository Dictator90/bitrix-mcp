# Bitrix MCP

[English documentation](./README.md)

Локальный [MCP](https://modelcontextprotocol.io)-сервер без токенов, который индексирует ваш проект на **Bitrix Framework / 1С-Битрикс** — PHP-исходники, шаблоны, модули, install-ассеты и документацию — чтобы ИИ-ассистент искал реальные символы и документацию проекта. Не нужно ставить модуль Битрикса, менять рантайм или заводить API-токен.

Работает с любым MCP-совместимым ассистентом: Cursor, Claude Code, Claude Desktop, PhpStorm/JetBrains AI, VS Code / GitHub Copilot, Windsurf, Cline, Roo Code, Continue, Gemini CLI, OpenAI Codex, Kilo Code.

> Подробная справка (`docs/`) — на английском.

## Что умеет

- **Поиск по LiveAPI и символам** — функции, классы, методы, события, компоненты, константы, использования include/check модулей по вашему коду и ядру Битрикса.
- **Индексация проекта, шаблонов и ядра** — отдельно и инкрементально индексирует ваш код, шаблоны/компоненты и ядро Битрикса.
- **Поиск по документации** — локальная документация Bitrix Framework как MCP-ресурсы, поиск через полнотекстовый индекс SQLite (опционально — семантический поиск через Python-сервис).
- **Граф зависимостей и радиус влияния** — запрос Bitrix-ориентированного графа событий, обработчиков, модулей, агентов, ORM-сущностей, компонентов, инфоблоков, опций и наследования; видно, на что повлияет правка.
- **Локально и приватно** — без токенов и авторизации Битрикса; доступ определяется только тем, какие локальные папки вы открываете.

## Требования

- Node.js **22.12+** (используется `node:sqlite`) и npm **10+**.
- Linux, macOS или Windows.
- Доступ к каталогу проекта Битрикса для индексации.
- Сеть нужна для первой индексации документации (клонируется официальная документация Битрикса; можно отключить).
- Python **3.11+** — только для опционального семантического поиска.

## Установка

```bash
npm install -g @mb4it/bitrix-mcp
# или без установки:
npx @mb4it/bitrix-mcp init
```

### Windows / PowerShell

Если PowerShell отказывается запускать глобальную команду `bitrix-mcp` с ошибкой
«Невозможно загрузить файл … `bitrix-mcp.ps1`, так как выполнение сценариев
отключено в этой системе» (`UnauthorizedAccess` / `PSSecurityException`) — это
политика выполнения скриптов Windows блокирует npm-шим `bitrix-mcp.ps1`, а не
проблема самого пакета. Выберите один вариант:

```powershell
# Рекомендуется: один раз разрешить локальные/подписанные скрипты для пользователя
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# Или запуск без установки и без изменения политики:
npx @mb4it/bitrix-mcp init

# Или явный вызов .cmd-шима (работает и при Restricted-политике):
bitrix-mcp.cmd init
```

Это касается только разовой команды `init`, которую вы вводите вручную. Конфиг
MCP-сервера, который пишет `init`, на Windows уже запускает сервер через
`cmd /c`, поэтому ваш MCP-клиент (Cursor, Claude Code, …) стартует его без
изменения политики.

## Быстрый старт

Из корня вашего проекта на Битриксе:

```bash
# Настроить MCP-клиент и построить начальные индексы.
# Сервер запускает сам клиент, поэтому init его не стартует.
npx @mb4it/bitrix-mcp init --agent cursor
```

`init` берёт текущий каталог как корень проекта, настраивает выбранные клиенты, пишет файлы с правилами/подсказками и индексирует проект, шаблоны, ядро Битрикса (если есть локальный `bitrix/`) и документацию. Запустите без флагов для интерактивного выбора нескольких клиентов или передайте `--agent <id>` / `--all-agents` / `--yes`.

Затем откройте ИИ-клиент и попросите использовать Bitrix MCP. Хороший первый запрос:

```text
Используй Bitrix MCP: проверь статус индекса, затем найди, как в этом проекте регистрируются обработчики событий модуля sale.
```

## Повседневные команды

```bash
bitrix-mcp index-all      # переиндексировать всё: проект, шаблоны, ядро, install, документацию
bitrix-mcp index-code     # переиндексировать только код (без документации)
bitrix-mcp serve          # запустить MCP-сервер (обычно это делает клиент)
bitrix-mcp status         # счётчики индекса и путь к БД
bitrix-mcp doctor         # проверка состояния и вычисленные пути
```

Индексировать только нужные модули ядра — заметно быстрее:

```bash
bitrix-mcp index-bitrix --modules=main,iblock,sale,catalog
```

Пропустить загрузку официальной документации (офлайн / CI / демо):

```bash
BITRIX_MCP_OFFICIAL_DOCS_ENABLED=0 bitrix-mcp index-all
```

→ Полный список команд, флаги и опции прогресса: **[docs/cli.md](./docs/cli.md)**.

## Как ИИ-агенту это использовать

Считайте непустые результаты MCP авторитетными для символов проекта, API фреймворка, обработчиков событий, ORM-сущностей и документации. Переходите к ручному `grep`/чтению файлов только если MCP ничего не вернул, сообщил об устаревшем индексе или вы сами просите ручную проверку. Это экономит токены и предотвращает галлюцинации по неполным просмотрам файлов. (`init` сам прописывает эту инструкцию в файл правил каждого клиента.)

Рекомендуемый порядок: `bitrix_index_status` → `bitrix_project_overview` → `bitrix_liveapi_search` / `bitrix_docs_search` → `bitrix_read_file_context` / `bitrix_read_symbol_context`.

## MCP-инструменты

Обзор по группам (полная справка с параметрами и примерами — в **[docs/tools.md](./docs/tools.md)**):

- **Индекс / статус** — `bitrix_index_project`, `bitrix_index_template`, `bitrix_index_all`, `bitrix_index_docs`, `bitrix_index_status`
- **Поиск символов и LiveAPI** — `bitrix_liveapi_search`, `bitrix_event_search`, `bitrix_module_usage_search`, `bitrix_inheritance_search`
- **Контекст исходников** — `bitrix_read_file_context`, `bitrix_read_symbol_context`
- **Компоненты и ORM** — `bitrix_component_search`, `bitrix_component_context`, `bitrix_orm_search`, `bitrix_orm_entity_map`, `bitrix_orm_usage_search`
- **Инфоблоки / HL-блоки / опции / агенты / почта** — `bitrix_iblock_usage_search`, `bitrix_hlblock_usage_search`, `bitrix_option_search`, `bitrix_agent_search`, `bitrix_mail_event_search`
- **Граф и влияние** — `bitrix_relation_search`, `bitrix_graph_neighbors`, `bitrix_graph_traverse`, `bitrix_impact_radius`, `bitrix_detect_changes`
- **Документация** — `bitrix_docs_search`, `bitrix_docs_for_symbol`, `bitrix_explain_api_usage` и опциональный `bitrix_semantic_docs_search`
- **Обзор / автозагрузка** — `bitrix_project_overview`, `bitrix_autoload_search`

## Конфигурация

Основные настройки — переменные окружения: пути, корень Битрикса, официальная документация, семантический поиск. `init` сам прописывает нужные клиенту значения в его MCP-конфиг.

```bash
BITRIX_ROOT                       # корень проекта Битрикса для индексации ядра
BITRIX_MCP_DATA_DIR               # где хранятся индексы (по умолчанию .bitrix-mcp)
BITRIX_MCP_OFFICIAL_DOCS_ENABLED  # 0 — пропустить официальный репозиторий документации
BITRIX_MCP_SEMANTIC_ENABLED       # 1 — включить семантический поиск по документации
```

→ Все переменные, таблица настроек по клиентам, флаги `init`/`configure` и устранение проблем: **[docs/configuration.md](./docs/configuration.md)**.

## Прямой доступ к БД проекта (опционально)

Используй MCP-инструменты для прямого запроса к MySQL-базе проекта — посмотри параметры подключения, изучи схему, выполняй запросы `SELECT`. Учётные данные читаются из `bitrix/.settings.php`; отдельная авторизация не требуется.

```bash
BITRIX_MCP_DB_ENABLED=1         # включить инструменты БД (по умолчанию отключено)
BITRIX_MCP_DB_ALLOW_WRITE=1     # дополнительно разрешить INSERT/UPDATE/DELETE (по умолчанию отключено)
```

Инструменты: `bitrix_db_connections` (список активных подключений, пароли скрыты), `bitrix_db_schema` (таблицы и столбцы), `bitrix_db_query` (SQL только для чтения). Записи — опционально: `bitrix_db_execute` (INSERT/UPDATE/DELETE) при `BITRIX_MCP_DB_ALLOW_WRITE=1`. Пароли никогда не возвращаются. Предназначено только для локальной разработки. `init` спрашивает, включить ли доступ к БД (по умолчанию да) и записи (по умолчанию нет); управляй с помощью `--no-db` и `--db-allow-write` без интерактивного режима.

## Выполнение PHP-кода в рантайме (опционально)

Выполняй произвольный PHP-код с полностью загруженным ядром Битрикса через инструмент `bitrix_tinker` — MCP-аналог Laravel Tinker. Получай реальное поведение рантайма, запросы ORM, опции и API модулей вместо статического анализа.

```bash
BITRIX_MCP_TINKER_ENABLED=1     # включить инструмент (по умолчанию отключено)
BITRIX_MCP_PHP_BIN=php          # путь к бинарнику PHP CLI (по умолчанию php; должна совпадать версия PHP сайта)
```

`bitrix_tinker` запускает подпроцесс PHP CLI, который загружает `bitrix/modules/main/include/prolog_before.php`, поэтому доступны полный D7 API, ORM, `Loader::includeModule`, `Option::get` и весь Bitrix-контекст рантайма. Возвращай значение с `return <expr>;`; вывод `echo` и выброшенные исключения захватываются структурированно. **Это полное выполнение кода и доступ на запись к машине, и обходит защиту `bitrix_db_query` на чтение полностью.** Включай только на доверенной локальной машине разработки — никогда на общих или production-окружениях. `init` спрашивает, включить ли (по умолчанию нет); используй `--tinker` для включения без интерактивного режима.

## Документация

- **[CLI reference](./docs/cli.md)** — все команды, индексация ядра, флаги, прогресс.
- **[Configuration](./docs/configuration.md)** — переменные окружения, настройка клиентов, диагностика.
- **[MCP tools](./docs/tools.md)** — параметры, примеры, форматы результатов, ограничения.
- **[Indexing](./docs/indexing.md)** — области индексации и хранение.
- **[Dependency graph](./docs/graph.md)** — связи, соседи, обход, радиус влияния.
- **[Detect changes](./docs/detect-changes.md)** — рабочий процесс ревью.
- **[Bitrix events](./docs/bitrix-events.md)** · **[ORM](./docs/orm.md)** · **[Components](./docs/components.md)** — процессы по темам.
- **[Docs search & embeddings](./docs/embeddings.md)** — FTS и опциональный Python-сервис.
- **[Security](./docs/security.md)** — локальные данные, ограничения путей, заметки о сети.
- **[Example prompts](./docs/examples.md)** — готовые запросы.

## Разработка

```bash
npm test
npm run typecheck
npm run build
```

## Лицензия

[MIT](./LICENSE)
