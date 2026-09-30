// The parent side sends queries; the work is in actor-child.sys.mjs. The one thing it receives
// is a Teach step the child recorded, which it passes to api.js with the tab's browser id and
// the path to the frame it happened in (each frame's index under its parent, and its URL).

const RECORD_TOPIC = "firefox-agent-bridge:record";

export class ClaudePageParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (name !== "record") return;
    const bc = this.browsingContext;
    const frame = [];
    for (let c = bc; c.parent; c = c.parent) {
      frame.unshift({ index: c.parent.children.indexOf(c), url: (c.currentWindowGlobal?.documentURI?.spec ?? "").replace(/[?#].*$/, "") });
    }
    const step = frame.length ? { ...data, target: data.target && { ...data.target, frame } } : data;
    Services.obs.notifyObservers(null, RECORD_TOPIC, JSON.stringify({ browserId: bc.browserId, step }));
  }
}
