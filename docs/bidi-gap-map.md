# What WebDriver BiDi would need to cover Firefox Agent Bridge

## Summary

Firefox Agent Bridge lets a coding agent drive tabs in the user's own, already running Firefox:
an MCP server talks over a unix socket to a native messaging host, which talks to an MV2
extension. Firefox extensions have no `chrome.debugger`, so extension code can only dispatch
untrusted events, cannot read the DOM of every frame from one place, and cannot keep a
background tab rendering. The bridge works around this with a WebExtension Experiment
(privileged code that only Developer Edition or Nightly will load unsigned). The experiment
registers a `JSWindowActor` in every frame. The actor builds events in chrome code and sends them
through `windowUtils.dispatchDOMEventViaPresShellForTesting`, types with
`nsITextInputProcessor`, runs page scripts in a `Cu.Sandbox` so page CSP does not apply, sets
files with `mozSetFileArray`, and marks session tabs active with `docShellIsActive` so they
render while hidden. None of these are stable APIs. WebDriver BiDi covers most of the same
ground, but it assumes a separately launched automation browser, not a person's live one.

## Capability map

Firefox version numbers come from the Firefox WebDriver newsletters. Where I could not confirm
Firefox support, the row says so.

| Bridge capability | How the bridge does it today | Closest BiDi command(s) | Gap |
|---|---|---|---|
| `tabs_context_mcp` (list session tabs) | `tabs.query` filtered to the session's tab group; reports title, URL, whether the user is viewing it | `browsingContext.getTree` | `browsingContext.Info` has url, opener, client window and user context, but no title, no "user is looking at this" flag, and no grouping. |
| `tabs_create_mcp` | `tabs.create({active:false})`, added to the session's tab group | `browsingContext.create` with `type: "tab"`, `background: true` | `background` only skips activation. Nothing says the tab keeps rendering (see below). No tab group placement. |
| `tabs_close_mcp` | `tabs.remove` after checking the tab belongs to the session | `browsingContext.close` | None for closing. Ownership (which client may close which tab) is not a BiDi concept. |
| `navigate` (URL, back, forward) | `tabs.update` / `goBack` / `goForward`, then polls until text size stops changing | `browsingContext.navigate` (`wait`), `browsingContext.traverseHistory` | Covered. "Page has settled" for SPAs is still client-side polling either way. |
| `computer`: screenshot, zoom | `tabs.captureTab` with `scale` and `rect`, cursor hidden during capture | `browsingContext.captureScreenshot` (`origin`, `clip`, `imageSize`) | Covered on paper. Not verified: Firefox support for `imageSize`, and capture of a background tab that is not rendering. |
| `computer`: clicks, hover, drag | Mouse events built in the actor, dispatched via the pres shell; coordinates or element ref; descends into cross-origin iframes | `input.performActions` (pointer source, `origin` can be an element) | Covered for trusted clicks. BiDi input is per context; the client must pick the child context for an iframe. No visible pointer for the user. |
| `computer`: type, key | `nsITextInputProcessor` (trusted keydown/keypress/keyup, default actions run) | `input.performActions` (key source) | Covered for keys. Key actions are only keyDown/keyUp/pause, so there is no IME composition action. |
| `computer`: scroll | Trusted `wheel` event, then `scrollBy` on the nearest scrollable ancestor | `input.performActions` (wheel source) | Covered. |
| `read_page` | Own DOM walk with heuristic role and name computation, compact text tree, refs; top frame only | `browsingContext.locateNodes`, `script.callFunction` | No accessibility-tree snapshot command. Clients must inject their own walker, as the bridge does. |
| `find` | Keyword scoring over names, roles, labels, attributes | `browsingContext.locateNodes` (`accessibility`, `innerText`, `css`, `xpath` locators) | Partly covered. Locators do exact role/name or text matching, not ranked search. |
| `get_page_text` | `innerText`-style extraction in the actor | `script.evaluate` | Covered. |
| `form_input` | Sets value through the native setter, fires `input`/`change`; selects, checkboxes, contenteditable | `script.callFunction` with an element `script.SharedReference` | Covered with client-side code. |
| `javascript_tool` | `Cu.evalInSandbox` with the page window as prototype, so page CSP does not block `eval` | `script.evaluate` / `script.callFunction` (`sandbox` targets), `browsingContext.setBypassCSP`, `script.addPreloadScript` | Covered. Firefox 147 made `script.evaluate`/`callFunction` bypass CSP. I did not confirm Firefox ships `browsingContext.setBypassCSP`. |
| `file_upload` | Reads files in the parent, `mozSetFileArray`; intercepts file inputs that only appear on click so no native picker opens | `input.setFiles` (Firefox 125+), `input.fileDialogOpened` event (Firefox 147), `file` prompt handler | Covered. |
| Background tabs that still render | `docShellIsActive = true` on hidden session tabs, re-asserted on every call | none | No command to keep a non-selected tab rendering, firing `requestAnimationFrame` and IntersectionObserver. |
| Tab groups per session | `tabs.group` / `tabGroups.update`, one colored group per client session | none (`browser.createUserContext` is the nearest isolation primitive) | No way to show the user which tabs belong to which agent. |
| Visible cursor | Anonymous content layer (like DevTools highlighters) the page cannot see or hit-test | none | No standard way to show where automated input lands. |

