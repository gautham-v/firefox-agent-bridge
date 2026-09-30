// Focus events for focus changes that Gecko makes silently. In a document that doesn't have focus
// (a background tab, or a window that isn't the active one), moving focus updates activeElement
// but fires no blur, focusout, focus or focusin. So a text field the agent typed into never fired
// change when the agent pressed Tab or clicked away: Gecko's text controls fire change from their
// blur (before it), when the user changed the value since the field was focused. After its own
// input moves focus in such a document, the actor dispatches the events a real keyboard or mouse
// would have caused, in the order Firefox fires them: blur and focusout on the element that had
// focus, then focus and focusin on the one that has it.
//
// Elements are passed in (only tagName and isConnected are read), so node tests can use plain
// objects. from and to are the focused elements before and after, null for the page itself.

const FRAMES = new Set(["IFRAME", "FRAME"]);

export function focusEvents({ hasFocus, from, to }) {
  if (hasFocus || from === to) return [];
  // Focus inside a frame belongs to the frame's document, not to its iframe element.
  const left = from?.isConnected && !FRAMES.has(from.tagName) ? from : null;
  const entered = to && !FRAMES.has(to.tagName) ? to : null;
  const events = [];
  if (left) {
    events.push({ target: left, type: "blur", bubbles: false, relatedTarget: entered });
    events.push({ target: left, type: "focusout", bubbles: true, relatedTarget: entered });
  }
  if (entered) {
    events.push({ target: entered, type: "focus", bubbles: false, relatedTarget: left });
    events.push({ target: entered, type: "focusin", bubbles: true, relatedTarget: left });
  }
  return events;
}
