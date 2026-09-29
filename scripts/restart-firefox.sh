#!/bin/sh
# Restart Firefox Developer Edition in the background with caches purged, so edits to the
# extension (experiment schema, actor modules) take effect. Waits for the bridge socket.
# Set FIREFOX_BIN to the firefox binary if it isn't found.
SOCK="$HOME/.firefox-agent-bridge/bridge.sock"

if [ "$(uname -s)" = Darwin ] && [ -z "$FIREFOX_BIN" ]; then
  osascript -e 'tell application "Firefox Developer Edition" to quit' 2>/dev/null
  while pgrep -f "Firefox Developer Edition.app/Contents/MacOS/firefox" >/dev/null; do sleep 0.5; done
  rm -f "$SOCK"
  open -g -a "Firefox Developer Edition" --args -purgecaches
else
  if [ -z "$FIREFOX_BIN" ]; then
    for c in "$(command -v firefox-developer-edition)" "$(command -v firefox-devedition)" \
      "$HOME/firefox/firefox" /opt/firefox-developer-edition/firefox; do
      [ -n "$c" ] && [ -x "$c" ] && FIREFOX_BIN="$c" && break
    done
  fi
  [ -n "$FIREFOX_BIN" ] || { echo "Firefox Developer Edition not found; set FIREFOX_BIN." >&2; exit 1; }
  # Distro launchers are often wrapper scripts that exec the real binary, which is what
  # shows up in ps.
  BIN="$(readlink -f "$FIREFOX_BIN" 2>/dev/null || echo "$FIREFOX_BIN")"
  if [ "$(head -c 2 "$BIN")" = "#!" ]; then
    real="$(grep -o '/[^ "]*/firefox\(-bin\)\{0,1\}' "$BIN" | head -n 1)"
    [ -z "$real" ] || BIN="$(readlink -f "$real" 2>/dev/null || echo "$real")"
  fi
  DIR="$(dirname "$BIN")"
  # Main (non-content) processes of this install, found by their executable since argv[0]
  # may be a symlink. Prefer the one running the bridge's native host.
  HOST="$(cd "$(dirname "$0")/.." && pwd)/host/host.mjs"
  main_pids() {
    if [ ! -d /proc/self ]; then
      # macOS: no /proc, but ps reports the full executable path; content processes run
      # plugin-container, not firefox.
      ours="$(ps -axo pid=,comm= | awk -v b="$DIR/firefox" '{ p = $1; sub(/^ *[0-9]+ /, "") } $0 == b { print p }')"
    else
      ours="$(for proc in /proc/[0-9]*; do
        exe="$(readlink "$proc/exe" 2>/dev/null)" || continue
        case "$exe" in "$DIR/firefox" | "$DIR/firefox-bin") ;; *) continue ;; esac
        tr '\0' ' ' < "$proc/cmdline" | grep -q -e -contentproc || echo "${proc#/proc/}"
      done)"
    fi
    hosts=" $(ps -eo ppid=,args= | awk -v h="$HOST" 'index($0, h) { print $1 }' | tr '\n' ' ')"
    bridge=""
    for pid in $ours; do
      case "$hosts" in *" $pid "*) bridge="$bridge $pid" ;; esac
    done
    echo "${bridge:-$ours}"
  }
  # Firefox shuts down cleanly (session saved) on SIGTERM.
  pids="$(main_pids)"
  for pid in $pids; do kill "$pid" 2>/dev/null; done
  for pid in $pids; do
    i=0
    while kill -0 "$pid" 2>/dev/null; do
      i=$((i + 1))
      [ $i -le 60 ] || { echo "Firefox did not quit; close it and retry." >&2; exit 1; }
      sleep 0.5
    done
  done
  rm -f "$SOCK"
  nohup "$FIREFOX_BIN" -purgecaches >/dev/null 2>&1 &
fi

for i in $(seq 1 40); do
  [ -S "$SOCK" ] && sleep 1 && exit 0
  sleep 0.5
done
echo "bridge did not come up; see ~/.firefox-agent-bridge/host.log" >&2
exit 1
