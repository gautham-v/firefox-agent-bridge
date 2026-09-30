// The parent side mostly sends queries; the work is in actor-child.sys.mjs. It receives three
// kinds of message. Point and ask: a frame reports here, "point" (the hint, which frame has the
// outline, clear) goes back to every frame in the tab, and "pick" goes to the extension (api.js)
// as an observer notification about the tab's <browser>. Teach: a step the child recorded, which
// it passes to api.js with the tab's browser id and the path to the frame it happened in (each
// frame's index under its parent, and its URL). devtools: a batch of console messages from a
// watched tab's frame, passed to api.js with the tab's browser id.

const ACTOR = "ClaudePage";
const PICK_TOPIC = "firefox-agent-bridge:pick";
const RECORD_TOPIC = "firefox-agent-bridge:record";
const CONSOLE_TOPIC = "firefox-agent-bridge:console";

export class ClaudePageParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (name === "record") return this.record(data);
    if (name === "console") {
      Services.obs.notifyObservers(null, CONSOLE_TOPIC, JSON.stringify({ browserId: this.browsingContext.browserId, entries: data?.entries ?? [], dropped: data?.dropped ?? 0 }));
      return;
    }
    const top = this.browsingContext.top;
    if (name === "pick") {
      if (top.embedderElement) Services.obs.notifyObservers(top.embedderElement, PICK_TOPIC, JSON.stringify(data));
      return;
    }
    if (name !== "point") return;
    for (const bc of top.getAllBrowsingContextsInSubtree()) {
      try {
        bc.currentWindowGlobal?.getActor(ACTOR).sendAsyncMessage("pointSync", data);
      } catch {
        // frame going away
      }
    }
  }

  record(data) {
    const bc = this.browsingContext;
    const frame = [];
    for (let c = bc; c.parent; c = c.parent) {
      frame.unshift({ index: c.parent.children.indexOf(c), url: (c.currentWindowGlobal?.documentURI?.spec ?? "").replace(/[?#].*$/, "") });
    }
    const step = frame.length ? { ...data, target: data.target && { ...data.target, frame } } : data;
    Services.obs.notifyObservers(null, RECORD_TOPIC, JSON.stringify({ browserId: bc.browserId, step }));
  }
}