## The gaps that matter most

### Attaching to the user's own browser

BiDi starts with a flag: Firefox's Remote Agent security notes say it is only turned on from the
command line (`--remote-debugging-port`). Drivers such as geckodriver normally start a fresh
profile too. That is right for testing and wrong for agents,
whose whole value is the user's logins, open tabs and extensions. The bridge gets there only by
turning off signature checks for the whole profile. Firefox needs a supported path for a local
agent to request a scoped session in a running browser: limited to some tabs or a user context,
granted by the user, revocable, and without restarting the browser.

### Consent and visibility

With the Remote Agent on, Firefox stripes the address bar and shows a robot icon naming the
component. That is browser-wide and binary. It does not say which program is driving, which tabs
it may touch, or how to stop it. `navigator.webdriver` tells pages, not the person. BiDi has
nothing for "who is the client", "ask the user before this action", or "the user took over,
pause". The bridge's socket protocol has each client send its name, version, pid and working
directory in its first message. The extension doesn't ask before a client's calls and doesn't
pause an agent when the user switches to its tab; instead it lists every connected client and
what it did, and the user can stop all sessions or disconnect a client and block its name. That
is the shape the platform needs.

### Background tabs that keep rendering

An agent working beside the user should never steal focus. `browsingContext.create` with
`background: true` avoids activation, but a hidden tab in Firefox stops painting and stops
firing IntersectionObserver, so lazy lists never fill and screenshots go stale. The bridge sets
`docShellIsActive` directly. BiDi would need a per-context "render as visible without
activating" setting, most likely an `emulation.*` command. I did not find one in the spec or an
open proposal for it.

### No semantic snapshot for agents

Agents work best from a compact tree of roles, names and states, not raw DOM or pixels. BiDi has
an `accessibility` locator on `browsingContext.locateNodes` (match by computed role and
accessible name), which Firefox implements. It has no command to return the tree. Issue w3c/webdriver-bidi#443 asked for both a full accessibility-tree snapshot
(like CDP's `Accessibility.getFullAXTree`) and role/name queries. The queries landed; the
snapshot has not, as far as I could tell. The bridge ships its own role/name heuristic because of this, and it only
covers the top frame. Gecko already has a real accessibility tree, so Firefox is well placed to
expose it.

### Trusted input and user activation

The WebDriver actions spec already requires that generated input be indistinguishable from a
real user, with `isTrusted` true, and `script.evaluate`/`callFunction` take `userActivation`.
The standard is not the gap here. The gaps are that only the automation session gets it, and
that trusted input comes with no policy: nothing marks it as agent input to the browser's own
UI, and nothing lets the user say which actions (payments, permission prompts, sending
messages) need approval first.

## What I'd standardize vs keep Firefox-only

Standardize:

- **Accessibility-tree snapshot** (`browsingContext.getAccessibilityTree` or similar, with depth
  and interesting-only filters). Every agent framework rebuilds this badly in page script.
- **Background rendering flag** per context. Engine-neutral, testable, and useful for testing
  too.
- **Client identity on `session.new`** (name, version, a display string). Cheap, and it gives
  every browser's UI something to show.
- **Scoped sessions** limited to a user context or a set of top-level contexts. It is the
  protocol half of attaching to a live browser safely.
- **"Paused by user" and "disconnected by user" errors and events.** Clients need a standard
  way to learn that a person stopped or cut them off, whatever the browser's UI looks like.

Keep Firefox-only (browser UI and policy, where Firefox can lead):

- **Toolbar stop button.** One click (or a shortcut) pauses every agent session and answers
  their pending calls; the UI belongs to the browser.
- **Client list and Disconnect.** The user sees every connected client with the identity it
  reported and its call count, and can disconnect one and block its name. Whether to also ask
  before a client's first call, or pause when the user switches to an agent's tab, is policy.
- **Activity log.** A per-client record of what was done in which tab, readable by the user.
  The format and retention are Firefox's call.
- **Agent tab groups and visible cursor.** Showing where the agent works and points is UX and
  should evolve faster than a spec.

## Sources

- WebDriver BiDi editor's draft: https://w3c.github.io/webdriver-bidi/
- WebDriver (actions, `isTrusted` requirement): https://w3c.github.io/webdriver/
- MDN, `browsingContext.locateNodes`: https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browsingContext/locateNodes
- MDN, `input.setFiles`: https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/input/setFiles
- Firefox WebDriver Newsletter 125: https://fxdx.dev/firefox-webdriver-newsletter-125/
- Firefox WebDriver Newsletter 147: https://fxdx.dev/firefox-webdriver-newsletter-147/
- Accessibility module issue: https://github.com/w3c/webdriver-bidi/issues/443
- BiDi roadmap: https://github.com/w3c/webdriver-bidi/blob/main/roadmap.md
- Remote Agent security: https://firefox-source-docs.mozilla.org/remote/Security.html
- Remote-control UX cue: https://bugzilla.mozilla.org/show_bug.cgi?id=1708707
