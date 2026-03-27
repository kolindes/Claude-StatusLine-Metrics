#!/usr/bin/env bash
set -euo pipefail

# Statusline Metrics — Installer
# Проверяет зависимости, устанавливает vendor-библиотеки, создаёт директории.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="$SCRIPT_DIR/server/static/vendor"
METRICS_DIR="$HOME/.claude/metrics"

# ── Цвета ──
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
ok()   { printf "${GREEN}OK${RESET}  %s\n" "$1"; }
fail() { printf "${RED}FAIL${RESET}  %s\n" "$1"; }
warn() { printf "${YELLOW}WARN${RESET}  %s\n" "$1"; }
info() { printf "${DIM}...${RESET}   %s\n" "$1"; }

echo ""
echo "  Statusline Metrics — Install"
echo "  ────────────────────────────"
echo ""

# ── 1. Проверка зависимостей ──
errors=0

# Python 3
if command -v python3 &>/dev/null; then
  py_ver=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  if python3 -c "import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)" 2>/dev/null; then
    ok "Python $py_ver (>= 3.9)"
  else
    fail "Python $py_ver — нужен 3.9+. Обновите Python."
    errors=$((errors + 1))
  fi
else
  fail "Python 3 не найден. Установите: https://www.python.org/downloads/"
  errors=$((errors + 1))
fi

# pip
if python3 -m pip --version &>/dev/null 2>&1; then
  ok "pip"
else
  fail "pip не найден. Установите: python3 -m ensurepip"
  errors=$((errors + 1))
fi

# curl
if command -v curl &>/dev/null; then
  ok "curl"
else
  fail "curl не найден"
  errors=$((errors + 1))
fi

# jq
if command -v jq &>/dev/null; then
  ok "jq"
else
  warn "jq не найден (нужен для statusline.sh, не для сервера)"
fi

if (( errors > 0 )); then
  echo ""
  fail "Исправьте ошибки выше и повторите."
  exit 1
fi

# ── 2. Python зависимости ──
echo ""
info "Устанавливаю Python-зависимости..."
python3 -m pip install -q --user -r "$SCRIPT_DIR/server/requirements.txt" 2>/dev/null \
  || python3 -m pip install -q -r "$SCRIPT_DIR/server/requirements.txt" 2>&1 | tail -1
ok "Python-зависимости установлены"

# ── 3. Vendor JS-библиотеки ──
echo ""
info "Скачиваю JS-библиотеки для дашборда..."
mkdir -p "$VENDOR_DIR"

LWC_URL="https://unpkg.com/lightweight-charts@4.2.2/dist/lightweight-charts.standalone.production.js"
CJS_URL="https://cdn.jsdelivr.net/npm/chart.js@4.4/dist/chart.umd.min.js"

if [[ ! -f "$VENDOR_DIR/lightweight-charts.js" ]]; then
  curl -sL -o "$VENDOR_DIR/lightweight-charts.js" "$LWC_URL" && \
    ok "lightweight-charts.js ($(wc -c < "$VENDOR_DIR/lightweight-charts.js" | tr -d ' ') bytes)" || \
    warn "Не удалось скачать lightweight-charts.js (можно позже)"
else
  ok "lightweight-charts.js (уже есть)"
fi

if [[ ! -f "$VENDOR_DIR/chart.js" ]]; then
  curl -sL -o "$VENDOR_DIR/chart.js" "$CJS_URL" && \
    ok "chart.js ($(wc -c < "$VENDOR_DIR/chart.js" | tr -d ' ') bytes)" || \
    warn "Не удалось скачать chart.js (можно позже)"
else
  ok "chart.js (уже есть)"
fi

# ── 4. Директории ──
echo ""
mkdir -p "$METRICS_DIR"
ok "Директория метрик: $METRICS_DIR"

# ── 5. Итог ──
echo ""
echo "  ────────────────────────────"
echo "  Установка завершена."
echo ""
echo "  Запуск сервера:"
echo "    python3 $SCRIPT_DIR/server/metrics_server.py"
echo ""
echo "  Дашборд:"
echo "    http://localhost:9177/"
echo ""
echo "  Smoke test:"
echo "    curl -s http://localhost:9177/api/health"
echo ""
