# Firefox Agent Bridge

Browser tools for Claude Code that drive Firefox Developer Edition the way Claude in Chrome
drives Chrome, running on your Claude subscription through Claude Code.

Unofficial. Not affiliated with Anthropic or Mozilla.

![Claude Code searching Wikipedia and drawing a diagram in a background Firefox tab](docs/demo.gif)

- Tabs live in a per-session **Claude** tab group and stay in the background. Nothing takes
  focus, and the OS cursor never moves. Tabs a page opens (`target=_blank`, `window.open`)
  join the group, focus is handed back to your tab, and the click result names the new tab.
- Clicks and keys are **trusted** (`isTrusted: true`, with user activation), including inside
  cross-origin iframes.
- A cursor shows where Claude is pointing and clicking, with a ripple on each click. It's
  drawn as anonymous content, so the page can't see it or hit it, and it's hidden while
  screenshots are taken.
- Page scripts run without being blocked by the page's CSP. File inputs are filled directly,
  without opening a native picker.

## How it works

```
Claude Code ──stdio MCP──▶ mcp/server.mjs ──unix socket──▶ host/host.mjs ──native messaging──▶ extension
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
as `mcp__firefox__<name>`.

Differences from Chrome:

- `find` matches keywords over element names, roles, labels and attributes. It doesn't call a
  model, so use words that appear on the page.
- `read_page` and `find` only walk the top frame. Clicks and typing by coordinate reach into any
  frame.
- There is no `gif_creator`, console reading, network reading or shortcuts.

## Safety controls

The toolbar button shows what agents are doing, and its popup is where you control them.

- **Badge.** `?` (amber) means a client is waiting for your approval, `RUN` (blue) means an agent
  acted in the last few seconds, and `||` (grey) means sessions are paused. No badge means idle.
- **Stop.** The Stop button in the popup, or **Alt+Shift+X** from anywhere in Firefox (rebind it
  in about:addons), pauses every session. Waiting and running calls are answered at once, and
  sessions that haven't started yet start paused. Resume each session from the popup, or all of
  them at once. Stop doesn't undo work already under way: a click or page load that has started
  still finishes, but its result is dropped.
- **Takeover.** Switching to a tab in a session's group means you're taking over, so that
  session pauses and its group is renamed "Claude (paused)". Tabs the extension or a session
  page brings forward don't count. Resume it from the popup when you're done.
- **Per-client consent.** Each client connecting to the socket announces a name, version, pid and
  working directory. The first call from a name you haven't allowed waits up to 45s for you to
  choose Allow or Deny in the popup, then fails. Allowed names are remembered. Denied names stay
  denied until Firefox restarts (or you click Forget). Revoke removes a name and disconnects its
  clients. The name is self-reported, so check the pid and folder before you allow it.
- **Activity log.** The popup lists the last 100 of up to 500 calls: time, session, client,
  tool, action, tab, page origin, outcome and duration. It can be filtered by session, copied as
  JSON, or cleared, and it is lost when Firefox restarts. It never records typed text, key
  sequences, form values, script source, find queries, file paths or full URLs, only their
  length or count. Error messages have those values cut out, and script errors keep only the
  error type.

Paused and refused calls fail with a message telling the agent to ask you to resume or allow it.

## Security

- Signature checks are off for the whole profile, so use a separate Developer Edition profile.
- Your consent in the popup is the main control. `~/.firefox-agent-bridge/bridge.sock` is mode
  0600 in a 0700 directory, so only processes running as your user can connect, and each one has
  to be allowed by name before its calls run.
- There is no shared-secret token on the socket. Any process that can reach the socket runs as
  your user and could read a token file just as easily, so a token would add nothing. Names are
  self-reported, so an allowed name can be reused by another program running as you.
- `javascript_tool` runs in the page and ignores its CSP.

## Install

Requires macOS, Firefox Developer Edition 140+, Node and Claude Code.

1. Quit Firefox Developer Edition.
2. Run `scripts/install.sh [profile-dir]`. With no argument, it picks the Developer Edition
   default profile.
3. Start Firefox Developer Edition, then start a new Claude Code session.

The install script:

- writes the native host manifest to `~/Library/Application Support/Mozilla/NativeMessagingHosts/firefox_agent_bridge.json`
- writes a proxy file at `<profile>/extensions/firefox-agent-bridge@local` that points at `extension/`
- adds `xpinstall.signatures.required=false`, `extensions.experiments.enabled=true` and
  `extensions.autoDisableScopes=14` to `user.js`
- runs `claude mcp add --scope user firefox`

## Development

- Edit the files under `extension/`, then run `scripts/restart-firefox.sh`, which restarts Firefox with `-purgecaches`. Firefox caches
  the experiment schema, and content processes cache the actor modules.
- Test a single tool without a Claude session:
  `node scripts/ffctl.mjs navigate '{"url":"example.com"}' my-session`
- Run the tests without Firefox: `node scripts/test-bridge.mjs` starts the native host and plays
  the extension's side against the MCP server, `ffctl` and raw socket clients, and
  `node --test extension/test/*.test.js` runs the extension's policy and wiring tests against a
  mocked `browser`.
- Logs are in `~/.firefox-agent-bridge/host.log`. Screenshots saved with `save_to_disk` go to
  `~/.firefox-agent-bridge/screenshots/`.

## Caveats

- This only works in Developer Edition (or Nightly). Release Firefox won't load unsigned
  experiments.
- It relies on internal Firefox APIs: JSWindowActors, the pres-shell dispatch helper and
  nsITextInputProcessor. A Developer Edition update could break it. If one does, check
  `host.log` and the Browser Console first.
- Sessions don't survive a browser restart. Claude tab groups that session restore brings back
  are kept, renamed "Claude (earlier)" and greyed out, so staged work survives; close them when done.

## Further reading

- [What WebDriver BiDi would need to cover this bridge](docs/bidi-gap-map.md)

## License

[MPL-2.0](LICENSE)
