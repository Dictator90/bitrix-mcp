# Bitrix MCP

[English documentation](./README.md)

Bitrix MCP — локальный MCP-сервер без токенов для AI-ассистентов, которые работают с проектами **Bitrix Framework / 1C-Битрикс**. Сервер индексирует проект, шаблоны, модули Битрикс, install-ресурсы и документацию, чтобы ассистент мог искать реальные символы проекта и документацию без установки модуля Битрикс и без изменения runtime.

## Для кого этот инструмент

Bitrix MCP полезен, если вы хотите подключить Cursor, Claude Desktop, Claude Code, PhpStorm / JetBrains AI Assistant, VS Code / GitHub Copilot, Windsurf, Cline, Roo Code, Continue, Gemini CLI, OpenAI Codex, Kilo Code или другой MCP-клиент к локальному проекту Битрикс. После индексации ассистент может отвечать на вопросы по проекту, искать API фреймворка, находить обработчики событий, анализировать шаблоны и использовать локальную документацию как контекст.

## Возможности

- **LiveAPI-поиск**: индексирует PHP-исходники установленного Битрикс и ищет функции, классы, методы, события, компоненты и константы.
- **Индексация проекта**: индексирует текущий проект из терминала или через MCP-инструмент.
- **Индексация шаблонов**: отдельно индексирует шаблоны, компоненты, скрипты, стили и layout-ресурсы.
- **Поиск по документации**: публикует локальные файлы документации как MCP resources и ищет по Markdown/text-документам через SQLite FTS.
- **Опциональный семантический поиск**: при явном включении использует Python FastAPI-сервис на `sentence-transformers`.
- **Локальная модель доступа**: токен и авторизация Битрикс не нужны; доступ определяется тем, где запущен процесс и какие локальные папки вы разрешили индексировать.

## Системные требования

- ОС: Linux, macOS или Windows / Windows PowerShell.
- Node.js **20+**.
- npm **10+**.
- Доступ к диску с проектом Битрикс, который нужно индексировать.
- Доступ в интернет рекомендуется при первой индексации документации: официальный репозиторий документации Bitrix Framework клонируется или обновляется по умолчанию.
- Python **3.11+** нужен только для опционального семантического поиска по документации.

Сервер использует `@modelcontextprotocol/sdk` **v1.29.0**.

## Зависимости

Основные зависимости устанавливаются командой `npm install`:

- `@modelcontextprotocol/sdk` — поддержка MCP-протокола.
- `fast-glob`, `ignore` — поиск файлов и обработка ignore-правил.
- `php-parser` — разбор PHP-символов в проекте и ядре Битрикс.
- `zod` — валидация схем.

Зависимости для опционального семантического поиска находятся в `embeddings/requirements.txt` и устанавливаются только если вы запускаете Python-сервис embeddings.

## Быстрый старт

Из корня проекта Битрикс:

```bash
# 1. Установите зависимости, если используете локальный checkout этого репозитория
npm install
npm run build

# 2. Перейдите в проект Битрикс, который нужно индексировать
cd /path/to/bitrix/project

# 3. Настройте MCP-клиент и создайте индексы .bitrix-mcp
# В CI и скриптах --no-serve не дает init занять stdio после настройки.
npx bitrix-mcp init --agent cursor --no-serve
```

Во время интерактивного `init` выберите одного или несколько AI-агентов из списка. Для неинтерактивной настройки передайте `--agent <id>` (можно повторять или разделять ID запятыми), `--all-agents` или `--yes` для настройки Cursor по умолчанию. Bitrix MCP создаст или обновит конфигурацию MCP-клиента, добавит reusable-инструкции/rules, построит первичные индексы и запустит MCP-сервер через stdio, если не передан `--no-serve` и не обнаружена CI-среда.

После настройки откройте AI-клиент и попросите его использовать Bitrix MCP. Первый проверочный промпт:

```text
Используй Bitrix MCP: проверь статус индексов и найди, где в проекте регистрируются обработчики событий модуля sale.
```

Если нужно только вручную обновить индексы или запустить сервер:

```bash
# Индексировать всё: проект, шаблоны, модули Битрикс, install-ресурсы и документацию
npx bitrix-mcp index-all

# Показать счетчики индекса, разрешенные runtime-пути и диагностику окружения
npx bitrix-mcp status
npx bitrix-mcp config
npx bitrix-mcp doctor

# Запустить MCP-сервер, если индексы уже созданы
npx bitrix-mcp serve
```

