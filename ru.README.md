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
- Node.js **22.12+**, потому что Bitrix MCP использует `node:sqlite`.
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

## Установка из npm

Установите пакет глобально:

```bash
npm install -g @mb4it/bitrix-mcp
```

Или запустите без глобальной установки:

```bash
npx @mb4it/bitrix-mcp init --agent cursor --no-serve
```

Команда после установки остается `bitrix-mcp`:

```bash
bitrix-mcp --help
bitrix-mcp init --agent cursor --no-serve
bitrix-mcp index-all
bitrix-mcp serve
```

## Приоритет результатов MCP

Bitrix MCP обеспечивает глубокое специализированное индексирование Bitrix Framework и кода вашего проекта. При использовании ИИ-ассистента с Bitrix MCP:

- **Основной источник истины**: Результаты инструментов MCP являются приоритетными для символов проекта, API фреймворка, обработчиков событий, ORM-сущностей и документации.
- **Ручной поиск как резерв**: ИИ-агенты получают инструкции искать файлы вручную или использовать \`grep\` только тогда, когда инструменты MCP не возвращают результатов, указывают на устаревший индекс или когда вы явно просите выполнить ручную проверку.
- **Правило авторитетности**: Успешные, непустые результаты MCP не должны ставиться под сомнение на основе неиндексированных ручных предположений.

Такое поведение снижает расход токенов и предотвращает галлюцинации ассистента, вызванные неполным сканированием файлов вручную.

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
npm bitrix-mcp init --agent cursor --no-serve

Во время интерактивного `init` выберите одного или несколько AI-агентов из списка. Для неинтерактивной настройки передайте `--agent <id>` (можно повторять или разделять ID запятыми), `--all-agents` или `--yes` для настройки Cursor по умолчанию. Bitrix MCP создаст или обновит конфигурацию MCP-клиента, добавит reusable-инструкции/rules (а для Claude-агентов установит скилл в `.claude/skills/`) и построит первичные индексы. `init` **не** запускает stdio-сервер сам — записанный им MCP-конфиг запускает `bitrix-mcp serve` из вашего клиента, поэтому сервер стартует сам клиент. Передайте `--serve`, чтобы запустить его сразу, или выполните `bitrix-mcp serve` вручную.

После настройки откройте AI-клиент и попросите его использовать Bitrix MCP. Первый проверочный промпт:

```text
Используй Bitrix MCP: проверь статус индексов и найди, где в проекте регистрируются обработчики событий модуля sale.
```

Если нужно только вручную обновить индексы или запустить сервер:

```bash
# Индексировать всё: проект, шаблоны, модули Битрикс, install-ресурсы и документацию
npx @mb4it/bitrix-mcp index-all

# Показать счетчики индекса, разрешенные runtime-пути и диагностику окружения
npm bitrix-mcp status
npm bitrix-mcp config
npm bitrix-mcp doctor

# Запустить MCP-сервер, если индексы уже созданы
npx @mb4it/bitrix-mcp serve
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
npx @mb4it/bitrix-mcp init

# Неинтерактивный init для скриптов/CI: настроить Cursor и не запускать сервер после настройки
npx bitrix-mcp init --agent cursor --no-serve

# Настроить MCP-конфиг и guidance без индексации и запуска сервера
npx bitrix-mcp configure --agent cursor

# Запустить MCP-сервер через stdio для Cursor, PhpStorm, Claude Desktop, Kilo и т.д.
npx @mb4it/bitrix-mcp serve

# Индексировать всё: проект, шаблоны, модули Битрикс, install-ресурсы и документацию
npx @mb4it/bitrix-mcp index-all

# Индексировать только кодовые области без документации
npx @mb4it/bitrix-mcp index-code

# Индексировать текущий проект
npx @mb4it/bitrix-mcp index-project /path/to/project

# Отдельно индексировать шаблоны/компоненты/скрипты/стили
npx @mb4it/bitrix-mcp index-template /path/to/project

# Индексировать PHP-исходники установленного Bitrix Framework для LiveAPI
cd /path/to/bitrix/project
npx @mb4it/bitrix-mcp index-bitrix

