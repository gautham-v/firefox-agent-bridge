# Chat panel

A Claude-in-Chrome style chat in Firefox's sidebar. Clicking the toolbar button toggles the
sidebar. The first message binds the chat to the tab you're viewing: that tab joins a new tab
group named after the engine ("Claude", "Claude 2", ...), and the agent works in that group.
Tabs you drag into the group become visible to the agent on the next message.

The chat runs Claude Code headless on the user's own plan (`claude -p` with stream-json in and
out), or Codex (`codex exec --json`). The native host spawns and owns those processes. The agent
reaches Firefox through the same `firefox` MCP server as terminal sessions, with its bridge
session id pinned to the chat id so its calls land in the chat's tab group.

Out of scope for now: turning connectors on and off per chat, and voice input.

## Pieces

| File | Role |
| --- | --- |
| `extension/sidebar/panel.{html,css,js}` | The chat UI. Also opened in a popup window by "Pop out". |
| `extension/sidebar/fanout.js` | Groups a turn's steps into one row per sub-agent for the steps card. |
| `extension/background.js` | Toggles the sidebar, relays chat messages between panels and the host, binds chats to tab groups, watches group membership, buffers chat events for panels that reconnect, and works out each chat group's state icon. |
| `host/chat.mjs` (used by `host/host.mjs`) | Spawns and drives engine processes, normalizes their output, answers permission prompts, lists history and capabilities. |
| `mcp/server.mjs` | Uses `FIREFOX_AGENT_BRIDGE_SESSION` from its environment as the session id when set. |

## Engine processes (host)

- Working directory: `~/.firefox-agent-bridge/chat/` (created 0700). Uploads go to
  `~/.firefox-agent-bridge/chat/uploads/<chatId>/`.
