# Teach by doing

**Teach Claude a task** in the chat panel's + menu records you doing a task in the tab you're on.
The chat's engine drafts a skill from the recording, and Save writes it as a `SKILL.md` and a
`replay.json` that the `replay_steps` tool runs without the model, handing over to the agent at
the first step that doesn't match.

## Pieces

| File | Role |
| --- | --- |
| `extension/experiment/actor-child.sys.mjs` | Records the user's clicks, typing, selects and Enter presses in a tab being recorded; on replay, finds a recorded target again (`locate`), types into it (`fill`) and checks page text (`contains`). |
| `extension/experiment/actor-parent.sys.mjs` | Adds the frame path to each recorded step and passes it to `api.js`. |
| `extension/experiment/api.js` | `claudePage.record(tabId, on)` and the `claudePage.onRecord` event; runs an op in a step's frame when its args carry a `frame` path. |
| `extension/background.js` | Keeps the recording for a chat, adds page loads the user started and a screenshot per step, relays it to panels, forwards Save to the host, and runs `replay_steps`. |
| `extension/sidebar/panel.js` | The recording view, the draft request, the review card, Save and Try it once. |
| `host/teach.mjs` | Builds `replay.json` and `SKILL.md` from the recording and the draft, and writes them. |
| `mcp/server.mjs` | The `replay_steps` tool: reads the file and sends its steps to Firefox. |

## Recording

The panel's `teach.start` records the window's active tab, if it is an http(s) page that isn't in
an agent's tab group. The recording belongs to a chat: the panel's own if it is untouched, else a
new one. The tab is not grouped or otherwise touched.