# Индексировать install-ресурсы модулей Битрикс
npx @mb4it/bitrix-mcp index-install /path/to/project

# Зарегистрировать, обновить и проиндексировать источники документации
npx @mb4it/bitrix-mcp docs-add-git https://github.com/bitrix-tools/framework-docs.git
npx @mb4it/bitrix-mcp docs-add-path /path/to/local/docs
npx @mb4it/bitrix-mcp docs-update
npx @mb4it/bitrix-mcp index-docs

# Отправить SQLite chunks документации в embeddings-сервис
npx bitrix-mcp index-embeddings
# Или переиндексировать SQLite docs и embeddings вместе, если сервис запущен
npx bitrix-mcp index-docs --embeddings

# Показать счетчики индекса, runtime-пути или выполнить диагностику окружения
npm bitrix-mcp status
npm bitrix-mcp config
npm bitrix-mcp doctor
```

По умолчанию индексы создаются в `.bitrix-mcp/`. При индексации всегда применяются встроенные исключения для тяжелых и сгенерированных директорий: `node_modules/`, `vendor/`, `.git/`, `dist/`, `build/`, `upload/`, `cache/`. Также учитываются правила из `.gitignore`, если файл есть в проекте.

Флаги `init`/`configure`:

- `--agent <id>` — неинтерактивно настроить агента; флаг можно повторять или передавать ID через запятую.
- `--all-agents` — настроить все встроенные агенты, которым не нужны дополнительные вопросы.
- `--no-index` — пропустить индексацию проекта/шаблонов/кода Битрикс во время `init`.
- `--no-docs` — пропустить индексацию документации во время `init`.
- `--no-official-docs` — не клонировать и не обновлять официальный репозиторий Bitrix docs во время индексации документации в `init`.
- `--serve` — запустить MCP stdio-сервер после init (по умолчанию init его не запускает — клиент сам стартует `bitrix-mcp serve`).
- `--no-serve` — явный no-op для поведения по умолчанию (оставлен для обратной совместимости).
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

## Индексация ядра Bitrix

Ядро Bitrix (`/bitrix/`) большое, поэтому индексация **курируемая и управляемая**.

**Что индексирует scope `bitrix`** (команда `index-bitrix`, а также Bitrix-часть
`index-code` / `index-all`):

- `bitrix/modules/**/*.php` — PHP модулей (классы, ORM, события, использования API)
- `bitrix/admin/**/*.php` и `bitrix/tools/**/*.php`
- `bitrix/js/**` и `local/js/**` — JS ядра (связь фронт ↔ логика)
- `local/modules/**/*.php` — ваши кастомные модули

**Исключено по умолчанию** (runtime/static — всегда, даже при `--full`):

- runtime/cache/generated: `bitrix/cache`, `managed_cache`, `html_pages`, `upload`, …
- статика: `bitrix/images`, `themes`, `fonts`, `panel`, …
- `bitrix/wizards/**`
- `install/**` модулей (install-ассеты — отдельный scope `index-install`)
- `lang/**` — файлы переводов; исключены во **всех** scope (модули, компоненты, шаблоны, проект), а не только здесь (вернуть: `--include-lang` / `--full`)

Компоненты и шаблоны индексирует scope **template** (`bitrix/components`,
`bitrix/templates` и `local/`-аналоги) — он работает в `index-template`,
`index-code` и `index-all`.

> Scope **project** (`index-project`) индексирует только код вашего проекта и
> **никогда** не обходит `/bitrix/` — ядро принадлежит отдельному scope `bitrix`.

### Типовые сценарии

```bash
# Проиндексировать всё ядро (все модули, без lang). Это поведение по умолчанию.
npx @mb4it/bitrix-mcp index-bitrix

# Только нужные модули (намного быстрее на реальном проекте)
npx @mb4it/bitrix-mcp index-bitrix --modules=main,iblock

# Интернет-магазин
npx @mb4it/bitrix-mcp index-bitrix --modules=main,iblock,sale,catalog,currency

# Полный индекс: все модули + lang (долго; печатает предупреждение)
npx @mb4it/bitrix-mcp index-bitrix --full

# Сухой прогон: показать план без индексации (found / ignored / queued, топ модулей)
npx @mb4it/bitrix-mcp index-bitrix --plan --modules=main,iblock

# index-code / index-all: пропустить ядро или сузить его
npx @mb4it/bitrix-mcp index-all --no-bitrix
npx @mb4it/bitrix-mcp index-all --bitrix-modules=main,iblock
```

### Флаги

| Флаг | Где | Эффект |
| --- | --- | --- |
| `--modules=main,iblock` | `index-bitrix` | Индексировать только эти модули ядра (по умолчанию `all`). `--modules=all` — все. |
| `--bitrix-modules=…` | `index-code`, `index-all` | Тот же выбор для Bitrix-части этих команд. |
| `--full` | `index-bitrix`, `index-code`, `index-all` | Все модули **плюс** `lang/` и install-ассеты. Алиас `--modules=all --include-lang --install`. Печатает предупреждение о длительности. |
| `--include-lang` | все команды индексации Bitrix | Включить `lang/` во всех scope (по умолчанию выкл). |
| `--install` | `index-code`, `index-all` | Также индексировать `install/`-ассеты модулей (по умолчанию выкл — install это отдельный scope `index-install`). |
| `--no-bitrix` | `index-code`, `index-all` | Полностью пропустить scope ядра **и** install. |
| `--plan` | `index-bitrix` | Напечатать план (found / ignored / queued, топ модулей) и выйти без индексации. |

Неизвестные имена модулей выводят предупреждение (например,
`module "foo" was requested but not found`) и пропускаются; прогон продолжается,
если найден хотя бы один из запрошенных модулей.

### Инкрементальная переиндексация

Переиндексация инкрементальная: файл перечитывается только если изменились его
размер или mtime с прошлого прогона. Неизменённые файлы пропускаются и остаются в
индексе; удалённые — удаляются. Поэтому долгий только первый `index-bitrix`,
последующие — быстрые. В итоговом summary видно `indexed` против `skipped` (см. ниже).

Правила `.bitrixmcpignore` применяются поверх встроенных.

## Прогресс индексации

Индексация полного проекта Bitrix (особенно `index-bitrix` по реальному дереву
`/bitrix/`) может занимать много минут. Чтобы процесс был наглядным, все команды
`index-*` показывают прогресс во время работы.

```bash
# По умолчанию: живой прогресс в интерактивном терминале
npx @mb4it/bitrix-mcp index-project
npx @mb4it/bitrix-mcp index-bitrix

# Компактный прогресс: точки для работы, галочки для завершённых этапов/scope
npx @mb4it/bitrix-mcp index-bitrix --compact

# Полностью отключить прогресс
npx @mb4it/bitrix-mcp index-all --no-progress

# Принудительно включить прогресс в неинтерактивной оболочке
npx @mb4it/bitrix-mcp index-bitrix --progress

# Машиночитаемый прогресс в формате JSON Lines (в stderr)
npx @mb4it/bitrix-mcp index-bitrix --json-progress
```

Поведение:

- Прогресс **включён по умолчанию** в интерактивном терминале (`stderr` — TTY).
- `--compact` печатает короткую строку на каждый scope: `.` для текущей работы и
  `✓` для завершённых этапов, плюс однострочный итог по каждому scope.
- `--no-progress` полностью отключает вывод прогресса.
- `--json-progress` выводит по одному JSON-объекту на событие.
- Прогресс всегда пишется в **`stderr`**, никогда в `stdout`, поэтому он не ломает
  MCP stdio (`serve`) и не мешает выводу команд в пайпах.
- В **CI / неинтерактивной** среде прогресс по умолчанию выключен; включите его
  флагом `--progress`, `--compact` или `--json-progress`.
- Если задан `NO_COLOR` (или терминал не поддерживает unicode), репортеры
  используют ASCII-символы.

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

Запускайте `init` из корня проекта Битрикс после глобальной установки `@mb4it/bitrix-mcp` или если команда `bitrix-mcp` доступна в `PATH`:

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

- **Индексация/статус/config/doctor**: `bitrix_index_project`, `bitrix_index_template`, `bitrix_index_all`, `bitrix_index_docs`, `bitrix_index_status`, а также CLI `config` и `doctor`.
- **LiveAPI и поиск символов**: `bitrix_liveapi_search`, `bitrix_event_search`, `bitrix_module_usage_search`, `bitrix_inheritance_search`.
- **Контекст исходников**: `bitrix_read_file_context`, `bitrix_read_symbol_context`.
- **Агенты и почтовые события**: `bitrix_agent_search`, `bitrix_mail_event_search`.
- **Компоненты**: `bitrix_component_search`, `bitrix_component_context`.
- **ORM**: `bitrix_orm_search`, `bitrix_orm_entity_map`, `bitrix_orm_usage_search`.
- **IBlock / Highloadblock / Options**: `bitrix_iblock_usage_search`, `bitrix_hlblock_usage_search`, `bitrix_option_search`.
- **Связи и граф**: `bitrix_relation_search`, `bitrix_graph_neighbors`, `bitrix_graph_traverse`, `bitrix_impact_radius`.
- **Detect changes**: `bitrix_detect_changes` объединяет Git-изменения, индексированные сущности, graph impact, риск и рекомендации.
- **Autoload и обзор проекта**: `bitrix_autoload_search`, `bitrix_project_overview`.
- **Документация и объяснение API**: `bitrix_docs_search`, `bitrix_docs_for_symbol`, `bitrix_explain_api_usage`, опционально `bitrix_semantic_docs_search` при включенном `BITRIX_MCP_SEMANTIC_ENABLED`.
- **Бенчмарки**: CLI `benchmark` пишет `.bitrix-mcp/benchmark.json` и `.bitrix-mcp/benchmark.md`.

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

## Отчёты benchmark Phase 17

Запуск из репозитория или установленного пакета:

```bash
npm run benchmark
# или после сборки/установки
bitrix-mcp benchmark
```

Отчёты создаются в `.bitrix-mcp/benchmark.json` и `.bitrix-mcp/benchmark.md`. Benchmark измеряет инкрементальные `index-all`, `index-project`, `index-template`, опциональный `index-bitrix`, задержки поиска по docs/LiveAPI/events/relations, обход графа, impact-radius, detect-changes, размер SQLite DB и счётчики файлов, символов, событий, relations и docs chunks. Если корень Bitrix, документация или опциональные индексы отсутствуют, шаг пропускается с предупреждением. Полная переиндексация не форсируется без `--force`.

## Карта документации

- [MCP tools](./docs/tools.md) — только реально реализованные инструменты, параметры, примеры, prompts, сценарии и ограничения.
- [Indexing](./docs/indexing.md) — области индексации и benchmark.
- [Bitrix events](./docs/bitrix-events.md) — workflow для событий.
- [ORM](./docs/orm.md) — workflow для D7 ORM.
- [Components](./docs/components.md) — workflow для компонентов и шаблонов.
- [Graph](./docs/graph.md) — `bitrix_relations`, neighbors, traverse, impact radius.
- [Detect changes](./docs/detect-changes.md) — workflow ревью изменений.
- [Security](./docs/security.md) — локальные данные и ограничения путей.
- [Examples](./docs/examples.md) — готовые prompts.

Рекомендуемый AI workflow:

1. Общая работа: `bitrix_index_status` → `bitrix_project_overview` → `bitrix_liveapi_search` / `bitrix_docs_search` → `bitrix_read_file_context` или `bitrix_read_symbol_context`.
2. Ревью: `bitrix_detect_changes` → `bitrix_impact_radius` → `bitrix_graph_neighbors` или `bitrix_graph_traverse` → `bitrix_relation_search` → context tools.
3. События Bitrix: `bitrix_event_search` → `bitrix_relation_search` → `bitrix_graph_neighbors` → `bitrix_read_file_context`.
4. ORM: `bitrix_orm_search` → `bitrix_orm_entity_map` → `bitrix_orm_usage_search` → `bitrix_graph_neighbors`.
5. Компоненты: `bitrix_component_search` → `bitrix_component_context` → `bitrix_impact_radius` при изменении файлов компонента.