- Claude Code: one long-lived `claude -p --input-format stream-json --output-format stream-json
  --verbose --include-partial-messages` process per chat, with `--session-id <chatId>` on the first
  run and `--resume <chatId>` afterwards. `--model` and `--effort` come from the message: an empty string
  (or one that isn't a valid model id or effort) resets to the engine's default, a missing field
  leaves the last value, and a stored value from the other engine (a Codex model, Claude's `max`)
  is never passed on. A change of engine, model or effort restarts the process with `--resume`.
  Environment: `FIREFOX_AGENT_BRIDGE_SESSION=<chatId>`. Memory (the ⋯ menu's Memory, below): a
  new chat uses the auto-memory of the chosen project, passed as `autoMemoryDirectory` in
  `--settings`; a resumed terminal session keeps its own project's; Off sets
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. The same `--settings` pre-allows reading any project's
  memory (`~/.claude/projects/*/memory/**`) and adds `ask` rules for Write, Edit and MultiEdit
  there: Claude Code writes its memory folder without asking, and a page the agent reads could
  otherwise plant a note that steers later sessions, terminal ones included. A memory write's card
  shows the path and what would be written; one too long to show whole is denied. An appended system prompt says the agent runs in the
  Firefox sidebar, that the user's tabs are in its tab group (use `tabs_context_mcp`, work in those
  tabs rather than opening new ones unless needed), that it can link a page element as
  `[label](ref:ref_N)` (or `ref:<tabId>/ref_N` for a tab other than the one it last used), and to
  keep answers short. Claude's also says when and how to fan out to sub-agents (README,
  "Fan-out"); Codex's doesn't. The firefox MCP
  server is passed explicitly with `--mcp-config` (the host's node, this checkout's
  `mcp/server.mjs`, session env pinned); an entry there replaces a user-scope server of the same
  name, so there is no duplicate and chats work even if the server was never registered with
  Claude Code. The user's own default permission mode is overridden with `--permission-mode default`,
  or `bypassPermissions` when the ⋯ menu's permissions are set to Don't ask (which also ignores
  the memory `ask` rules).
- Settings: the ⋯ menu's Claude Code permissions (Ask before acting / Don't ask) and Memory (a
  project whose memory panel chats share, or Off) are kept by the host in
  `~/.firefox-agent-bridge/chat/settings.json` (`{permissions: "ask" | "bypass", memory: null |
  "off" | "<memory folder>"}`, null being the home folder's). Memory offers every project in
  `~/.claude/projects/` with at least one note, labeled with the folder its sessions ran in (or,
  with none left, a folder on disk that encodes to its name). A change restarts each chat's
  process with `--resume` on its next message.
- A message with a `skill` runs it as a user-invoked skill. Claude Code: the text is
  `/<skill> <typed text>` followed by the context block (`claude -p` runs a message that starts
  with `/name` as that skill, the rest being its arguments; the session file then records it as
  `<command-name>` markup, which history reads back into `user` + `skill`). Codex has no slash
  skills, so the prompt starts with a line telling it to read `~/.codex/skills/<skill>/SKILL.md`.
  Neither engine makes a Skill tool call, so the host emits a `Skill` `tool_start`/`tool_end` pair
  itself for the steps card. A skill's `sites` are read from the `sites:` line of the frontmatter
  in `~/.claude/skills/<name>/SKILL.md` (or Codex's folder); the panel does the matching.
- Every user message is prefixed with a `<panel-context>...</panel-context>` block (the group's
  tabs, the elements the user Alt+clicked as `- tab <id>, <ref>: <role> "<name>", text: "..."`,
  and the paths of attached files that weren't sent inline). It is stripped again when a
  transcript is loaded. Images (png, jpeg, gif, webp, up to about 3.5 MB) go inline as base64
  image blocks; other attachments are written to `uploads/<chatId>/`.
- Sub-agents (the Task tool, `Agent` in newer Claude Code) run in the same process: their
  stream-json messages carry `parent_tool_use_id`, the id of the Task call. Their tool calls are
  passed on as `tool_start` / `tool_end` with `parent` set to that id; their text and streamed
  deltas are not. They reach Firefox through the chat's own MCP server, so their tabs are in the
  chat's group, and their permission requests come to the panel like the agent's.
- Permissions: only the firefox MCP tools, Skill, TodoWrite and Task/Agent are pre-allowed. Everything else
  is what Claude Code would ask about in a terminal, and is asked in the panel through its stdio
  permission prompt (control protocol: a `can_use_tool` control request, answered with a
  `control_response` of `{behavior: "allow" | "deny"}`), with Allow once / Always allow in this chat
  / Deny. That includes reads outside the chat folder, WebFetch and WebSearch: a page the agent
  reads could try to steer them. Claude Code itself still auto-allows reads inside the chat folder
  and read-only shell commands (`echo hi` is never prompted; `touch x` is).
  The card shows what would run: a Bash command as written, a file or URL in full, any other tool
  (a connector's) as its `key: value` inputs. A Bash command over 2000 characters is denied with a
  message instead of being shown clipped, and any other input that had to be clipped gets no
  Always button (`always: false`).
  Always allow is remembered in the host, per chat, and never wider than what was approved. Bash:
  the rules Claude Code suggested (an exact command, or `prefix:*`, which matches the prefix
  alone or followed by a space and never a command containing `;`, `&`, `|`, backticks, `$(`,
  redirects or newlines), else the exact command; never the whole tool. Write, Edit and the other
  file tools: the exact resolved path (Claude Code suggests no rule for them). Other tools: the
  rule Claude Code suggested (a connector tool's whole tool, a WebFetch `domain:host`), and with
  none, Allow once only. `AskUserQuestion` is denied automatically, with a note to ask in plain
  text.
- A message sent while a turn is running is queued behind it (Claude Code queues it in the same
  process; for Codex it waits for the running process to exit). Changing engine mid-turn ends the
  running turn as interrupted.
- Stop in the panel sends an interrupt (control request) to the running turn. The turn ends with a
  `result` whose `ok` is false and `error` is "Interrupted" (no `error` event), and the process
  stays usable. A permission card still open when a turn ends is resolved by the panel.
- Idle processes exit after 10 minutes; the next message resumes them, and one sent while the old
  process is still shutting down waits for it to close first (both use the session file).
- Codex: one `codex exec --json` process per turn (prompt on stdin), `codex exec resume <thread id>`
  afterwards; the thread id is kept in `chat/chats.json` beside the uploads. Sandbox is
  read-only with `approval_policy="never"` (exec mode can't ask), the firefox server is passed
  with `-c mcp_servers.firefox={...env={FIREFOX_AGENT_BRIDGE_SESSION=...}, default_tools_approval_mode="approve"}`,
  and the system prompt goes in `developer_instructions`. Codex streams whole messages, so there
  are `text` events but no `text_delta`, and no permission prompts. Codex's models and efforts come
  from `codex debug models`.
- Codex images go as `--image=<file>` (a bare `-i` takes the arguments after it too, including
  the `-` that marks the prompt on stdin).
- The `claude` and `codex` binaries are found from `CLAUDE_BIN` / `CODEX_BIN` (written into the
  host launcher by `install.sh`), then common install paths, then a login shell's `command -v`.

## Native messaging (extension <-> host)

All chat messages have `type` starting with `chat.`. Host-to-extension messages must stay under
1 MB each (Firefox closes the connection over 1 MiB), so transcripts are sent in chunks measured in
bytes, tool results are summarized (never forwarded whole, no screenshots), an event's `text` is
cut to fit (the echoed `user` text is clipped to 200,000 characters), and `host.mjs` refuses any
message over 1,000,000 bytes (an MCP call that big gets an error result) instead of sending it.

Extension to host:

| Message | Fields |
| --- | --- |
| `chat.send` | `chatId` (`[\w-]{1,64}`), `engine` (`claude` \| `codex`), `model`, `effort` (empty string: the default), `text`, `attachments: [{name, mime, data}]` (base64), `skill` (name of a skill picked in the panel, else null), `context: {tabs: [{tabId, title, url, current}], elements?: [{tabId, ref, role, name, text}]}` (`elements` only when the user picked some), `resume` (true when reopening a chat from history) |
| `chat.interrupt` | `chatId` |
| `chat.permission` | `chatId`, `requestId`, `decision` (`allow` \| `allow_always` \| `deny`) |
| `chat.close` | `chatId` (kill its process) |
| `chat.history` | `requestId` |
| `chat.load` | `requestId`, `chatId`, `source` (`panel` \| `terminal`), `path` for terminal sessions |
| `chat.capabilities` | `requestId`, `engine` |
| `chat.settings` | `requestId`, `set?: {permissions?, memory?}` (a memory folder outside `~/.claude/projects/*/memory` is ignored) |
| `teach.save` | Teach's Save and Try it once ([docs/teach.md](teach.md)): `requestId`, `chatId`, `engine`, `mode`, `draft`, `recording`, `replay`, `replace`, `shots` |

Host to extension:

| Message | Fields |
| --- | --- |
| `chat.event` | `chatId`, `event` (below) |
| `chat.history` | `requestId`, `chats: [{id, title, updatedAt, engine, model, source, origin?, cwd, path, running}]`, newest first; `updatedAt` is epoch ms; `running` means a turn is in progress; `origin: "phone"` marks a chat-folder session with a `bridge-session` entry, i.e. one started by `claude remote-control` (the panel shows "From phone"); `source: "terminal"` for Claude Code sessions outside the chat folder that used `mcp__firefox__` tools in the last 14 days (at most 30; panel chats at most 100) |
| `chat.transcript` | `requestId`, `chatId`, `items` (the same shapes as events, each with its `kind`: `user`, `text`, `tool_start`, `tool_end`, `result`), `done`; the last 1500 items, in chunks under 600 KB |
| `teach.saved` | `requestId`, `ok`, `dir`, `replayPath`, or `error` (and `exists` when a skill of that name is there) |
| `chat.settings` | `requestId`, `permissions`, `memory` (the folder in use, or `"off"`), `memories: [{dir, label, notes}]` |
| `chat.capabilities` | `requestId`, `engine`, `available`, `version`, `error`, `skills: [{name, description, sites}]`, `plugins: [{name}]`, `connectors: [{name, status}]`, `models: [{id, label, efforts?, default?}]`, `efforts` |

Capabilities cost no model tokens: for Claude Code the host asks a prompt-less `claude -p` for its
`initialize` and `mcp_status` control responses (skills are the non-built-in slash commands;
`connectors` are its MCP servers other than `firefox`, with Claude Code's own status strings such as
`connected`, `needs-auth`, `pending`, `failed`, and the `claude.ai ` prefix dropped), and runs
`claude plugin list --json`. `efforts` is the union for the engine, and a model's own `efforts`
narrows it (Haiku 4.5 has none). `default: true` marks the model a new chat starts with. Results
are cached for a minute, except that an engine that isn't available is asked again after two
seconds, so Try again after installing or signing in sees the change. Claude Code adds its claude.ai connectors a moment after start, so the host
asks `mcp_status` again (up to 8 times, a second apart) while the list is empty or has a `pending`
entry. When the engine is missing or signed out, `available` is false and
`error` says what to do; the model list is still returned. `chat.load` with `source: "terminal"`
only reads files under `~/.claude/projects/`, and `chatId` must be a plain id (`[\w-]{1,64}`, not
`__proto__` and the like) wherever it names a file or a registry entry.

Events (`chat.event`'s `event`):

| kind | Fields |
| --- | --- |
| `status` | `status`: `starting` \| `running` \| `idle` \| `exited` (`starting` when a process is spawned, `running` once the message is written, `idle` after each turn's result, `exited` when a Claude process ends) |
| `user` | `text`, `attachments: [{name, mime}]`, `skill` (only when one was picked) (echo, so every panel shows it) |
| `text_delta` | `messageId` (`<api message id>:<n>` for the nth text block), `text` |
| `text` | `messageId` (same scheme), `text` (full text of a finished assistant text block) |
| `tool_start` | `toolUseId`, `name` (e.g. `mcp__firefox__navigate`), `summary` (short, no typed text, form values, script source, key sequences or URL queries; `ToolSearch` is not reported), `tabId` (Firefox tools that name a tab; the steps card says "Using Firefox in <site>" from the latest one), `parent` (only on a sub-agent's calls: the `toolUseId` of its Task step) |
| `tool_end` | `toolUseId`, `ok`, `summary` (text only for failures, plus the first line of navigate and shell results, and a Task step's reply clipped to 300 characters without Claude Code's `agentId`/usage trailer; screenshots and page content never leave the host), `masked` (Firefox tools whose result masked sensitive fields: the extension's own content part, e.g. "3 fields masked on acme-supply.com"; the steps card shows the latest per site as a note with a lock) |
| `permission` | `requestId`, `tool`, `summary` (what would run, see Permissions), `always` (whether Always allow is offered; absent means yes) |
| `result` | `ok`, `durationMs`, `numTurns`, `error` (a short message when `ok` is false; every turn ends with one, including failed starts) |
| `error` | `code`: `not_found` \| `auth` \| `limit` \| `spawn` \| `crashed`, `message`, `resetsAt` (epoch ms when a usage limit lifts and the engine said so, else null) |
| `title` | `title` |

## Panel <-> background

The panel connects with `browser.runtime.connect({name: "sidebar"})` and first sends
`{cmd: "hello", windowId}`, optionally with `chatId` (a popped-out panel passes the `chat` from its
URL; `windowId` is the `window` from it, the window it was popped out of). Every panel message
carries its name in `cmd` and its fields beside it; every message to the panel carries `type`.
Background keeps, per window, the current chat id, and per chat the
list of events (capped), so a panel that closes and reopens gets the chat back.

Panel to background: `hello`, `chat.new`, `chat.open {chatId, source, path, engine, model}` (the
history row's own; the chat continues on that engine and model, and a terminal session is always
Claude's), `chat.send` (as above,
without `context` but with `elements`, the picked elements; background adds the group's tabs and
binds the chat first), `chat.interrupt`,
`chat.permission`, `chat.history {requestId}`, `chat.capabilities {requestId, engine}`, `chat.settings {requestId, set?}`,
`group.add {tabId}`, `teach.start`, `teach.stop {requestId, draft}`, `teach.discard`, `teach.save` (Teach, [docs/teach.md](teach.md); a `chat.send` with `teach: true` doesn't adopt the viewed tab),
`group.remove {tabId}`, `resume` (undoes Stop all agents: every paused session, and the pause on
new ones), `stopAll` (pauses Firefox calls and also sends `chat.interrupt` for every chat whose
turn is running; the Alt+Shift+X shortcut and the activity sheet's Stop do the same), `popout`,
`mark {tabId, ref, label, reveal, clear}` (outline an element the agent linked; only tabs in the
chat's group, and `reveal` switches to the tab), `point.clear` (Alt was let go in the panel),
`cam.frame {tabId, scale, requestId}` (an agent cam frame; only tabs in the chat's group).

Background to panel: `state {windowId, chatId, events, group, activeTab, paused, engine, model, effort, teach}`
on hello and on chat switches; `chat.event`, `chat.history`, `chat.transcript`,
`chat.capabilities`, `chat.settings` relayed; `group {chatId, label, color, tabs: [{tabId, title, url, favIconUrl, active}]}`
when membership or titles change (in `state`, a chat with no group yet has `label` and `color`
null and `tabs` empty); `activeTab {tab}` (same tab shape as in `group`, or null) when the window's active tab changes or
its title, URL or icon does;
`paused {paused}` when the chat's session is paused or resumed; `teach {recording | error}` and `teach.step {recordingId, step, shot}` for a Teach recording; `hostUp` when the native host
(re)connects, so a panel showing "not connected" asks for capabilities again; `pick {chatId,
element: {tabId, ref, role, name, text, image}}` when the user Alt+clicks an element (`image` is a
PNG data URL, or null); `markFailed {error}` when a clicked element link can't be shown;
`cam.frame {requestId, shot, masks | error}` answering the panel's, where `shot` is a JPEG data
URL and `masks` the masked fields in it as fractions of the viewport (`{x, y, width, height,
label}`), or null when a frame of the tab couldn't say (the panel then doesn't keep it for Save
as GIF).

Point and ask: background calls the experiment's `setPointTabs` with the active tab of every
window that has a panel open (web pages only), again when those change, and on `point.clear`.
In those tabs the actor (which registers for mouse and key events without creating itself, and
acts only in armed documents) outlines the element under the pointer while Alt alone is held,
shows the hint in the top frame, and on Alt+click swallows the pointer and click events and
reports the element through the parent actor (`claudePage.onPick`). A ref made in a child frame
carries the frame's browsing context id (`ref_7@f12`), and `claudePage.call` starts in that frame
for any op given one. Background crops the element from `tabs.captureTab` (its rect, moved by
where its frame's viewport sits relative to the top frame's, clipped to the viewport, with the
cursor and outlines hidden), adds the tab to the chat's group like `group.add`, and has the actor
show "Added to chat" on it. The panel sends the crop as an image attachment and the rest as
`elements`. Element links in replies render as chips; `ref:ref_N` points into the tab of the
turn's latest Firefox step.

Binding: on a chat's first `chat.send`, background creates the session entry for `chatId` with a
new group holding the window's active tab (labels as for MCP clients: "Claude", "Claude 2", ...).
If the chat already has a group, the message's context is that group's tabs, with `current` on the
tab the user is viewing.

Background answers `chat.history`, `chat.capabilities` and `chat.settings` itself when the host isn't connected
(`chats: []`; `available: false`, `hostDown: true` and `error`; `hostDown: true`), and a `chat.send` then gets an `error` event with
`code: "spawn"`. When the host disconnects, chats that were running get an `error` event with
`code: "crashed"` and a `status: exited` event. Request ids the panel sends are its own: background
swaps in its own id toward the host and puts the panel's back on the reply.

The tab adopted at binding is the user's own, so it is only grouped: it isn't pinned against
discarding and no blank tab is opened. If it can't be taken (pinned, or already in another
session's group), the chat starts with a blank tab in a new group instead, opened in the chat's own
window. `group.add` on a chat
with no group starts one from that tab. `sidebar_action` has no themed icons, so background.js
sets the sidebar icon by color scheme like the toolbar's: an outline pointer, solid purple while an
agent is acting.

The panel paints itself with the current theme's sidebar colors (`theme.getCurrent()`, falling
back to the toolbar's, then to neutral greys), so it is the same surface as Firefox's sidebar
header. Its header is one row, the chat's title and live state, since Firefox's own sidebar header
already names it; the engine is picked in the model menu.

While a chat is waiting on a permission request and no open panel shows it, the toolbar button
gets a `!` badge and a title saying so; opening the panel, answering, or the turn ending clears it.

The chat's tab group (grey, like every agent group) shows a state icon in its label (README, "Tab
group icons"). Two states come from the chat's bookkeeping here: *needs you* while a permission
request is pending (the same flag as the badge, whether or not a panel shows it), and *done* when
a turn's `result` arrived while no open panel showed the chat and the user hasn't looked since.
Looking is a panel showing the chat (`hello`, `chat.new`, `chat.open` on it), or activating a tab
in its group; a new turn also clears it, and an interrupted turn never sets it. Only live events
count, not results replayed from a loaded transcript. A chat counts as connected for the
*disconnected* state while it exists, even after its `claude` process idled out and its MCP client
left.

Address bar: the `omnibox` keyword `c` (background.js, "Ask from the address bar") sends a task
from the tab being viewed and opens the sidebar on its chat. On a tab in a chat's group, the task is
that chat's next message. Anywhere else it creates a chat like `hello` would, with the engine, model
and effort from the `chatPrefs` the panel saved, and `bindChat` takes the viewed tab. Either way the
chat is marked `omni` and `chat.send` goes through the same queue. Suggestions come from
`chat.history`, asked once when the address bar input starts (background asks the host itself, not
for a panel). When an `omni` chat's `result` arrives unseen (`finished`) and the window's active tab
isn't in its group, one notification `omni-<chatId>` is created; clicking it activates the group's
first tab. Resuming a chat opens the sidebar and sends that panel `chat.open`.

Open chats: a chat is open once it has a message, a group or a recording, until `chat.close`.
Background sends every panel `chats {chats: [{id, title, state, tabs}]}` (oldest first; `state` is
`idle`, `working`, `needs`, `paused` or `done`; `title` is the engine's title, else the first
message) on hello and, debounced, whenever a status, title, approval, pause or group changes. The
panel's title button lists them (and closes them), and the switcher adds `chat.history` below them.
`chat.close {chatId}` interrupts a running turn, ends a recording, ungroups the chat's tabs, forgets
the chat and its session entry, and moves panels showing it to the chat next to it (or a new one).
Events its engine sends afterwards are dropped until the chat is opened again from history.

Keys: the manifest's commands `focus-input`, `new-chat`, `switcher`, `shortcuts`, `prev-session`,
`next-session` and `session-1` to `session-9` open the sidebar from the command's handler (a user
action) and are sent to the window's panel as `key {name}`; the panel does the rest. A panel can't
take keyboard focus from the page, so it asks with `focus {panel}` and background calls the
experiment's `focusPanel(windowId, panel)`: the sidebar's inner browser, or the selected tab's.
Keys that only make sense in the panel (allow and deny, close, the model menu, Esc to stop) are its
own keydown handlers.

The extension reports the chat's agent to the bridge as `<client> (sidebar)` (from the MCP server,
when `FIREFOX_AGENT_BRIDGE_SESSION` is set), so Disconnect on a terminal session of the same
program doesn't block the panel's agent, or the reverse.

Panel behavior that isn't protocol: a message sent while a turn runs is a later, queued turn
(it doesn't end the running one, and events go to the first turn that isn't over); a step whose
result says the user stopped or paused it shows as "Stopped before ...", not as a failure; typing
while paused resumes first; tabs that join the group while the agent is running (its own
`tabs_create_mcp`) don't open the tray or toast; a turn with Task steps draws its steps card as
fan-out rows (`sidebar/fanout.js`: one row per top-level Task step holding every call under it,
its site taken from the tab of its latest call, remembered after the tab closes, or from its
navigate summary, and its reply shown under it once it ends; the agent cam is off for such a turn); a model's `efforts` narrows the effort row (none for Haiku 4.5,
and the panel then sends an empty effort); a model marked `default` stands for the panel's empty
model; a `limit` error shows "Your <engine> plan resets at <time>" when `resetsAt` is set, else the
error's own message; and the message paused calls get from the extension points at the panel, not
the toolbar button (which now toggles the sidebar).
