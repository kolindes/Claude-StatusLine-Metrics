# Statusline Metrics

Сбор и визуализация метрик Claude Code. Легковесный клиент в statusline.sh + SQLite + дашборд.

```
statusline.sh (каждый Claude)  ──→  metrics-server (SQLite)  ──→  Dashboard (:9177)
      fire-and-forget                    один хост                  браузер
```

## Что собирает

Раз в минуту для каждого проекта:

| Метрика | Описание |
|---------|----------|
| Context window | Использование контекста % и размер окна |
| Rate limits | 5h и 7d лимиты (%, время до сброса) |
| Tokens in/out | Входные и выходные токены (кумулятивно) |
| Cache write/read | Токены кэша (запись, чтение) |
| Cost | Стоимость сессии в USD |
| Session time | Длительность работы |
| API response time | Время ожидания API |
| Lines added/removed | Строки кода |

Данные хранятся **30 дней**. Глобальная статистика (total tokens ever) — навсегда.

---

## Быстрый старт

### 1. Сервер

```bash
git clone <repo> ~/statusline-metrics
cd ~/statusline-metrics
pip install -r server/requirements.txt
python server/metrics_server.py
```

Сервер слушает `http://localhost:9177`. Дашборд: `http://localhost:9177/`

### 2. Интеграция в statusline.sh

Добавь блок в **конец** своего `~/.claude/statusline.sh` (после последнего `printf`):

```bash
# ── Statusline Metrics: fire-and-forget collection ──
[[ -z "$session_id" || "$session_id" == "unknown" ]] && { true; } || {
_m_state="/tmp/.claude_metrics_${session_id}"
_m_last=0; [[ -f "$_m_state" ]] && _m_last=$(< "$_m_state")
_m_now=$(date +%s)
if (( _m_now - _m_last >= 55 )); then
  IFS=$'\t' read -r _m_ppath _m_cost _m_apid _m_la _m_lr < <(
    printf '%s' "$input" | jq -r '[
      (.workspace.project_dir // ""),
      (.cost.total_cost_usd // 0),
      (.cost.total_api_duration_ms // 0),
      (.cost.total_lines_added // 0),
      (.cost.total_lines_removed // 0)
    ] | @tsv')
  [[ -z "$_m_ppath" ]] && _m_ppath="$cwd"
  _m_pname=$(basename "$_m_ppath")
  _m_ppath_safe="${_m_ppath//\\/\\\\}"
  _m_ppath_safe="${_m_ppath_safe//\"/\\\"}"
  _m_pname_safe="${_m_pname//\\/\\\\}"
  _m_pname_safe="${_m_pname_safe//\"/\\\"}"
  if command -v md5sum &>/dev/null; then
    _m_pid=$(printf '%s' "$_m_ppath" | md5sum | cut -c1-12)
  elif command -v md5 &>/dev/null; then
    _m_pid=$(printf '%s' "$_m_ppath" | md5 -q | cut -c1-12)
  else
    _m_pid=$(printf '%s' "$_m_ppath" | cksum | cut -d' ' -f1)
  fi
  _m_url="http://localhost:9177/api/metrics"
  _m_conf="$HOME/.claude/metrics/config"
  [[ -f "$_m_conf" ]] && source "$_m_conf"
  [[ -n "$METRICS_SERVER_URL" ]] && _m_url="$METRICS_SERVER_URL"
  _m_acct="${METRICS_ACCOUNT:-auto}"
  _m_json=$(printf '{"ts":%d,"sid":"%s","pid":"%s","pname":"%s","ppath":"%s","host":"%s","acct":"%s","model":"%s","ctx":%.2f,"ctxsz":%d,"r5h":%.1f,"r5hr":%d,"r7d":%.1f,"r7dr":%d,"tin":%d,"tout":%d,"cw":%d,"cr":%d,"cost":%s,"dur":%d,"apid":%s,"la":%s,"lr":%s}' \
    "$_m_now" "$session_id" "$_m_pid" "$_m_pname_safe" "$_m_ppath_safe" \
    "$(hostname)" "$_m_acct" "${model:-unknown}" \
    "${real_pct_f:-0}" "${ctx_win:-0}" \
    "${five_hr:-0}" "${five_resets:-0}" \
    "${seven_day:-0}" "${seven_resets:-0}" \
    "${total_in:-0}" "${total_out:-0}" \
    "${_cum_cc:-0}" "${_cum_cr:-0}" \
    "${_m_cost:-0}" \
    "${dur_ms:-0}" \
    "${_m_apid:-0}" \
    "${_m_la:-0}" \
    "${_m_lr:-0}")
  _m_fb="${HOME}/.claude/metrics/pending.jsonl"
  mkdir -p "$(dirname "$_m_fb")" 2>/dev/null
  _m_curl=(-s --max-time 1.5 -X POST "$_m_url" -H 'Content-Type: application/json')
  [[ -n "$METRICS_API_KEY" ]] && _m_curl+=(-H "Authorization: Bearer $METRICS_API_KEY")
  _m_curl+=(-d "$_m_json")
  {
    curl "${_m_curl[@]}" >/dev/null 2>&1 \
    && echo "$_m_now" > "$_m_state" \
    || { echo "$_m_json" >> "$_m_fb"; echo "$_m_now" > "$_m_state"; }
  } &
  disown 2>/dev/null
fi
}
```

