#!/bin/sh
# Installs Firefox Agent Bridge into a Firefox Developer Edition profile:
#   - native messaging host manifest + launcher
#   - the extension, as an unpacked proxy install (edits in extension/ apply on restart)
#   - the prefs that let an unsigned privileged extension load
#   - the "firefox" MCP server for the selected MCP clients
#
# Usage: scripts/install.sh [options] [profile-dir]
#   --claude-code      register with Claude Code (user scope; its desktop app and IDEs share it)
#   --codex            register with Codex (~/.codex/config.toml; the CLI and desktop app share it)
#   --claude-desktop   register with the Claude desktop app (claude_desktop_config.json)
#   --all              every client above that is installed
#   --clients-only     only register clients; leave Firefox alone (alias: --no-firefox)
#   --no-clients       only install into Firefox; register no MCP client
# With no client flags, registers with Claude Code only. Safe to re-run.
# Quit Firefox Developer Edition first; prefs are read at startup.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT_ID="firefox-agent-bridge@local"
HOST_NAME="firefox_agent_bridge"
SERVER="$REPO/mcp/server.mjs"

usage() { sed -n '8,16p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "$*" >&2; exit 1; }

FIREFOX=1 CLIENTS=1 CLAUDE_CODE='' CODEX='' DESKTOP='' ALL='' PROFILE=''
for arg in "$@"; do
  case "$arg" in
    --claude-code) CLAUDE_CODE=1 ;;
    --codex) CODEX=1 ;;
    --claude-desktop) DESKTOP=1 ;;
    --all) ALL=1 ;;
    --clients-only | --no-firefox) FIREFOX='' ;;
    --no-clients) CLIENTS='' ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "Unknown option: $arg" ;;
    *) [ -z "$PROFILE" ] || die "Only one profile dir can be given."; PROFILE="$arg" ;;
  esac
done
[ -n "$FIREFOX$CLIENTS" ] || die "--no-clients and --clients-only together leave nothing to do."
[ -n "$CLIENTS" ] || [ -z "$CLAUDE_CODE$CODEX$DESKTOP$ALL" ] || die "--no-clients can't be combined with client flags."
[ -z "$CLIENTS" ] || [ -n "$CLAUDE_CODE$CODEX$DESKTOP$ALL" ] || CLAUDE_CODE=1

# Browsers and desktop apps launch these with a minimal environment, so pin the real node
# binary (process.execPath sees through version-manager shims).
NODE="${NODE:-$(node -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)}"
[ -x "$NODE" ] || die "node not found; install Node or set NODE=/path/to/node."

case "$(uname -s)" in
  Darwin)
    OS=mac
    FF_ROOTS="$HOME/Library/Application Support/Firefox"
    NMH_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    DESKTOP_DIR="$HOME/Library/Application Support/Claude"
    ;;
  Linux)
    OS=linux
    # Firefox 147+ puts new profiles under XDG_CONFIG_HOME; older installs use ~/.mozilla.
    FF_ROOTS="${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/firefox
$HOME/.mozilla/firefox"
    # Native manifests are read from ~/.mozilla even with XDG profiles.
    NMH_DIR="$HOME/.mozilla/native-messaging-hosts"
    DESKTOP_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Claude"
    ;;
  *) die "Unsupported OS: $(uname -s)" ;;
esac