## Типовые сценарии

| Цель | Команда | Что изменяет | Когда использовать |
| --- | --- | --- | --- |
| Настроить один MCP-клиент и построить первичные индексы, не занимая stdio | `npx bitrix-mcp init --agent cursor --no-serve` | Обновляет MCP-конфиг выбранного клиента и guidance/rule-файлы, создает `.bitrix-mcp/`, индексирует отсутствующие области project/template/Bitrix code и документацию. | Рекомендуемый первый запуск для скриптов, CI-подобных shell-сессий и любых терминалов, где `init` не должен оставаться запущенным как MCP-сервер. |
| Настроить только файлы клиента и инструкции | `npx bitrix-mcp configure --agent cursor` | Обновляет только MCP-конфиг и guidance/rule-файлы; не строит индексы и не запускает сервер. | Когда индексы уже есть или их будет строить другой процесс. |
| Обновить все индексы с официальной документацией | `npx bitrix-mcp index-all` | Перестраивает/обновляет индексы проекта, шаблонов, модулей Битрикс, install-ресурсов и документации в `.bitrix-mcp/`; официальная документация регистрируется/обновляется по умолчанию. | После крупных изменений кода, обновления модулей/зависимостей или когда поиск по документации должен включать официальный репозиторий Bitrix Framework docs. |
| Быстрый путь без official docs | `BITRIX_MCP_OFFICIAL_DOCS_ENABLED=0 bitrix-mcp index-all` | Перестраивает/обновляет все code-индексы и индексирует только локальные/явно зарегистрированные источники документации; не клонирует и не pull-ит официальный репозиторий. | Для offline-окружений, demo-первого запуска, CI без доступа в интернет или случаев, когда достаточно локальной документации. |
| Обновить только код | `npx bitrix-mcp index-code` | Перестраивает/обновляет индексы проекта, шаблонов, модулей Битрикс и install-ресурсов; документацию не трогает. | После изменений PHP/шаблонов/модулей, если документация не менялась. |
| Проверить конфигурацию и здоровье окружения | `npx bitrix-mcp doctor --verbose` | Не меняет файлы проекта; при необходимости создает/открывает SQLite DB и печатает health-checks вместе с runtime-конфигурацией. | Когда MCP-клиент не видит индексы/документацию, пути выглядят неверно или вы меняли переменные окружения. |

Быстрый путь без official docs специально оставлен одной командой:

```bash
BITRIX_MCP_OFFICIAL_DOCS_ENABLED=0 bitrix-mcp index-all
```

Если пакет не установлен глобально, используйте тот же env override с `npx`: `BITRIX_MCP_OFFICIAL_DOCS_ENABLED=0 npx bitrix-mcp index-all`.

## Использование CLI

```bash
# Настроить агента, создать .bitrix-mcp индексы и запустить stdio-сервер
npx bitrix-mcp init

# Неинтерактивный init для скриптов/CI: настроить Cursor и не запускать сервер после настройки
npx bitrix-mcp init --agent cursor --no-serve

# Настроить MCP-конфиг и guidance без индексации и запуска сервера
npx bitrix-mcp configure --agent cursor

# Запустить MCP-сервер через stdio для Cursor, PhpStorm, Claude Desktop, Kilo и т.д.
npx bitrix-mcp serve

# Индексировать всё: проект, шаблоны, модули Битрикс, install-ресурсы и документацию
npx bitrix-mcp index-all

# Индексировать только кодовые области без документации
npx bitrix-mcp index-code

# Индексировать текущий проект
npx bitrix-mcp index-project /path/to/project

# Отдельно индексировать шаблоны/компоненты/скрипты/стили
npx bitrix-mcp index-template /path/to/project

# Индексировать PHP-исходники установленного Bitrix Framework для LiveAPI
cd /path/to/bitrix/project
npx bitrix-mcp index-bitrix

# Индексировать install-ресурсы модулей Битрикс
npx bitrix-mcp index-install /path/to/project

# Зарегистрировать, обновить и проиндексировать источники документации
npx bitrix-mcp docs-add-git https://github.com/bitrix-tools/framework-docs.git
npx bitrix-mcp docs-add-path /path/to/local/docs
npx bitrix-mcp docs-update
npx bitrix-mcp index-docs

# Отправить SQLite chunks документации в embeddings-сервис
npx bitrix-mcp index-embeddings
# Или переиндексировать SQLite docs и embeddings вместе, если сервис запущен
npx bitrix-mcp index-docs --embeddings

# Показать счетчики индекса, runtime-пути или выполнить диагностику окружения
npx bitrix-mcp status
npx bitrix-mcp config
npx bitrix-mcp doctor
```