Display statusline не меняется. Метрики отправляются фоном раз в ~60 секунд.

---

## Сетевые сценарии

### A. Один хост (всё локально)

```
┌──────────────────────────────────┐
│  Linux / macOS / Windows         │
│                                  │
│  statusline.sh                   │
│       │ curl POST localhost:9177 │
│       ▼                          │
│  metrics-server (:9177)          │
│  SQLite + Dashboard              │
└──────────────────────────────────┘
```

Конфигурация не нужна. Работает из коробки.

### B. Два хоста в локальной сети (LAN)

Типичный сценарий: сервер на Linux, клиент на Windows.

```
  ┌────────────────────────┐        ┌────────────────────────┐
  │  Windows (.47)         │        │  Linux (.170)          │
  │  HOME, i9-13900K       │        │  vps170, Ubuntu 24.04  │
  │                        │        │                        │
  │  statusline.sh         │        │  statusline.sh         │
  │       │                │        │       │                │
  │       │ curl POST ─────┼───────→│       │ curl POST      │
  │       │ 192.168.31.170 │  LAN   │       ▼ localhost      │
  │       │ :9177          │        │  metrics-server (:9177)│
  │       │                │        │  SQLite + Dashboard    │
  └────────────────────────┘        └────────────────────────┘

  Dashboard: http://192.168.31.170:9177  (доступен с обоих хостов)
```

**Настройка сервера** (на .170):

```bash
# Запустить с привязкой на все интерфейсы (не только localhost)
# server/config.py или переменная окружения:
export METRICS_HOST=0.0.0.0
python server/metrics_server.py
```

**Настройка клиента** (на .47, Windows):

Создай файл `C:/Users/home/.claude/metrics/config`:

```bash
METRICS_SERVER_URL="http://192.168.31.170:9177/api/metrics"
```

Или в Git Bash: `~/.claude/metrics/config` (то же самое).

Всё. Windows statusline.sh будет слать метрики на .170.

### C. Удалённый сервер (через интернет / VPN)

```
  ┌───────────────┐       ┌───────────────┐       ┌───────────────┐
  │  Laptop       │       │  Desktop      │       │  VPS (сервер) │
  │  macOS        │       │  Windows      │       │  Linux         │
  │               │       │               │       │                │
  │  curl POST ───┼──────→│  curl POST ───┼──────→│  metrics-server│
  │  vpn/tunnel   │  VPN  │  vpn/tunnel   │  VPN  │  :9177         │
  └───────────────┘       └───────────────┘       └───────────────┘
```

**На клиентах** (`~/.claude/metrics/config`):

```bash
METRICS_SERVER_URL="http://your-vps-ip:9177/api/metrics"
METRICS_API_KEY="your-secret-key-here"
```

**На сервере:** задать API key в конфиге или переменной окружения:

```bash
export METRICS_API_KEY="your-secret-key-here"
export METRICS_HOST=0.0.0.0
python server/metrics_server.py
```

Без API key — сервер принимает POST только с localhost.
С API key — принимает с любого IP при совпадении ключа.

---

## Конфигурация клиента

Файл: `~/.claude/metrics/config`

| Переменная | Default | Описание |
|-----------|---------|----------|
| `METRICS_SERVER_URL` | `http://localhost:9177/api/metrics` | URL сервера |
| `METRICS_API_KEY` | _(пусто)_ | API ключ для remote-сервера |
| `METRICS_ACCOUNT` | `auto` | Имя аккаунта Claude (для multi-account) |

Примеры:

```bash
# Локальный сервер, один аккаунт (default, можно не создавать файл)
METRICS_SERVER_URL="http://localhost:9177/api/metrics"

# Сервер в LAN, аккаунт указан явно
METRICS_SERVER_URL="http://192.168.31.170:9177/api/metrics"
METRICS_ACCOUNT="pro-main"

# Второй аккаунт на той же машине (другой config или env)
METRICS_SERVER_URL="http://192.168.31.170:9177/api/metrics"
METRICS_ACCOUNT="max-work"

# Сервер через VPN с авторизацией
METRICS_SERVER_URL="http://10.8.0.1:9177/api/metrics"
METRICS_API_KEY="abc123secret"
METRICS_ACCOUNT="personal"
```

