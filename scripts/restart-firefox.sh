#!/bin/sh
# Restart Firefox Developer Edition in the background with caches purged, so edits to the
# extension (experiment schema, actor modules) take effect. Waits for the bridge socket.
osascript -e 'tell application "Firefox Developer Edition" to quit' 2>/dev/null
while pgrep -f "Firefox Developer Edition.app/Contents/MacOS/firefox" >/dev/null; do sleep 0.5; done
rm -f "$HOME/.claude-firefox/bridge.sock"
open -g -a "Firefox Developer Edition" --args -purgecaches
for i in $(seq 1 40); do
  [ -S "$HOME/.claude-firefox/bridge.sock" ] && sleep 1 && exit 0
  sleep 0.5
done
echo "bridge did not come up; see ~/.claude-firefox/host.log" >&2
exit 1