По умолчанию индексы создаются в `.bitrix-mcp/`. При индексации всегда применяются встроенные исключения для тяжелых и сгенерированных директорий: `node_modules/`, `vendor/`, `.git/`, `dist/`, `build/`, `upload/`, `cache/`. Также учитываются правила из `.gitignore`, если файл есть в проекте.

Флаги `init`/`configure`:

- `--agent <id>` — неинтерактивно настроить агента; флаг можно повторять или передавать ID через запятую.
- `--all-agents` — настроить все встроенные агенты, которым не нужны дополнительные вопросы.
- `--no-index` — пропустить индексацию проекта/шаблонов/кода Битрикс во время `init`.
- `--no-docs` — пропустить индексацию документации во время `init`.
- `--no-official-docs` — не клонировать и не обновлять официальный репозиторий Bitrix docs во время индексации документации в `init`.
- `--no-serve` — записать конфиги и выполнить выбранные шаги индексации, но не запускать MCP stdio-сервер.
- `--yes` / `-y` — принять значения по умолчанию для неинтерактивного `init`/`configure` (Cursor).

`configure` принимает те же флаги выбора агентов, но никогда не индексирует код/документацию и никогда не запускает сервер.

Чтобы исключить дополнительные файлы из LiveAPI-индекса и индекса шаблонов, добавьте файл `.bitrixmcpignore` в корень проекта. Синтаксис такой же, как у `.gitignore`; правила применяются вместе со встроенными исключениями и `.gitignore`:

```gitignore
# Сгенерированные локальные скрипты
local/scripts/generated/**

# Приватный код, который не должен попадать в поиск
private/*.php
assets/ignored.js
```

## Конфигурация

Пути и опциональные возможности можно переопределить переменными окружения:

- `BITRIX_MCP_DATA_DIR` — директория для хранения индексов.
- `BITRIX_MCP_WORKSPACE` — корень проекта, с которым работает MCP-сервер.
- `BITRIX_MCP_DOCS_PATHS` — директории документации, разделенные системным разделителем путей (`:` в Unix, `;` в Windows).
- `BITRIX_MCP_DOCS_DIR` — legacy-переменная для одной директории документации, которая публикуется как MCP resources.
- `BITRIX_ROOT` — корень проекта Битрикс по умолчанию для `index-bitrix`, `index-code` и `index-all`.
- `BITRIX_MCP_EMBEDDINGS_URL` — URL Python-сервиса embeddings, по умолчанию `http://127.0.0.1:8765`.
- `BITRIX_MCP_SEMANTIC_ENABLED` — включает опциональный MCP-инструмент `bitrix_semantic_docs_search`, если значение равно `1`, `true`, `yes` или `on`; по умолчанию выключено.
- `BITRIX_MCP_OFFICIAL_DOCS_ENABLED` — автоматически регистрирует, клонирует/обновляет и индексирует официальный репозиторий документации Bitrix Framework во время `index-docs`, `index-all` и `bitrix_index_docs`; включено по умолчанию, установите `0`, чтобы использовать только явно зарегистрированную/локальную документацию.

## Режимы поиска по документации

Bitrix MCP поддерживает два режима:

1. **Локальный SQLite FTS (по умолчанию)** — выполните `bitrix-mcp index-docs`, `bitrix-mcp index-all` или MCP-инструмент `bitrix_index_docs`, чтобы клонировать/обновить официальный репозиторий документации Bitrix Framework, проиндексировать зарегистрированные Markdown/text-документы в `.bitrix-mcp/bitrix-mcp.sqlite` и искать через `bitrix_docs_search`. Python и embeddings-сервис не нужны; интернет нужен только при клонировании или обновлении Git-источников документации.
2. **Семантические embeddings (опционально)** — запустите Python FastAPI-сервис из `embeddings/`, проиндексируйте документы в этот сервис и установите `BITRIX_MCP_SEMANTIC_ENABLED=1` для MCP-сервера. Тогда появится дополнительный инструмент `bitrix_semantic_docs_search`, который обращается к `BITRIX_MCP_EMBEDDINGS_URL`.