# Prints the Developer Edition profile under a Firefox root: the default profile of a
# dev-edition install, else the profile named dev-edition-default.
find_profile() {
  [ -f "$1/profiles.ini" ] || return 0
  p="$({ cat "$1/installs.ini" 2>/dev/null || true; echo; cat "$1/profiles.ini"; } | awk '
    { sub(/\r$/, ""); k = $0; sub(/=.*/, "", k); v = $0; sub(/^[^=]*=/, "", v) }
    /^\[/ { prof = ($0 ~ /^\[Profile/); inst = !prof && $0 !~ /^\[General/; name = ""; path = ""; next }
    inst && k == "Default" && v ~ /dev-edition/ && found == "" { found = v }
    prof && k == "Name" { name = v }
    prof && k == "Path" { path = v }
    prof && name == "dev-edition-default" && path != "" && named == "" { named = path }
    END { print (found != "" ? found : named) }')"
  [ -n "$p" ] || return 0
  case "$p" in /*) echo "$p" ;; *) echo "$1/$p" ;; esac
}

# True if Firefox has this profile open.
profile_in_use() {
  if [ "$OS" = linux ]; then
    # While the profile is open, its lock symlink points at "<ip>:+<pid>".
    target="$(readlink "$1/lock" 2>/dev/null)" || return 1
    kill -0 "${target##*+}" 2>/dev/null
  else
    pgrep -f "Firefox Developer Edition.app/Contents/MacOS/firefox" >/dev/null
  fi
}

add_pref() {
  grep -q "\"$1\"" "$PROFILE/user.js" || printf 'user_pref("%s", %s);\n' "$1" "$2" >> "$PROFILE/user.js"
}

install_firefox() {
  if [ -z "$PROFILE" ]; then
    PROFILE="$(echo "$FF_ROOTS" | while IFS= read -r root; do
      p="$(find_profile "$root")"
      [ -z "$p" ] || { echo "$p"; break; }
    done)"
    [ -n "$PROFILE" ] || die "No Developer Edition profile found in profiles.ini under:
$FF_ROOTS
Pass the profile dir (about:profiles shows it)."
  fi
  [ -d "$PROFILE" ] || die "Profile dir not found: $PROFILE"
  ! profile_in_use "$PROFILE" || die "Quit Firefox Developer Edition first."

  LAUNCHER="$REPO/host/firefox-agent-bridge-host"
  cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$NODE" "$REPO/host/host.mjs" "\$@"
EOF
  chmod +x "$LAUNCHER"

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
  grep -q "Firefox Agent Bridge" "$PROFILE/user.js" || printf '\n// Firefox Agent Bridge (unsigned privileged extension, installed from %s)\n' "$REPO/extension" >> "$PROFILE/user.js"
  add_pref xpinstall.signatures.required false
  add_pref extensions.experiments.enabled true
  add_pref extensions.autoDisableScopes 14

  echo "Firefox: installed into $PROFILE"
  echo "  native host manifest: $NMH_DIR/$HOST_NAME.json"
}

register_claude_code() {
  if ! command -v claude >/dev/null; then
    echo "Claude Code: skipped, claude is not on PATH."
    return
  fi
  current="$(claude mcp get firefox 2>/dev/null || true)"
  if printf '%s\n' "$current" | grep -qxF "  Command: $NODE" && printf '%s\n' "$current" | grep -qxF "  Args: $SERVER"; then
    echo "Claude Code: already registered."
    return
  fi
  # Replace a stale user-scope entry (another node or checkout path).
  claude mcp remove --scope user firefox >/dev/null 2>&1 || true
  claude mcp add --scope user firefox -- "$NODE" "$SERVER" >/dev/null
  echo "Claude Code: registered (user scope)."
}

register_codex() {
  if command -v codex >/dev/null; then
    # Replaces an existing entry of the same name.
    codex mcp add firefox -- "$NODE" "$SERVER" >/dev/null 2>&1 || die "Codex: codex mcp add failed."
    echo "Codex: registered."
    return
  fi
  file="${CODEX_HOME:-$HOME/.codex}/config.toml"
  mkdir -p "$(dirname "$file")"
  # Drop any existing [mcp_servers.firefox] table and its subtables, keep the rest.
  "$NODE" - "$file" "$NODE" "$SERVER" <<'EOF'
const fs = require("fs");
const [file, node, server] = process.argv.slice(2);
let text = "";
try { text = fs.readFileSync(file, "utf8"); } catch {}
const kept = [];
let skip = false;
for (const line of text.split("\n")) {
  const header = line.match(/^\s*\[\[?([^\]]+)\]\]?/);
  if (header) skip = /^mcp_servers\.("firefox"|firefox)(\.|$)/.test(header[1].replace(/\s+/g, ""));
  if (!skip) kept.push(line);
}
const rest = kept.join("\n").replace(/\s+$/, "");
const table = `[mcp_servers.firefox]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(server)}]\n`;
const next = (rest ? rest + "\n\n" : "") + table;
if (next === text) process.exit(0);
if (text) fs.writeFileSync(file + ".bak", text);
fs.writeFileSync(file, next);
EOF
  echo "Codex: codex not on PATH; wrote [mcp_servers.firefox] to $file."
}

register_claude_desktop() {
  file="$DESKTOP_DIR/claude_desktop_config.json"
  mkdir -p "$DESKTOP_DIR"
  "$NODE" - "$file" "$NODE" "$SERVER" <<'EOF' || die "Claude desktop: could not update $file."
const fs = require("fs");
const [file, node, server] = process.argv.slice(2);
let text = "";
let config = {};
try {
  text = fs.readFileSync(file, "utf8");
  if (text.trim()) config = JSON.parse(text);
} catch (e) {
  if (e.code !== "ENOENT") { console.error(`${file}: ${e.message}`); process.exit(1); }
}
config.mcpServers = { ...config.mcpServers, firefox: { command: node, args: [server] } };
const next = JSON.stringify(config, null, 2) + "\n";
if (next === text) process.exit(0);
if (text) fs.writeFileSync(file + ".bak", text);
fs.writeFileSync(file, next);
EOF
  echo "Claude desktop: registered in $file (restart the app to pick it up)."
}

[ -z "$FIREFOX" ] || install_firefox

if [ -z "$CLIENTS" ]; then
  :
elif [ -n "$ALL" ]; then
  register_claude_code
  if [ -n "$CODEX" ] || command -v codex >/dev/null || [ -d "${CODEX_HOME:-$HOME/.codex}" ]; then
    register_codex
  else
    echo "Codex: skipped, not installed."
  fi
  if [ -n "$DESKTOP" ] || [ -d "$DESKTOP_DIR" ]; then
    register_claude_desktop
  else
    echo "Claude desktop: skipped, $DESKTOP_DIR not found."
  fi
else
  [ -z "$CLAUDE_CODE" ] || register_claude_code
  [ -z "$CODEX" ] || register_codex
  [ -z "$DESKTOP" ] || register_claude_desktop
fi

[ -z "$FIREFOX" ] || echo "Start Firefox Developer Edition, then restart your MCP clients to pick up the firefox server."
