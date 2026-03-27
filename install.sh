#!/usr/bin/env bash
set -euo pipefail

# Statusline Metrics — Installer
# Checks dependencies, downloads vendor JS, creates directories.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="$SCRIPT_DIR/server/static/vendor"
METRICS_DIR="$HOME/.claude/metrics"

# ── Colors ──
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
ok()   { printf "${GREEN}OK${RESET}  %s\n" "$1"; }
fail() { printf "${RED}FAIL${RESET}  %s\n" "$1"; }
warn() { printf "${YELLOW}WARN${RESET}  %s\n" "$1"; }
info() { printf "${DIM}...${RESET}   %s\n" "$1"; }

echo ""
echo "  Statusline Metrics — Install"
echo "  ────────────────────────────"
echo ""

# ── 1. Check dependencies ──
errors=0

# Python 3
if command -v python3 &>/dev/null; then
  py_ver=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  if python3 -c "import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)" 2>/dev/null; then
    ok "Python $py_ver (>= 3.9)"
  else
    fail "Python $py_ver is too old. Need 3.9+."
    errors=$((errors + 1))
  fi
else
  fail "Python 3 not found. Install: https://www.python.org/downloads/"
  errors=$((errors + 1))
fi

# pip
if python3 -m pip --version &>/dev/null 2>&1; then
  ok "pip"
else
  fail "pip not found. Run: python3 -m ensurepip"
  errors=$((errors + 1))
fi

# curl
if command -v curl &>/dev/null; then
  ok "curl"
else
  fail "curl not found"
  errors=$((errors + 1))
fi

# jq
if command -v jq &>/dev/null; then
  ok "jq"
else
  warn "jq not found (needed for statusline.sh, not the server)"
fi

if (( errors > 0 )); then
  echo ""
  fail "Fix the errors above and try again."
  exit 1
fi

# ── 2. Python dependencies ──
echo ""
# Check if already installed first
if python3 -c "import flask; import waitress" 2>/dev/null; then
  ok "Python dependencies (already installed)"
else
  info "Installing Python dependencies..."
  if python3 -m pip install -q --user -r "$SCRIPT_DIR/server/requirements.txt" 2>/dev/null; then
    ok "Python dependencies installed (--user)"
  elif python3 -m pip install -q -r "$SCRIPT_DIR/server/requirements.txt" 2>/dev/null; then
    ok "Python dependencies installed"
  elif python3 -m pip install -q --break-system-packages -r "$SCRIPT_DIR/server/requirements.txt" 2>/dev/null; then
    ok "Python dependencies installed (system)"
  else
    fail "Could not install Python dependencies. Try manually: pip install flask waitress"
    exit 1
  fi
fi

# ── 3. Vendor JS libraries ──
echo ""
info "Downloading JS libraries for the dashboard..."
mkdir -p "$VENDOR_DIR"

CJS_URL="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"

if [[ ! -f "$VENDOR_DIR/chart.js" ]]; then
  curl -sL -o "$VENDOR_DIR/chart.js" "$CJS_URL" && \
    ok "chart.js 4.4.7 ($(wc -c < "$VENDOR_DIR/chart.js" | tr -d ' ') bytes)" || \
    warn "Failed to download chart.js (CDN fallback will be used)"
else
  ok "chart.js (already present)"
fi

# ── 4. Check port ──
echo ""
if (ss -tlnp 2>/dev/null || lsof -iTCP:9177 -sTCP:LISTEN 2>/dev/null) | grep -q '9177'; then
  warn "Port 9177 is already in use. Stop the existing process or change METRICS_PORT."
fi

# ── 5. Create directories ──
echo ""
mkdir -p "$METRICS_DIR"
ok "Metrics directory: $METRICS_DIR"

# ── 6. Autostart (systemd — Linux only) ──
if command -v systemctl &>/dev/null; then
  echo ""
  read -p "  Set up autostart (systemd)? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "  Bind to all interfaces (0.0.0.0) for LAN access? [y/N] " -n 1 -r
    echo
    BIND_HOST="127.0.0.1"
    [[ $REPLY =~ ^[Yy]$ ]] && BIND_HOST="0.0.0.0"

    mkdir -p ~/.config/systemd/user
    cat > ~/.config/systemd/user/statusline-metrics.service << SEOF
[Unit]
Description=Statusline Metrics Server
After=network.target

[Service]
Type=simple
ExecStart=$(command -v python3) $SCRIPT_DIR/server/metrics_server.py
Restart=always
RestartSec=5
Environment=METRICS_HOST=$BIND_HOST

[Install]
WantedBy=default.target
SEOF
    systemctl --user daemon-reload
    systemctl --user enable --now statusline-metrics
    ok "systemd service installed and started"
  fi
fi

# ── 7. Done ──
echo ""
echo "  ────────────────────────────"
echo "  Installation complete."
echo ""
echo "  Start the server:"
echo "    python3 $SCRIPT_DIR/server/metrics_server.py"
echo ""
echo "  Dashboard:"
echo "    http://localhost:9177/"
echo ""
echo "  Smoke test:"
echo "    curl -s http://localhost:9177/api/health"
echo ""
