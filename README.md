# Firefox Agent Bridge

Browser tools that let MCP clients (Claude Code, the Codex CLI and app, the Claude desktop app)
drive Firefox Developer Edition the way Claude in Chrome drives Chrome, running on your existing
agent subscription.

Unofficial. Not affiliated with Anthropic, OpenAI or Mozilla.

![Claude Code searching Wikipedia and drawing a diagram in a background Firefox tab](docs/demo.gif)

- Tabs live in a per-session tab group named after the client (**Claude**, **Codex**, ...; a
  second session from the same client gets "Codex 2") and stay in the background. Nothing takes
  focus, and the OS cursor never moves. Tabs a page opens (`target=_blank`, `window.open`)
  join the group, focus is handed back to your tab, and the click result names the new tab.
- Clicks and keys are **trusted** (`isTrusted: true`, with user activation), including inside
  cross-origin iframes.
- A cursor shows where the agent is pointing and clicking, with a ripple on each click. It's
  drawn as anonymous content, so the page can't see it or hit it, and it's hidden while
  screenshots are taken.
- Page scripts run without being blocked by the page's CSP. File inputs are filled directly,
  without opening a native picker.

## How it works

```
MCP client ──stdio MCP──▶ mcp/server.mjs ──unix socket──▶ host/host.mjs ──native messaging──▶ extension
                                                                                                 │
                                          background.js (tools, tab groups, screenshots) ◀───────┘
                                                   │ browser.claudePage (experiment API, parent process)
                                                   ▼
                                    ClaudePage JSWindowActor (content process, every frame)
```

Firefox extensions have no `chrome.debugger`, so ordinary extension code can only dispatch
untrusted events. This extension ships a **WebExtension Experiment**: privileged code that
Developer Edition can load when signatures are off. It registers a JSWindowActor. The actor
creates events in chrome code and dispatches them through the pres shell
(`windowUtils.dispatchDOMEventViaPresShellForTesting`), and it types with
`nsITextInputProcessor`. The page therefore receives the events as real input.

Other details:

- **Actor modules.** Content processes can't read `~/Code`, so the actor modules are copied into
  `<profile>/chrome/firefox-agent-bridge/` at startup and served from a `resource://` alias.
- **Background tabs.** Normally hidden tabs don't render and IntersectionObserver never fires,
  so lazy lists stay empty. Session tabs are therefore marked active (`docShellIsActive`)
  without being shown.
- **Screenshots.** `tabs.captureTab` works on background tabs. Images are scaled to at most
  1568px on the long edge and 1.15 MP. Coordinates are mapped back to CSS pixels.

## Tools