`api.js` registers `click`, `input`, `change`, `keydown` and `pagehide` listeners for the actor
(capture phase, at the top of the event chain, so the page can't hide input from it), and lists
the recorded tabs' browser ids in `Services.ppmm.sharedData`. The child acts only on trusted
events in a listed tab:

- **click** (primary button, first click of a double click) on the nearest interactive ancestor
  or label. Clicks that focus a text field (the typing is the step), open a select (its change
  is), follow a label's click on its control, or are the submit click that Enter in a field
  causes, are left out.
- **type**: `input` events in a text field, input or contenteditable, reported 600 ms after the
  typing pauses, when the field changes or loses the page, or before the next step. Each report
  of the same field carries the same `field` id, and background keeps them as one step.
- **select**: a `<select>`'s change, with the selected options' text.
- **key**: Enter in a single-line text field.

Password fields and other secret fields never send a value. A field is `"keychain"` when it is
`type=password`, has a password autocomplete, or is named like a password, passcode or PIN; it is
`"ask"` for one-time codes, card numbers and security codes, and social security numbers. A
field the [redaction rules](../README.md#redaction) mask (a site's selectors included) is `"ask"`
too, a masked select included, and masked text is kept out of recorded target names.

Background adds a **navigate** step for a page load that starts more than 3 s after the last
click, Enter or typing (one the user started from the address bar or history), and ignores
loads a click or Enter caused. Each step gets a 400 px wide JPEG of the tab. A recording keeps
at most 50 steps, and ends when the tab closes, on Stop, on Discard, or when the panel starts a
new chat before it was drafted.

### Recorded step

```json
{ "n": 2, "action": "type",
  "target": { "role": "textbox", "name": "Library card",
              "css": "#card", "near": "Sign in to your account",
              "frame": [{ "index": 0, "url": "https://login.example/" }] },
  "value": "21234000000", "field": "f1", "url": "https://bpl.bibliocommons.com/user/login" }
```

- `action`: `click`, `type`, `select`, `key` or `navigate`.
- `target`: the role (or tag name when there is none) and accessible name (or, for an element with
  no role, its own text); a CSS selector (an id that doesn't look generated, a test id, `name`
  or `aria-label`, else tag and position under the nearest such ancestor); up to 120 characters
  of text from the nearest ancestor that says more than the element; and `frame`, the path from
  the top frame (each frame's index under its parent and its URL without query), absent in the
  top frame.
- `value` for `type` and `select`, or `secret`: `"keychain"` | `"ask"` instead.
- `key` for `key`; `url` for `navigate` (and, on the others, the page the step happened on).

## Drafting

Stop and draft sends the chat's engine one message that starts with instructions and ends with
the recording:

```
Teach: I did a task in Firefox for you to learn. ...instructions...
<teach-recording id="<recording id>">
{"site": "...", "start": "https://...", "steps": [ ...recorded steps without `field`... ]}
</teach-recording>
```

The turn is a Teach turn (`teach: true` on `chat.send`), and so is every later message in that
chat: the viewed tab isn't adopted into a tab group, and a try opens a tab of the agent's own. The host titles the chat "New skill". The panel shows that message as a "Recorded N
steps" row that opens to the steps, whether live or loaded from history; over 16,000 characters
of JSON, nearby text and each click's page URL are dropped so the transcript keeps it whole.

The engine replies with prose and one fenced block the panel shows as the review card:

````
```skill-draft
{ "name": "renew-library-books",
  "description": "Renew everything checked out at Brooklyn Public Library.",
  "trigger": "renew my books",
  "inputs": [{ "name": "card_number", "step": 2, "from": "input", "about": "library card number" }],
  "checks": "Page shows \"Renewed\" for each item",
  "notes": ["\"Renew all\" is hidden until the list finishes loading."],
  "steps": [{ "from": 1 }, { "from": 2, "input": "card_number" }, { "from": 3 },
            { "from": 5, "expect": { "text": "Renewed" } }] }
```
````

Asking for changes gets a new block and a new card. Edit focuses the composer for that.

## Saving

Save (and Replace, when a skill of that name exists) sends `teach.save` with the draft, the
recording, the "Replay without Claude when steps match" toggle and the step screenshots. The host
writes, without a permission card (pressing Save is the consent):

- `~/.claude/skills/<name>/` (Codex chats: `~/.codex/skills/<name>/`; `CLAUDE_CONFIG_DIR` and
  `CODEX_HOME` are honored): `SKILL.md`, `replay.json`, and `steps/<n>.jpg` for each replayed
  step that has a screenshot.
- Try it once: only `replay.json` (and screenshots), in
  `~/.firefox-agent-bridge/chat/teach/<chatId>/<name>/`, then a Teach turn asking the agent to
  call `replay_steps` with that path.

The name must be lowercase letters, digits and dashes. The draft's steps are the recorded steps
it lists, in its order; a typed or selected value the draft named becomes an `{input}`
placeholder; a secret step always reads from an input (named after its field if the draft
didn't name one), since its value was never recorded.

`SKILL.md` has `name` and `description` frontmatter (the trigger phrase is added to the
description when it isn't in it). With the toggle on, it says to call `replay_steps` first and
finish the goal with the other tools where it stops; with it off, to follow the steps. Then the
checks, the inputs and where each comes from, the steps in words, and the site notes.

### replay.json

```json
{ "version": 1,
  "site": "bpl.bibliocommons.com",
  "start": "https://bpl.bibliocommons.com/",
  "inputs": ["card_number", "pin:keychain"],
  "steps": [
    { "click": { "role": "link", "name": "Log in", "css": "#login" }, "shot": "steps/1.jpg" },
    { "type": { "role": "textbox", "name": "Library card" }, "text": "{card_number}" },
    { "type": { "role": "textbox", "name": "PIN" }, "text": "{pin}" },
    { "key": "Enter" },
    { "click": { "role": "button", "name": "Renew all" }, "expect": { "text": "Renewed" } }
  ] }
```

- `inputs`: names, with `:keychain` or `:ask` for secret ones.
- A step is one of `click`, `type` (+ `text`), `select` (+ `value`, an option's value or text),
  each with a target as recorded; `key` (a key name, pressed in the focused element); or
  `navigate` (a URL). `{name}` in `text`, `value` or `navigate` is replaced by that input.
- `expect` (optional): `text` the page must show and/or a `url` substring, checked for up to 8 s
  after the step.
- `shot` (optional): the step's screenshot, relative to the file.

## replay_steps

`replay_steps {path, inputs, tabId}`: the MCP server reads the file (absolute path, at most 1 MB),
resolves `shot` paths against it, and sends Firefox `{replay, inputs, tabId}`; the path itself
stays on its side. The call's timeout is 10 minutes instead of 90 s. Without `tabId`, the first
tab in the session's group is used (created if needed). If the tab isn't on the recording's site,
it goes to `start` first.

For each step: a missing input stops the run there. Otherwise the target is looked for for up to
6 s, in its frame: role and name, then the selector (when its role matches), then role and a
similar name, then the name on any interactive element, then the selector alone, then role and
nearby text; among several matches, the one with the same nearby text, then the one the selector
picks, then the first. It is then clicked, filled (focused, its contents selected, the text typed
with trusted keys) or set (`formInput`), and a page load it starts is waited out as `navigate`
does. A file input stops the run (use `file_upload`). Stop in Firefox ends the run between steps.

The first step that doesn't match returns, as an ordinary result:

```
Replay stopped at step 3 of 5: type into textbox "PIN".
Expected: textbox "PIN" (selector #pin)
Found: nothing like it on the page after 6s.
Screenshot of this step when it was recorded: /Users/me/.claude/skills/renew-library-books/steps/3.jpg
Steps 1-2 ran.
Tab 12: https://bpl.bibliocommons.com/user/login
Title: Log in
Finish the task from here with the other Firefox tools.

Page (interactive elements):
...read_page with filter "interactive", up to 6,000 characters...
```

A full run returns `Replayed all N steps; K check(s) passed.` with the tab's URL and title. The
activity log keeps only the number of steps and inputs; input values are cut out of logged errors.

## Protocol

Panel to background: `teach.start`, `teach.stop {requestId, draft}` (waits 700 ms for the last
typing, stops, and answers the asking panel with its `requestId`), `teach.discard`,
`teach.save {requestId, mode: "skill" | "try", draft, recording, replay, replace}`, and
`chat.send` with `teach: true`.

Background to panel: `state` carries `teach` (the chat's recording, or null); `teach {recording}`
when it starts, stops or is discarded, or `teach {error}`; `teach.step {recordingId, step, shot?}`
for each new or updated step; `teach.saved` relayed.

Extension to host: `teach.save {requestId, chatId, engine, mode, draft, recording, replay,
replace, shots: {<n>: base64 JPEG}}`. Host to extension: `teach.saved {requestId, ok, dir,
replayPath}`, or `{requestId, ok: false, error, exists?, dir?}`.

## Not built

- Replay doesn't read the macOS Keychain itself; the agent passes secret inputs to
  `replay_steps` (the generated `SKILL.md` says where they come from).
- Recording sees what reaches the page as DOM events: drags, scrolling, hovers, keyboard
  shortcuts other than Enter, and a select inside a shadow root (its `change` doesn't leave the
  shadow tree) aren't steps.
- `contains` checks only the top frame's text.
