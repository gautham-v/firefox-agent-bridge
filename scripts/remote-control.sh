#!/bin/sh
# Keeps "claude remote-control" running in the background, so the Claude app on your phone can
# start Claude Code sessions on this machine. Those sessions get the firefox MCP server that
# install.sh registered at user scope, so they can drive Firefox. Runs as a launchd agent
# (macOS) or a systemd user service (Linux) named "Firefox", in the chat panel's folder.
#
# Usage: scripts/remote-control.sh --install [--permission-mode <mode>]
#        scripts/remote-control.sh --uninstall
#        scripts/remote-control.sh --status
#   --install          write and start the service (re-running replaces it)
#   --uninstall        stop and remove it
#   --status           say whether it is installed and running, and show the log's last lines
#   --permission-mode  pass a Claude Code permission mode (default, acceptEdits, plan, ...) to
#                      the sessions; without it they use Claude Code's default
# Logs go to ~/.firefox-agent-bridge/remote-control.log. The claude binary is found like the
# host launcher finds it: CLAUDE_BIN, then PATH, then the path install.sh recorded.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.firefox-agent-bridge"
CHAT_DIR="$STATE/chat"
LOG="$STATE/remote-control.log"
NAME="Firefox"
LABEL="local.firefox-agent-bridge.remote-control"
UNIT="firefox-agent-bridge-remote-control.service"

usage() { sed -n '7,16p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "$*" >&2; exit 1; }

ACTION='' MODE=''
while [ $# -gt 0 ]; do
  case "$1" in
    --install | --uninstall | --status)
      [ -z "$ACTION" ] || die "Only one of --install, --uninstall and --status."
      ACTION="${1#--}" ;;
    --permission-mode)
      [ $# -ge 2 ] || die "--permission-mode needs a value."
      case "$2" in *[!A-Za-z0-9_-]* | '') die "Bad permission mode: $2" ;; esac
      MODE="$2"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done
[ -n "$ACTION" ] || { usage >&2; exit 1; }
[ -z "$MODE" ] || [ "$ACTION" = install ] || die "--permission-mode only applies to --install."

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux ;;
  *) die "Unsupported OS: $(uname -s)" ;;
esac
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
DOMAIN="gui/$(id -u)"

# Prints where claude is: $CLAUDE_BIN, else on PATH, else the path install.sh wrote into the host
# launcher, as long as it still exists.
find_claude() {
  p="${CLAUDE_BIN:-}"
  [ -n "$p" ] || p="$(command -v claude 2>/dev/null || true)"
  if [ -z "$p" ] && [ -f "$REPO/host/firefox-agent-bridge-host" ]; then
    p="$(sed -n 's/^export CLAUDE_BIN="\(.*\)"$/\1/p' "$REPO/host/firefox-agent-bridge-host" | head -n 1)"
  fi
  if [ -n "$p" ] && [ -x "$p" ]; then printf '%s' "$p"; fi
  return 0
}

xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

install_mac() {
  args="        <string>$(xml "$CLAUDE")</string>
        <string>remote-control</string>
        <string>--name</string>
        <string>$NAME</string>"
  [ -z "$MODE" ] || args="$args
        <string>--permission-mode</string>
        <string>$(xml "$MODE")</string>"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
$args
    </array>
    <key>WorkingDirectory</key>
    <string>$(xml "$CHAT_DIR")</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(xml "$SVC_PATH")</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$(xml "$LOG")</string>
    <key>StandardErrorPath</key>
    <string>$(xml "$LOG")</string>
</dict>
</plist>
PLIST_EOF
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Installed and started: $PLIST"
}

install_linux() {
  command -v systemctl >/dev/null || die "systemctl not found; this needs a systemd user session."
  cmd="\"$CLAUDE\" remote-control --name $NAME"
  [ -z "$MODE" ] || cmd="$cmd --permission-mode $MODE"
  mkdir -p "$(dirname "$SERVICE")"
  cat > "$SERVICE" <<UNIT_EOF
[Unit]
Description=Claude Code remote control for Firefox Agent Bridge

[Service]
WorkingDirectory=$CHAT_DIR
Environment="PATH=$SVC_PATH"
ExecStart=$cmd
Restart=always
RestartSec=30
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target
UNIT_EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT"
  systemctl --user restart "$UNIT"
  echo "Installed and started: $SERVICE"
}

do_install() {
  CLAUDE="$(find_claude)"
  [ -n "$CLAUDE" ] || die "claude not found; install Claude Code or set CLAUDE_BIN=/path/to/claude."
  # The service gets a minimal environment, and claude may be a script that needs node on PATH.
  SVC_PATH="$(dirname "$CLAUDE")"
  if command -v node >/dev/null 2>&1; then SVC_PATH="$SVC_PATH:$(dirname "$(command -v node)")"; fi
  SVC_PATH="$SVC_PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  mkdir -p "$CHAT_DIR"
  if [ "$OS" = mac ]; then install_mac; else install_linux; fi
  echo "Sessions started from the Claude app show up under the name \"$NAME\"; log: $LOG"
}

do_uninstall() {
  if [ "$OS" = mac ]; then
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    if [ -f "$PLIST" ]; then rm -f "$PLIST"; echo "Removed $PLIST"; else echo "Not installed."; fi
  else
    if command -v systemctl >/dev/null; then systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true; fi
    if [ -f "$SERVICE" ]; then
      rm -f "$SERVICE"
      if command -v systemctl >/dev/null; then systemctl --user daemon-reload || true; fi
      echo "Removed $SERVICE"
    else
      echo "Not installed."
    fi
  fi
}

do_status() {
  if [ "$OS" = mac ]; then
    [ -f "$PLIST" ] || { echo "Not installed."; return 0; }
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      pid="$(launchctl print "$DOMAIN/$LABEL" | sed -n 's/^[[:space:]]*pid = //p' | head -n 1)"
      if [ -n "$pid" ]; then echo "Installed, running (pid $pid)."; else echo "Installed, loaded but not running; see the log."; fi
    else
      echo "Installed but not loaded; run --install again."
    fi
  else
    [ -f "$SERVICE" ] || { echo "Not installed."; return 0; }
    if systemctl --user is-active --quiet "$UNIT"; then echo "Installed, running."; else echo "Installed, not running; see the log."; fi
  fi
  if [ -f "$LOG" ]; then echo "Last log lines ($LOG):"; tail -n 5 "$LOG"; fi
}

case "$ACTION" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  status) do_status ;;
esac