Используйте локальный FTS как базовый режим. Семантический режим включайте только если вам нужен embedding-based ranking и вы готовы держать Python-сервис запущенным рядом с MCP-сервером.

## `bitrix-mcp init`

Запускайте `init` из корня проекта Битрикс после глобальной установки `bitrix-mcp` или если команда доступна в `PATH`:

```bash
cd /path/to/bitrix/project
bitrix-mcp init
```

Команда берет текущую директорию как корень проекта, создает `<projectRoot>/.bitrix-mcp`, задает `BITRIX_MCP_WORKSPACE=<projectRoot>`, `BITRIX_MCP_DATA_DIR=<projectRoot>/.bitrix-mcp` и `BITRIX_MCP_DOCS_DIR=<projectRoot>/docs`. Если существует `<projectRoot>/bitrix`, дополнительно задается `BITRIX_ROOT=<projectRoot>`. В интерактивном режиме команда спрашивает, каких AI-агентов настроить; для неинтерактивного запуска используйте `--agent <id>`, `--all-agents` или `--yes`. Для каждого выбранного клиента создается или обновляется отдельная MCP-конфигурация:

- Cursor — `.cursor/mcp.json`.
- Claude Desktop — глобальный `claude_desktop_config.json`.
- Claude Code — проектный `.mcp.json`.
- PhpStorm / JetBrains — выводит JSON-фрагмент JetBrains AI Assistant MCP, который нужно вставить в настройки IDE.
- VS Code / GitHub Copilot — `.vscode/mcp.json` в формате VS Code `servers`.
- Windsurf — `~/.codeium/windsurf/mcp_config.json`.
- Cline — `~/.cline/data/settings/cline_mcp_settings.json`.
- Roo Code — `.roo/mcp.json`.
- Continue — `.continue/mcpServers/bitrix-mcp.json`.
- Gemini CLI — `.gemini/settings.json`.
- OpenAI Codex — `~/.codex/config.toml`.
- Kilo Code — `~/.kilocode/cli/global/settings/mcp_settings.json`.
- Другие MCP-клиенты — пользовательский путь к JSON, введенный во время настройки.

Для поддерживаемых JSON-клиентов `init` читает существующий MCP-config и добавляет или обновляет только запись `bitrix-mcp`, сохраняя остальные MCP-серверы и несвязанные настройки. Для каждого выбранного агента `init` также создает reusable-навык Bitrix MCP в `.bitrix-mcp/skills/bitrix-mcp/SKILL.md` и записывает rule-файл, чтобы агент понимал, когда вызывать MCP-инструменты:

- Cursor — `.cursor/rules/bitrix-mcp.mdc`.
- Claude Desktop / Claude Code — управляемый раздел в `CLAUDE.md`.
- PhpStorm / JetBrains — управляемый раздел в `.junie/guidelines.md`.
- VS Code / GitHub Copilot — управляемый раздел в `.github/copilot-instructions.md`.
- Windsurf — `.windsurf/rules/bitrix-mcp.md`.
- Cline — `.clinerules/bitrix-mcp.md`.
- Roo Code — `.roo/rules/bitrix-mcp.md`.
- Continue — `.continue/rules/bitrix-mcp.md`.
- Gemini CLI — управляемый раздел в `GEMINI.md`.
- OpenAI Codex — управляемый раздел в `AGENTS.md`.
- Kilo Code — `.kilocode/rules/bitrix-mcp.md`.
- Другие MCP-клиенты — `.bitrix-mcp/rules/bitrix-mcp.md`.

Файлы с append-логикой сохраняют существующее содержимое и при повторном запуске заменяют только управляемый раздел `bitrix-mcp:init-guidance`. Сервер `bitrix-mcp` запускается так:

```json
{
  "command": "bitrix-mcp",
  "args": ["serve"]
}
```

После записи конфигураций `init` создает `.bitrix-mcp/`, строит отсутствующие индексы проекта/шаблонов, строит индекс Битрикс при наличии локальной директории `bitrix/`, клонирует или обновляет и индексирует источники документации, включая официальный репозиторий Bitrix Framework docs, и запускает MCP-сервер через stdio по умолчанию для локальных интерактивных запусков. В CI (`CI=1` или `GITHUB_ACTIONS=1`) запуск сервера пропускается автоматически; в скриптах лучше явно передавать `--no-serve`. Используйте `--no-index`, `--no-docs` и `--no-official-docs`, чтобы отключить соответствующие шаги `init`.