### Multi-account

Если на одной машине запущены окна Claude под разными аккаунтами (Pro + Max, личный + рабочий):

1. **Рекомендуется:** задать `METRICS_ACCOUNT` в config — стабильное, человекочитаемое имя
2. **Авто-режим:** если не задано, сервер группирует сессии по `rate_limits.resets_at` — сессии с одинаковым временем сброса = один аккаунт

Rate limits, prediction и estimation — всё per-account. Данные разных аккаунтов не смешиваются.

## Конфигурация сервера

Переменные окружения или `server/config.py`:

| Переменная | Default | Описание |
|-----------|---------|----------|
| `METRICS_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` для LAN) |
| `METRICS_PORT` | `9177` | Порт |
| `METRICS_API_KEY` | _(пусто)_ | Если задан — требуется для remote POST |
| `METRICS_RETENTION_DAYS` | `30` | Хранение данных (дни) |
| `METRICS_DB_PATH` | `~/.claude/metrics/statusline-metrics.db` | Путь к БД |

---

## Fallback

Если сервер недоступен, метрики сохраняются локально:

```
~/.claude/metrics/pending.jsonl
```

При следующем запуске сервера — автоматический инжест из pending.jsonl.

## Автозапуск сервера

**Linux (systemd user service):**

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/statusline-metrics.service << 'EOF'
[Unit]
Description=Statusline Metrics Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 %h/statusline-metrics/server/metrics_server.py
Restart=always
RestartSec=5
Environment=METRICS_HOST=0.0.0.0

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now statusline-metrics
```

**macOS (launchd):**

```bash
cat > ~/Library/LaunchAgents/com.statusline-metrics.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.statusline-metrics</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/Users/YOU/statusline-metrics/server/metrics_server.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>METRICS_HOST</key><string>0.0.0.0</string>
  </dict>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.statusline-metrics.plist
```

**Windows (Task Scheduler):**

```bat
:: Создать start_metrics.bat
echo start /B pythonw %USERPROFILE%\statusline-metrics\server\metrics_server.py > %USERPROFILE%\start_metrics.bat

:: Добавить в Task Scheduler: Trigger = At Logon, Action = start_metrics.bat
schtasks /create /tn "StatuslineMetrics" /tr "%USERPROFILE%\start_metrics.bat" /sc onlogon
```

---

## Структура проекта

```
statusline-metrics/
├── README.md                  # Этот файл
├── server/
│   ├── metrics_server.py      # Flask app (entry point)
│   ├── database.py            # SQLite init, queries, cleanup
│   ├── ingest.py              # Инжест pending.jsonl
│   ├── config.py              # Конфигурация
│   ├── requirements.txt       # flask, waitress
│   └── static/                # Dashboard
│       ├── index.html
│       ├── css/
│       │   └── dashboard.css
│       ├── js/
│       │   ├── app.js
│       │   ├── charts.js
│       │   └── api.js
│       └── vendor/            # Локальные JS-библиотеки
│           └── chart.js      # Chart.js 4.4.7
└── install.sh                 # Установка (vendor libs + dirs)
```

## Dashboard

Дашборд: `http://<server-ip>:9177/`

- Dark theme, минималистичный UI
- Графики в стиле Binance (фильтры: 1h / 6h / 1d / 7d / 30d)
- Per-project breakdown
- Rate limit prediction
- Context window analysis (min/max/avg реального окна в токенах)
- Global all-time statistics

## Smoke Test

После установки сервера и интеграции в statusline.sh — проверь что всё работает:

```bash
# 1. Сервер жив?
curl -s http://localhost:9177/api/health | python3 -m json.tool

# Ожидаемый ответ:
# {
#     "status": "ok",
#     "uptime_seconds": 42,
#     "db_size_bytes": 12288,
#     "total_records": 0,
#     "active_sessions": 0,
#     "pending_jsonl_exists": false,
#     "version": "1.0.0"
# }

# 2. Отправить тестовую метрику вручную:
curl -s -X POST http://localhost:9177/api/metrics \
  -H 'Content-Type: application/json' \
  -d '{
    "ts": 1711497600,
    "sid": "test-session-001",
    "pid": "a1b2c3d4e5f6",
    "pname": "my-project",
    "ppath": "/home/user/my-project",
    "host": "vps170",
    "acct": "pro-main",
    "model": "claude-opus-4-6",
    "ctx": 42.50,
    "ctxsz": 1000000,
    "r5h": 23.1,
    "r5hr": 1711505000,
    "r7d": 8.4,
    "r7dr": 1712100000,
    "tin": 150000,
    "tout": 45000,
    "cw": 80000,
    "cr": 35000,
    "cost": 0,
    "dur": 360000,
    "apid": 120000,
    "la": 245,
    "lr": 30
  }'

# Ответ: {"status": "ok"}

# 3. Проверить что запись в БД:
curl -s http://localhost:9177/api/projects | python3 -m json.tool

# Ожидаемый ответ:
# [
#     {
#         "project_id": "a1b2c3d4e5f6",
#         "project_name": "my-project",
#         "last_active": 1711497600,
#         "sessions_count": 1
#     }
# ]

# 4. Открыть дашборд в браузере:
#    http://localhost:9177/
#    (или http://192.168.31.170:9177/ с другого хоста в LAN)
```

Если шаги 1-3 прошли — система работает. Запусти Claude и через минуту реальные метрики появятся на дашборде.

## Auto-setup через Claude

Если хочешь, чтобы Claude Code сам настроил систему — скопируй этот блок в чат:

```
Настрой statusline-metrics на этой машине:

1. Клонируй репозиторий в ~/statusline-metrics (если ещё нет)
2. Запусти install.sh (установит зависимости и vendor JS)
3. Запусти сервер: python3 ~/statusline-metrics/server/metrics_server.py
4. Проверь: curl -s http://localhost:9177/api/health
5. Добавь metrics-блок в конец моего ~/.claude/statusline.sh
   (блок из README.md, секция "Интеграция в statusline.sh")
   ВАЖНО: не меняй существующий код statusline.sh, только добавь блок В КОНЕЦ
6. Проверь что statusline display не изменился
7. Настрой автозапуск сервера (systemd на Linux, launchd на macOS)

Сервер должен слушать на 0.0.0.0:9177 (для доступа из LAN).
Конфиг клиента: ~/.claude/metrics/config
```

Для настройки на **удалённом хосте** (например Windows-машина шлёт на Linux-сервер):

```
На моей Windows-машине настрой statusline-metrics клиент:

1. Создай файл ~/.claude/metrics/config с содержимым:
   METRICS_SERVER_URL="http://192.168.31.170:9177/api/metrics"
   METRICS_ACCOUNT="home-pc"

2. Добавь metrics-блок в конец моего ~/.claude/statusline.sh
   (из README statusline-metrics репозитория)
   ВАЖНО: блок добавляется ПОСЛЕ последнего printf, ничего не меняя

3. Проверь: curl -s http://192.168.31.170:9177/api/health
```

## API Reference

```
POST /api/metrics                    — приём метрик от клиента
GET  /api/health                     — статус сервера
GET  /api/projects                   — список проектов
GET  /api/projects/:id/summary       — сводка по проекту
GET  /api/projects/summary-all       — агрегированная сводка по всем проектам
GET  /api/metrics                    — time-series (project_id, from, to, interval)
GET  /api/rate-limits/current        — текущие 5h/7d лимиты
GET  /api/rate-limits/history        — история rate limits
GET  /api/rate-limits/prediction     — прогноз исчерпания
GET  /api/rate-limits/estimates      — оценка token budget
GET  /api/context-window/analysis    — анализ контекстного окна
GET  /api/global-stats               — all-time статистика
GET  /api/sessions                   — список сессий
GET  /api/response-time              — время ответа API
```

Все GET-endpoints поддерживают `?account=X` для multi-account фильтрации.

## Troubleshooting

**Сервер не запускается:**
- Порт 9177 занят? `ss -tlnp | grep 9177`
- Python < 3.9? `python3 --version`
- Зависимости не установлены? `pip install -r server/requirements.txt`

**Метрики не поступают:**
- Сервер доступен? `curl http://localhost:9177/api/health`
- statusline.sh обновлён? Проверь блок метрик в конце файла
- Fallback работает? `ls ~/.claude/metrics/pending.jsonl`

**Дашборд пустой:**
- Выбран правильный time range? Попробуй 30d
- Проект выбран? Кликни "All Projects"
- Есть записи? Проверь `curl -s http://localhost:9177/api/health | python3 -m json.tool` -- поле `total_records`

**Rate limit exceeded (429):**
- Сервер ограничивает 120 записей/минуту на сессию
- Нормальная отправка — раз в 60 секунд, лимит не затрагивается
- Если срабатывает — проверь что statusline.sh не запущен в цикле

## Требования

- Python 3.9+
- bash 4+ (Linux/macOS) или Git Bash 5+ (Windows)
- curl, jq (уже используются statusline.sh)
