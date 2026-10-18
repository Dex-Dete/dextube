#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  --systemd-install)
    exec bash "$ROOT_DIR/scripts/install-systemd.sh"
    ;;
  --systemd-start)
    exec systemctl --user start dextube.service
    ;;
  --systemd-restart)
    exec systemctl --user restart dextube.service
    ;;
  --systemd-status)
    exec systemctl --user status dextube.service --no-pager
    ;;
  --help|-h)
    cat <<'EOF'
DEXTube launcher (Ubuntu/Fedora systemd)

  ./start.sh                 Run the existing foreground/background bootstrap.
  ./start.sh --prod          Build and run the production app through scripts/start.sh.
  ./start.sh --systemd-install  Install a user systemd unit for this checkout.
  ./start.sh --systemd-start    Start the installed user unit.
  ./start.sh --systemd-restart  Restart it after a build.
  ./start.sh --systemd-status   Show its status.
EOF
    ;;
  --prod|--production)
    exec bash "$ROOT_DIR/scripts/start.sh" --prod
    ;;
  *)
    exec bash "$ROOT_DIR/scripts/start.sh" "$@"
    ;;
esac
