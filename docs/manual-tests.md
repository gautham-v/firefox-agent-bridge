# Manual tests

What unit tests and `scripts/test-bridge.mjs` can't cover: the privileged actor code and the
sidebar running in a real Firefox. Restart Firefox first with `scripts/restart-firefox.sh` (it
passes `-purgecaches`, which the actor modules need), then work down the list. Re-measuring the
eval tasks is separate: see "Re-measured after restart" in [eval/README.md](../eval/README.md).

## Features

1. **Redaction.** On a checkout page with password and card fields, ask the agent to take a
   screenshot, zoom, `read_page`, `get_page_text` and `find`. Values show as `[redacted: …]` or
   labeled bars, with a lock note saying how many fields were masked.
2. **Redaction rules.** Add `"sites": {"<site>": [".some-class"]}` to
   `~/.firefox-agent-bridge/redact.json`. The next agent call masks that element, without a
   restart.
3. **Point and ask.** With the sidebar open, hold Alt over the page to see the outline and hint.
   Alt+click a filled card field: the attachment reads `[redacted: cc-number, filled]` and the
   crop shows a bar. Then Alt+click inside a cross-origin iframe; the pick should reach the chat.
4. **Element links.** Ask the agent to link an element as `[label](ref:ref_N)`. Hovering the chip
   outlines the element; clicking it switches to the tab and scrolls to it.
5. **Point and ask while the agent works.** While the agent takes screenshots of a tab, Alt+click
   in that tab. No screenshot shows an unmasked field, the purple cursor or the outline.
6. **Agent cam.** During a task the steps card shows a live thumbnail. It pauses when the card is
   scrolled away or the panel is hidden, its button switches to the tab, and it goes away when the
   task ends.
7. **Save as GIF.** After a task, the save button under the reply downloads
   `firefox-agent-<date>-<time>.gif`. It plays the turn, loops, and password, card and
   one-time-code fields are covered. Try it once on a task that fills a login form.
8. **Teach.** In the + menu choose "Teach Claude a task". Click, type into a normal field, a
   password field and a card field, pick from a select, press Enter, and go to a URL from the
   address bar.
   - The step shots are masked; the password is "from Keychain" and the card field is "ask".
   - Alt+click during recording attaches nothing and doesn't group the tab.
   - Stop and draft, then Save. `SKILL.md`, `replay.json` and `steps/*.jpg` are in
     `~/.claude/skills/<name>/`.
   - Try it once: it runs in a new agent tab.
   - Add a site selector for a field and record again: that field is "ask".
9. **Address bar.** `c <task>` starts a new tab group without switching tabs. With the page
   unseen, a notification comes when it finishes, and clicking it focuses the group.
   - "Ask about this page" puts the current tab in the group, unless Teach is recording it.
   - Resuming a recent chat opens the sidebar on it.
10. **Sidebar skills.** `/` in the composer lists skills, the current site's first. Pick one and
    send it: it shows as a Skill step, and the chip is still there when the chat is reopened from
    history.
11. **Phone.** `scripts/remote-control.sh --install`, then start a session from the Claude phone
    app: history shows "From phone". `--status` and `--uninstall` work.
12. **Stop.** Alt+Shift+X during a skill replay (`replay_steps`) stops the run.
13. **Fan-out.** Ask the sidebar to compare 5 package pages. The steps card shows one row per
    sub-agent, each opening to its own steps, and every sub-agent's tab joins the one group.

## Bridge tools

14. **Window on another Space.** Start a task that scrolls a long page, then move Firefox's window
    to another Space. Screenshots still report the real size (not 0x0), and
    `requestAnimationFrame` still ticks (`javascript_tool`: count frames over one second). When the
    session disconnects, the window stops being kept active.
15. **Frames.** On an MDN page with a live example, `find` and `read_page` list the example's
    elements with `ref_N@fM` refs, `form_input` sets its select, and after a click in the frame
    `key` presses go there and name the element and its value.
    **Frame coordinates.** In a background tab on
    https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/select, `find "pet
    combobox"`, take a screenshot, then `scroll_to` the select's `@f` ref and screenshot again:
    `find`'s point and `scroll_to`'s center are on the select in the screenshots (within a few
    pixels, not "off-screen" or negative), and `read_page` with that ref places the frame viewport
    at the example's output pane's top left corner. Alt+click the select with the chat panel open:
    the crop shows the select. With `document.querySelector("iframe").style.zoom = 2` on a page
    with a cross-origin iframe (in `javascript_tool`), `find` still lands on its elements.
16. **Scroll over a frame.** Scrolling with the pointer over MDN's live example, or over a code
    block, doesn't fail with `NS_ERROR_UNEXPECTED`.
17. **`find` results.** At most 8 matches, names and links clipped, and a `(+K more, refine the
    query)` line when close matches were left out.
18. **`devtools`** (with `FIREFOX_BRIDGE_DEVTOOLS=1`). On a page that logs during load and makes a
    request that 404s: `kind: "console"` shows the load-time messages, `kind: "network"
    onlyFailed: true` shows the 404, and both survive a navigation. A password logged to the
    console comes back masked. Firefox asks for no new permission when the extension loads.
19. **Typing fires `change` on blur.** In a background tab, on
    http://uitestingplayground.com/textinput, click the text box, `type` a name, then press Tab:
    the button takes the name when clicked. Again with a click on the button straight after
    typing, and with a click on empty page. Listeners added first with `javascript_tool` show
    `input` per character, then `change` before `blur` (trusted), and `focus` on the next
    element; a Tab or click that changed nothing fires no `change`. In TodoMVC (React), double
    click a todo, type, and click elsewhere: the edit is saved. Typing into a password field
    still reads back masked, and in the focused tab (the one you're looking at) each event fires
    once.
