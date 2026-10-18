#!/usr/bin/env bash
set -euo pipefail

# Portable per-user systemd installer. Ubuntu and Fedora both use the same
# systemctl --user interface; no distro-specific package manager or sudo is
# invoked here.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required." >&2; exit 1; }
[[ -f "$ROOT_DIR/.env" ]] || { echo ".env is missing; copy .env.example first." >&2; exit 1; }
NPM_BIN="$(command -v npm)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/dextube.service"
mkdir -p "$UNIT_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=DEXTube web application
After=default.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
EnvironmentFile=$ROOT_DIR/.env
Environment=NODE_ENV=production
ExecStart=$NPM_BIN start -- -H 127.0.0.1
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

echo "Building DEXTube..."
(cd "$ROOT_DIR" && npm run build)
systemctl --user daemon-reload
systemctl --user enable --now dextube.service
echo "Installed and started $UNIT"
echo "Check: systemctl --user status dextube.service"
echo "If it must start without an interactive login, enable user lingering with your distro's administrator policy."