## MCP-инструменты

- `bitrix_liveapi_search` — поиск по проиндексированным PHP-символам.
- `bitrix_event_search` — поиск обработчиков событий Битрикс по модулю, имени события, классу/методу или функции.
- `bitrix_index_project` — индексация текущего проекта из агента.
- `bitrix_index_all` — индексация файлов проекта, шаблонов, модулей Битрикс, install-ресурсов и документации, включая официальный репозиторий Bitrix Framework docs, если официальная документация включена.
- `bitrix_index_status` — показывает путь к SQLite DB, количество файлов, символов, событий, документов и время последней индексации.
- `bitrix_index_template` — индексирует стандартные расположения шаблонов или принимает `templatePath` относительно корня проекта, например `local/templates/site`, чтобы индексировать конкретную директорию шаблона. Временный аргумент `root` устарел; используйте `templatePath`.
- `bitrix_index_docs` — клонирует/обновляет и индексирует источники документации в SQLite, включая официальный репозиторий Bitrix Framework docs, если официальная документация включена.
- `bitrix_docs_search` — базовый локальный поиск по документации через SQLite FTS.
- `bitrix_semantic_docs_search` — опциональный семантический поиск по документации через embeddings; доступен только при включенном `BITRIX_MCP_SEMANTIC_ENABLED`.

## MCP resources

- `bitrix-docs://index` — JSON-список локальных resources документации.
- `bitrix-docs://framework/getting-started.md` — встроенный стартовый справочник.

По умолчанию индексация документации использует `https://github.com/bitrix-tools/framework-docs.git`, а также локальную директорию `docs/` и зарегистрированные источники. Добавьте свои `.md` или `.txt` файлы в `docs/`, чтобы они попали в индекс документации, или установите `BITRIX_MCP_OFFICIAL_DOCS_ENABLED=0`, чтобы отключить официальный репозиторий.

## Примеры промптов

Используйте такие промпты в MCP-совместимом AI-клиенте после настройки Bitrix MCP:

```text
Используй Bitrix MCP, покажи статус индексов и скажи, готовы ли индексы проекта, шаблонов, ядра Битрикс и документации.
```

```text
Через bitrix_liveapi_search найди примеры использования CIBlockElement::GetList и объясни параметры, важные для этого проекта.
```

```text
Найди в документации Bitrix MCP информацию об обработчиках событий заказов sale, затем найди соответствующие обработчики в этом проекте.
```

```text
Используй Bitrix MCP для анализа local/templates/main и объясни, какие компоненты и assets используются на странице каталога.
```

```text
Перед изменением кода используй Bitrix MCP, найди существующие helper-функции проекта для пользовательских полей и предложи самый безопасный план реализации.
```

```text
Обнови индексы Bitrix MCP, затем проверь, определяют ли install-ресурсы кастомных модулей административные JavaScript-виджеты.
```

## Python-сервис embeddings

```bash
cd embeddings
python -m venv .venv
# Linux/macOS
source .venv/bin/activate
# Windows PowerShell
# .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn service:app --host 127.0.0.1 --port 8765
```

Документы индексируются POST-запросом на `/index`:

```json
{
  "documents": [
    {
      "id": "framework/events",
      "text": "Bitrix events are registered with AddEventHandler...",
      "metadata": { "uri": "bitrix-docs://framework/events.md" }
    }
  ]
}
```

Искать можно через `/search` или, если `BITRIX_MCP_SEMANTIC_ENABLED=1`, через MCP-инструмент `bitrix_semantic_docs_search`. Сервис также предоставляет `/health`, `/stats` и `/reload`; `/search` держит JSON-индекс и embedding matrix в памяти после load/reload и не перестраивает их на каждый запрос.

### Troubleshooting runtime-конфигурации и warning-ов doctor

Используйте `bitrix-mcp config`, если MCP-клиент запускает сервер не из той директории, пишет индексы в неожиданный путь или не находит документацию/источники Битрикс. Для общей проверки здоровья и конфигурации запустите:

```bash
bitrix-mcp doctor --verbose
bitrix-mcp doctor --json
```