These have the same names and arguments as Claude in Chrome: `tabs_context_mcp`,
`tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `computer`, `read_page`, `find`,
`form_input`, `javascript_tool`, `file_upload` and `get_page_text`. In Claude Code they show up
as `mcp__firefox__<name>`; Codex lists them under `mcp__firefox`.

Differences from Chrome:

- `find` matches keywords over element names, roles, labels and attributes. It doesn't call a
  model, so use words that appear on the page.
- `read_page` and `find` only walk the top frame. Clicks, typing and scrolling by coordinate reach
  into any frame; a scroll over a frame that can't scroll scrolls the page around it.
- There is no `gif_creator`, console reading, network reading or shortcuts.

## Safety controls

The toolbar button shows what agents are doing, and its popup is where you control them. Calls
run without a consent prompt, and switching to a session's tab doesn't pause it; you see every
client and call, and Stop or Disconnect cuts them off.

- **Badge.** `RUN` (blue) means an agent is acting or acted in the last few seconds, and `||`
  (grey) means sessions are paused. No badge means idle.
- **Stop.** The Stop button in the popup, or **Alt+Shift+X** from anywhere in Firefox (rebind it
  in about:addons), pauses every session. Running calls are answered at once, and
  sessions that haven't started yet start paused. Resume each session from the popup, or all of
  them at once. Stop doesn't undo work already under way: a click or page load that has started
  still finishes, but its result is dropped. Paused groups get " (paused)" added to their title.
- **Clients.** Each client connecting to the socket announces a name, version, pid and working
  directory, and its calls run right away. The popup lists every connection with those details,
  when it connected and how many calls it made. The name is self-reported, so check the pid and
  folder. **Disconnect** closes that connection, stops its calls in progress and blocks the name:
  calls from any client using it, reconnects included, fail at once until you click **Unblock**
  or restart Firefox.
- **Activity log.** The popup lists the last 100 of up to 500 calls: time, session, client,
  tool, action, tab, page origin, outcome and duration. It can be filtered by session, copied as
  JSON, or cleared, and it is lost when Firefox restarts. It never records typed text, key
  sequences, form values, script source, find queries, file paths or full URLs, only their
  length or count. Error messages have those values cut out, and script errors keep only the
  error type.

Paused and blocked calls fail with a message telling the agent to ask you, not to retry.

## Security

- Signature checks are off for the whole profile, so use a separate Developer Edition profile.
- `~/.firefox-agent-bridge/bridge.sock` is mode 0600 in a 0700 directory, so only processes
  running as your user can connect. Any of them can drive the browser; the popup shows who is
  connected and what they did, and Stop and Disconnect cut them off.
- There is no shared-secret token on the socket. Any process that can reach the socket runs as
  your user and could read a token file just as easily, so a token would add nothing. Names are
  self-reported, so a blocked name can be dodged by another program running as you.
- `javascript_tool` runs in the page and ignores its CSP.

## Install

Requires macOS or Linux, Firefox Developer Edition 140+, Node, and an MCP client.

1. Quit Firefox Developer Edition.
2. Run `scripts/install.sh [options] [profile-dir]`. With no profile dir, it picks the Developer
   Edition default profile, looking in `~/Library/Application Support/Firefox` on macOS and in
   `~/.config/mozilla/firefox` (Firefox 147+) and `~/.mozilla/firefox` on Linux.
   - `--claude-code` registers with Claude Code. This is the default when no client is named.
   - `--codex` registers with Codex; the CLI and the app share `~/.codex/config.toml`.
   - `--claude-desktop` registers with the Claude desktop app.
   - `--all` registers with every one of these that is installed.
   - `--no-clients` only installs into Firefox; `--clients-only` only registers clients.
   - `--help` lists them. Re-running is safe.
3. Start Firefox Developer Edition, then start a new session in your MCP client (restart the
   Claude desktop app).

The install script:

- writes the native host manifest to `~/Library/Application Support/Mozilla/NativeMessagingHosts/`
  (macOS) or `~/.mozilla/native-messaging-hosts/` (Linux), with a launcher that pins your node
- writes a proxy file at `<profile>/extensions/firefox-agent-bridge@local` that points at `extension/`
- adds `xpinstall.signatures.required=false`, `extensions.experiments.enabled=true` and
  `extensions.autoDisableScopes=14` to `user.js`
- registers the `firefox` MCP server with the selected clients (`claude mcp add --scope user`,
  `codex mcp add` or `~/.codex/config.toml`, `claude_desktop_config.json`), keeping a `.bak` of
  any config file it rewrites

### Codex tool approval

Codex asks before each MCP tool call. With `approval_policy = "never"` it refuses them instead,
so every browser call fails. To let this server's tools run, add to `~/.codex/config.toml`:

```toml
[mcp_servers.firefox]
default_tools_approval_mode = "approve"
```

### Using it with Codex without a ChatGPT subscription

Codex can run on either of these instead:

- **An OpenAI API key**, billed per use: `printenv OPENAI_API_KEY | codex login --with-api-key`.
- **A local model**: start Ollama or LM Studio with a model, then run
  `codex --oss --local-provider ollama` (or `lmstudio`), adding `-m <model>` to pick one. Small
  local models are much weaker at multi-step browser tasks than hosted ones.

## Development

- Edit the files under `extension/`, then run `scripts/restart-firefox.sh`, which restarts
  Firefox with `-purgecaches` and waits for the bridge. Firefox caches the experiment schema, and
  content processes cache the actor modules. On Linux it looks for `firefox-developer-edition`
  or `firefox-devedition` on PATH, `~/firefox/firefox` and `/opt/firefox-developer-edition`; set
  `FIREFOX_BIN=/path/to/firefox` otherwise.
- Test a single tool without an agent session:
  `node scripts/ffctl.mjs navigate '{"url":"example.com"}' my-session`
- Tests:
  - `node --test extension/test/*.test.js` runs the extension's policy and wiring tests against
    a mocked `browser`.
  - `node scripts/test-bridge.mjs` starts the native host and plays the extension's side
    against the MCP server, `ffctl` and raw socket clients.
  - `FIREFOX_BIN=/path/to/firefox node scripts/test-firefox.mjs` runs the whole stack in a real
    Firefox (Linux, needs Xvfb). It installs into a fresh profile under a temp HOME and drives a
    local test page and the popup through `mcp/server.mjs`.
  - `FIREFOX_BIN=/path/to/firefox CODEX_BIN=/path/to/codex node scripts/test-codex.mjs` does the
    same with the Codex CLI as the client, driven by a scripted fake model, so it needs no
    OpenAI account.
  - The last two save screenshots to `SHOTS_DIR` (default `<tmpdir>/firefox-agent-bridge-shots`);
    `KEEP=1` keeps their temp dir.
- Logs are in `~/.firefox-agent-bridge/host.log`. Screenshots saved with `save_to_disk` go to
  `~/.firefox-agent-bridge/screenshots/`.

## Caveats

- This only works in Developer Edition (or Nightly). Release Firefox won't load unsigned
  experiments.
- It relies on internal Firefox APIs: JSWindowActors, the pres-shell dispatch helper and
  nsITextInputProcessor. A Developer Edition update could break it. If one does, check
  `host.log` and the Browser Console first.
- Sessions don't survive a browser restart. Session tab groups that session restore brings back
  are kept, renamed "<name> (earlier)" (e.g. "Codex (earlier)") and greyed out, so staged work
  survives; close them when done. A group of your own with exactly the title of a label the
  extension has used (e.g. "Codex") is treated the same way.

## Further reading

- [What WebDriver BiDi would need to cover this bridge](docs/bidi-gap-map.md)

## License

[MPL-2.0](LICENSE)
