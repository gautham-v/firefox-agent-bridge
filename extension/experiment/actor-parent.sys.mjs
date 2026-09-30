// The parent side mostly sends queries; the work is in actor-child.sys.mjs. Point and ask is the
// exception: a frame reports here, "point" (the hint, which frame has the outline, clear) goes
// back to every frame in the tab, and "pick" goes to the extension (api.js) as an observer
// notification about the tab's <browser>.

const ACTOR = "ClaudePage";
const PICK_TOPIC = "firefox-agent-bridge:pick";

export class ClaudePageParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
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
}