Частые warning-и `doctor` и исправления:

| Warning | Что обычно означает | Что делать |
| --- | --- | --- |
| `WARNING bitrixRoot: Bitrix root was not detected` | В текущем workspace нет `./bitrix`, и `BITRIX_ROOT` не задан. Индексация проекта/шаблонов работает, но LiveAPI-индекс ядра пропускается. | Запускайте команды из корня проекта Битрикс, передайте root в `index-bitrix` или экспортируйте `BITRIX_ROOT=/path/to/bitrix/project`. |
| `WARNING bitrixRoot: BITRIX_ROOT is set ... but .../bitrix is missing` | `BITRIX_ROOT` указывает не на тот каталог или на checkout без директории `bitrix/`. | Исправьте `BITRIX_ROOT`, повторите `bitrix-mcp doctor`, затем выполните `bitrix-mcp index-bitrix` или `bitrix-mcp index-code`. |
| `WARNING docsSources: No documentation paths or registered documentation sources found` | Не настроен локальный путь к docs и нет зарегистрированных источников в `.bitrix-mcp/`. | Добавьте Markdown/text-файлы в `docs/`, выполните `bitrix-mcp docs-add-path /path/to/docs` или разрешите official docs командой `BITRIX_MCP_OFFICIAL_DOCS_ENABLED=1 bitrix-mcp index-docs`. |
| `WARNING docsSources: Missing documentation source directories` | Настроенный путь docs или Git checkout больше не существует. | Восстановите директорию, обновите `BITRIX_MCP_DOCS_PATHS`, удалите/добавьте источник заново или выполните `bitrix-mcp docs-update` для Git-источников. |
| `WARNING bitrixmcpignore: .bitrixmcpignore is not present` | Это напоминание: Bitrix MCP применит только встроенные ignore-правила и `.gitignore`. | Опционально создайте `.bitrixmcpignore`, если нужно исключить приватные или сгенерированные файлы из индексов Bitrix MCP. |
| `WARNING phpParse: ... used regex fallback` | Часть PHP-файлов не разобралась AST-парсером, поэтому Bitrix MCP проиндексировал их regex fallback-ом. | Переиндексируйте с `BITRIX_MCP_DEBUG_PARSE=1 bitrix-mcp index-code`, чтобы увидеть пути файлов; исправьте невалидный PHP при необходимости. Обычно fallback-результаты всё равно доступны в поиске. |
| `WARNING embeddingsService: ... unavailable` | Семантический поиск включен, но Python embeddings-сервис недоступен. | Запустите сервис из `embeddings/`, проверьте `BITRIX_MCP_EMBEDDINGS_URL` или отключите `BITRIX_MCP_SEMANTIC_ENABLED`, если достаточно SQLite FTS. |
| `WARNING embeddingsService: ... document count differs` | SQLite docs переиндексированы после последней загрузки embeddings. | Выполните `bitrix-mcp index-embeddings` после `bitrix-mcp index-docs` или `bitrix-mcp index-docs --embeddings`, когда сервис запущен. |

## Пример конфигурации агента

Для проекта `/var/www/site` итоговая MCP-конфигурация, которую пишет `bitrix-mcp init`, выглядит так. Если `/var/www/site/bitrix` существует, добавляется `BITRIX_ROOT`; иначе эта строка отсутствует. Соседние серверы, например `another-server`, сохраняются.

```json
{
  "mcpServers": {
    "another-server": {
      "command": "another-tool",
      "args": ["serve"]
    },
    "bitrix-mcp": {
      "command": "bitrix-mcp",
      "args": ["serve"],
      "env": {
        "BITRIX_MCP_WORKSPACE": "/var/www/site",
        "BITRIX_MCP_DATA_DIR": "/var/www/site/.bitrix-mcp",
        "BITRIX_MCP_DOCS_PATHS": "/var/www/site/docs:/var/www/site/vendor-docs",
        "BITRIX_MCP_DOCS_DIR": "/var/www/site/docs",
        "BITRIX_ROOT": "/var/www/site",
        "BITRIX_MCP_EMBEDDINGS_URL": "http://127.0.0.1:8765",
        "BITRIX_MCP_SEMANTIC_ENABLED": "0"
      }
    }
  }
}
```

## Разработка

```bash
npm test
npm run typecheck
npm run build
```
