#!/bin/sh
# Installs Firefox Agent Bridge into a Firefox Developer Edition profile:
#   - native messaging host manifest + launcher
#   - the extension, as an unpacked proxy install (edits in extension/ apply on restart)
#   - the prefs that let an unsigned privileged extension load
#   - the "firefox" MCP server for Claude Code (user scope)
#
# Usage: scripts/install.sh [profile-dir]
# Quit Firefox Developer Edition first; prefs are read at startup.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FF="$HOME/Library/Application Support/Firefox"
EXT_ID="firefox-agent-bridge@local"
HOST_NAME="firefox_agent_bridge"
NODE="$(command -v node)"

PROFILE="$1"
if [ -z "$PROFILE" ]; then
  REL="$(awk -F= '/^\[Install/{s=1;next} /^\[/{s=0} s&&$1=="Default"&&$2~/dev-edition/{print $2; exit}' "$FF/profiles.ini")"
  [ -n "$REL" ] || { echo "No Developer Edition profile found in profiles.ini; pass the profile dir." >&2; exit 1; }
  PROFILE="$FF/$REL"
fi
[ -d "$PROFILE" ] || { echo "Profile dir not found: $PROFILE" >&2; exit 1; }

if pgrep -f "Firefox Developer Edition.app/Contents/MacOS/firefox" >/dev/null; then
  echo "Quit Firefox Developer Edition first." >&2
  exit 1
fi

# Native host: Firefox launches it without a shell PATH, so pin the node binary.
LAUNCHER="$REPO/host/firefox-agent-bridge-host"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$NODE" "$REPO/host/host.mjs" "\$@"
EOF
chmod +x "$LAUNCHER"

NMH_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
mkdir -p "$NMH_DIR"
cat > "$NMH_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Firefox Agent Bridge native host",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
EOF

# Extension: a proxy file whose contents are the path of the unpacked extension.
mkdir -p "$PROFILE/extensions"
rm -f "$PROFILE/extensions/$EXT_ID.xpi"
printf '%s\n' "$REPO/extension" > "$PROFILE/extensions/$EXT_ID"

# Prefs.
touch "$PROFILE/user.js"
add_pref() {
  grep -q "\"$1\"" "$PROFILE/user.js" || printf 'user_pref("%s", %s);\n' "$1" "$2" >> "$PROFILE/user.js"
}
grep -q "Firefox Agent Bridge" "$PROFILE/user.js" || printf '\n// Firefox Agent Bridge (unsigned privileged extension, installed from %s)\n' "$REPO/extension" >> "$PROFILE/user.js"
add_pref xpinstall.signatures.required false
add_pref extensions.experiments.enabled true
add_pref extensions.autoDisableScopes 14

# Claude Code MCP server.
if command -v claude >/dev/null && ! claude mcp get firefox >/dev/null 2>&1; then
  claude mcp add --scope user firefox -- "$NODE" "$REPO/mcp/server.mjs"
fi

echo "Installed into $PROFILE"
echo "Start Firefox Developer Edition, then restart Claude Code sessions to pick up the firefox MCP server."
