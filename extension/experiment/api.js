/* global ExtensionAPI, ExtensionCommon, ExtensionUtils, ChromeUtils, Services, IOUtils, PathUtils, Ci */
"use strict";

const { ExtensionError } = ExtensionUtils;

// Parent-process half of the extension. Page work happens in the ClaudePage JSWindowActor,
// which runs inside each frame's content process, where events it creates are trusted.

const ACTOR = "ClaudePage";
const RES_HOST = "firefox-agent-bridge";
const MODULES = ["actor-child.sys.mjs", "actor-parent.sys.mjs", "find-rank.sys.mjs", "focus.sys.mjs", "frame-offset.sys.mjs", "redact.sys.mjs"];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_FRAME_HOPS = 8;
// Tab group state icons: a stylesheet added to every browser window draws the icon from this
// attribute on the <tab-group> element, in the group's label (see group-state.css).
const STATE_ATTR = "fab-state";
const GROUP_STATES = new Set(["idle", "working", "needs", "paused", "done", "disconnected", "earlier"]);
const STATE_SHEET = "experiment/group-state.css";
// Point and ask: the actor hears these (capture, so before the page) in documents it already
// has an actor in, and acts on them only where pointArm armed it. Picks arrive on PICK_TOPIC.
const POINT_EVENTS = Object.fromEntries(
  ["mousemove", "keydown", "keyup", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "blur", "pagehide"].map((type) => [type, { capture: true, createActor: false }]),
);
const PICK_TOPIC = "firefox-agent-bridge:pick";
// Refs made in a child frame name it (ref_7@f12), so ops on them start in that frame.
const FRAME_REF = /@f(\d+)$/;
// Keys go where the last click landed. A click inside a cross-origin frame focuses an element in
// that frame without making the <iframe> the top document's activeElement, so following focus
// down from the top would send the keys to the top page.
const CLICK_OPS = new Set(["click", "fill"]);
const KEY_OPS = new Set(["type", "key"]);
// Teach (docs/teach.md): the browser ids of tabs being recorded, shared with every content
// process, and the topic the parent actor reports recorded steps on.
const RECORDING_KEY = "firefox-agent-bridge:recording";
// The redaction rules while recording, so fields they mask are recorded like secret ones.
const RECORD_REDACT_KEY = "firefox-agent-bridge:record-redact";
const RECORD_TOPIC = "firefox-agent-bridge:record";
// devtools: batches of console messages from watched tabs' frames, as {browserId, entries, dropped}.
const CONSOLE_TOPIC = "firefox-agent-bridge:console";
// The user input the child actor records. Capturing at the top of the chain, the actor sees
// each event before the page does, whatever the page does with it. A page going away only
// matters to an actor that is holding typing.
const RECORD_EVENTS = { click: { capture: true }, input: { capture: true }, change: { capture: true }, keydown: { capture: true }, pagehide: { createActor: false } };
// The actor registers for both sets. Teach needs an actor made for its events in any tab (the
// recording flag is checked there); point and ask only acts where it already armed one.
const ACTOR_EVENTS = { ...POINT_EVENTS, ...RECORD_EVENTS, pagehide: { capture: true, createActor: false } };

const MIME = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  csv: "text/csv",
  json: "application/json",
};

function resHandler() {
  return Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
}

function unregisterActor() {
  try {
    ChromeUtils.unregisterWindowActor(ACTOR);
  } catch {
    // not registered
  }
}

// Tells every frame in a tab's <browser> whether its console is captured (devtools).
function watchConsoleFrames(browser, on, redact) {
  for (const bc of browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? []) {
    try {
      bc.currentWindowGlobal?.getActor(ACTOR).sendAsyncMessage("consoleWatch", { on, redact });
    } catch {
      // frame going away
    }
  }
}

// A script error as the devtools tool keeps it; the actor makes the same from its own process.
function scriptErrorEntry(msg) {
  const level = msg.flags & Ci.nsIScriptError.warningFlag ? "warning" : msg.flags & Ci.nsIScriptError.infoFlag ? "info" : "error";
  return { level, text: msg.errorMessage, source: msg.sourceName, line: msg.lineNumber, time: msg.timeStamp };
}

// Tells every frame in a tab's <browser> whether point and ask is on.
function armFrames(browser, on) {
  for (const bc of browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? []) {
    try {
      bc.currentWindowGlobal?.getActor(ACTOR).sendAsyncMessage("pointArm", { on });
    } catch {
      // frame going away
    }
  }
}

function browserWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")];
}

// The browser window an element (a tab, a <browser>) is in. Firefox renamed ownerGlobal to
// documentGlobal.
const windowOf = (el) => el?.documentGlobal ?? el?.ownerGlobal ?? null;

// Keeping session tabs rendering while their window is occluded (another macOS Space, covered,
// minimized). Firefox then treats the window as hidden (its chrome document goes hidden, which
// the tab switcher reads as "minimized or occluded"), and the pages in it stop getting animation
// frames, session tabs included, though their docShellIsActive holds and they still read as
// visible. CanonicalBrowsingContext.forceAppWindowActive, set on the
// window's top chrome context, keeps it active; Picture-in-Picture sets it on the window a video
// was popped out of so the video's captions keep updating. There's no per-tab switch, so it
// covers the whole window.
const PIP_MODULES = ["moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs", "resource://gre/modules/PictureInPicture.sys.mjs"];

// Whether Picture-in-Picture wants this window kept active, so letting go of it is left to PiP.
function pipHolds(win) {
  for (const url of PIP_MODULES) {
    try {
      return (ChromeUtils.importESModule(url).PictureInPicture?.originatingWinWeakMap?.get(win) ?? 0) > 0;
    } catch {
      // not at this path in this version
    }
  }
  return false;
}

function forceWindowActive(win, on) {
  const bc = win.browsingContext;
  if (!bc || bc.forceAppWindowActive === on) return;
  if (!on && pipHolds(win)) return;
  bc.forceAppWindowActive = on;
}

function setRecording(browserId, on) {
  const ids = new Set(Services.ppmm.sharedData.get(RECORDING_KEY) ?? []);
  if (on) ids.add(browserId);
  else ids.delete(browserId);
  Services.ppmm.sharedData.set(RECORDING_KEY, [...ids]);
  Services.ppmm.sharedData.flush();
}

// Where frames sit in their tab's top frame's viewport (frame-offset.sys.mjs): each <iframe>'s
// content box is measured by the actor in the document holding it, which is in the frame's
// parent's process, and the boxes are chained up to the top. Loaded once registerActor has put
// the module where resource:// finds it.
const frameMath = () => ChromeUtils.importESModule(`resource://${RES_HOST}/frame-offset.sys.mjs`);

async function measureFrame(parent, id) {
  try {
    return (await parent.currentWindowGlobal?.getActor(ACTOR).sendQuery("frameBox", { id })) ?? null;
  } catch {
    return null; // going away, or an actor from before the restart
  }
}

const frameOffsetOf = (bc) => frameMath().frameOffset(bc, measureFrame);
const frameOffsetsUnder = (top) => frameMath().frameOffsets(top, measureFrame);

// The frame a recorded step happened in: at each level, the child at the recorded index if it
// still shows the same page, else the first that does, else the one at that index.
function frameAt(top, path) {
  let bc = top;
  for (const { index, url } of path) {
    const kids = bc.children ?? [];
    const same = (c) => (c?.currentWindowGlobal?.documentURI?.spec ?? "").replace(/[?#].*$/, "") === url;
    bc = (same(kids[index]) ? kids[index] : kids.find(same)) ?? kids[index];
    if (!bc) throw new Error("The frame this step happened in isn't on the page.");
  }
  return bc;
}

// An extension tab group id is the internal id ("<13 digit ms>-<n>") without its hyphen, as in
// Firefox's ext-browser.js. Ids it can't parse aren't found, and the caller falls back to titles.
function internalGroupId(id) {
  if (!Number.isSafeInteger(id) || id < 1e15) return null;
  return `${Math.floor(id / 1000)}-${id % 1000}`;
}

this.claudePage = class extends ExtensionAPI {
  onStartup() {
    this.ready = this.registerActor();
    this.ready.catch((e) => console.error("firefox-agent-bridge: actor registration failed", e));
    this.watchWindows();
    this.watchFrames();
    this.renderingWindows = new Set(); // windows keepRendering is keeping active
    this.clickFrames = new WeakMap(); // tab's top browsing context -> { id, window } of the child frame last clicked in
  }

  // Documents that load in an armed tab (a navigation, a late iframe) are armed as they appear,
  // and in a tab whose console is captured, they're told to capture theirs.
  watchFrames() {
    this.pointing = new Map(); // browserId -> <browser>, the tabs armed for point and ask
    this.consoleTabs = new Map(); // browserId -> <browser>, the tabs whose console is captured
    this.consoleRules = null;
    this.frameObserver = {
      observe: (wgp) => {
        const id = wgp?.browsingContext?.browserId;
        if (this.pointing.has(id)) this.ready.then(() => wgp.getActor(ACTOR).sendAsyncMessage("pointArm", { on: true })).catch(() => {});
        if (this.consoleTabs.has(id)) this.ready.then(() => wgp.getActor(ACTOR).sendAsyncMessage("consoleWatch", { on: true, redact: this.consoleRules })).catch(() => {});
      },
    };
    Services.obs.addObserver(this.frameObserver, "window-global-created");
    // Errors Firefox reports from the parent process about a page (blocked CORS requests, for
    // one) never reach its content process, so the actor can't see them; they're taken here.
    // Ones forwarded from a content process are the actor's.
    this.parentConsole = {
      observe: (msg) => {
        if (!(msg instanceof Ci.nsIScriptError) || msg.isForwardedFromContentProcess || !msg.innerWindowID) return;
        for (const [browserId, browser] of this.consoleTabs) {
          const frames = browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
          if (!frames.some((bc) => bc.currentWindowGlobal?.innerWindowId === msg.innerWindowID)) continue;
          Services.obs.notifyObservers(null, CONSOLE_TOPIC, JSON.stringify({ browserId, entries: [scriptErrorEntry(msg)], dropped: 0 }));
          return;
        }
      },
    };
    this.listeningConsole = false;
  }

  // The parent's console listener is only registered while some tab is watched.
  listenConsole(on) {
    if (on === this.listeningConsole) return;
    this.listeningConsole = on;
    if (on) Services.console.registerListener(this.parentConsole);
    else Services.console.unregisterListener(this.parentConsole);
  }

  // Every browser window, existing and future, gets the state stylesheet.
  watchWindows() {
    this.sheetWindows = new Set();
    this.windowObserver = { observe: (win) => this.ensureSheet(win) };
    Services.obs.addObserver(this.windowObserver, "browser-delayed-startup-finished");
    for (const win of browserWindows()) this.ensureSheet(win);
  }

  ensureSheet(win) {
    if (this.sheetWindows.has(win)) return;
    try {
      const utils = win.windowUtils;
      utils.loadSheetUsingURIString(this.extension.baseURI.resolve(STATE_SHEET), utils.AUTHOR_SHEET);
      this.sheetWindows.add(win);
      win.addEventListener("unload", () => this.sheetWindows.delete(win), { once: true });
    } catch (e) {
      console.error("firefox-agent-bridge: could not add the tab group stylesheet", e);
    }
  }

  removeSheets() {
    Services.obs.removeObserver(this.windowObserver, "browser-delayed-startup-finished");
    for (const win of browserWindows()) {
      for (const group of win.gBrowser?.tabGroups ?? []) group.removeAttribute(STATE_ATTR);
      if (!this.sheetWindows.has(win)) continue;
      try {
        win.windowUtils.removeSheetUsingURIString(this.extension.baseURI.resolve(STATE_SHEET), win.windowUtils.AUTHOR_SHEET);
      } catch {
        // window closing
      }
    }
    this.sheetWindows.clear();
  }

  async registerActor() {
    // Content processes are sandboxed away from the extension's source folder, but they can
    // read the profile's chrome/ dir, so the actor modules are copied there on every startup.
    const dir = PathUtils.join(PathUtils.profileDir, "chrome", RES_HOST);
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    const src = this.extension.rootURI.QueryInterface(Ci.nsIFileURL).file.path;
    for (const name of MODULES) {
      await IOUtils.copy(PathUtils.join(src, "experiment", name), PathUtils.join(dir, name));
    }
    resHandler().setSubstitution(RES_HOST, Services.io.newURI(PathUtils.toFileURI(dir) + "/"));

    unregisterActor();
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: { esModuleURI: `resource://${RES_HOST}/actor-parent.sys.mjs` },
      child: { esModuleURI: `resource://${RES_HOST}/actor-child.sys.mjs`, events: ACTOR_EVENTS },
      allFrames: true,
      safeForUntrustedWebProcess: true,
    });
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) return;
    Services.obs.removeObserver(this.frameObserver, "window-global-created");
    for (const browser of this.pointing.values()) armFrames(browser, false);
    for (const browser of this.consoleTabs.values()) watchConsoleFrames(browser, false);
    this.listenConsole(false);
    this.removeSheets();
    for (const win of this.renderingWindows) {
      try {
        if (!win.closed) forceWindowActive(win, false);
      } catch {
        // window closing
      }
    }
    this.renderingWindows.clear();
    Services.ppmm.sharedData.delete(RECORDING_KEY);
    Services.ppmm.sharedData.delete(RECORD_REDACT_KEY);
    unregisterActor();
    resHandler().setSubstitution(RES_HOST, null);
  }

  getAPI(context) {
    const self = this;
    const { tabManager } = context.extension;

    function topContext(tabId) {
      const tab = tabManager.get(tabId).nativeTab;
      return tab.linkedBrowser.browsingContext;
    }

    // The child frame the last click in this tab landed in, if it still shows the same document.
    function clickFrame(top) {
      const last = self.clickFrames.get(top);
      const bc = last && top.getAllBrowsingContextsInSubtree().find((c) => c.id === last.id);
      return bc && bc.currentWindowGlobal?.innerWindowId === last.window ? bc : null;
    }

    // Runs op in the tab's top frame. When the child answers { descend: { id, args } } the
    // target lives in a child frame (possibly another process), so the op is re-sent there.
    // A frame that answers { bubble } couldn't act (a scroll over a frame that can't scroll),
    // so the op goes back to the frame that descended, with noDescend set. An op with a `frame`
    // path (a Teach step's) starts in that frame instead of the top one, one with a `frameId`
    // (read_page reading a child frame) in the frame with that browsing context id, and keys in
    // the frame the last click landed in.
    async function run(tabId, op, args) {
      await self.ready;
      const top = topContext(tabId);
      let bc = Array.isArray(args?.frame) && args.frame.length ? frameAt(top, args.frame) : top;
      let current = args ?? {};
      const framed = FRAME_REF.exec(current.ref ?? current.refId ?? "");
      if (framed) {
        bc = top.getAllBrowsingContextsInSubtree().find((c) => c.id === Number(framed[1]));
        if (!bc) throw new Error(`${current.ref ?? current.refId} is gone (its frame closed or navigated). Call find or read_page again for a fresh ref.`);
      } else if (Number.isInteger(current.frameId)) {
        bc = top.getAllBrowsingContextsInSubtree().find((c) => c.id === current.frameId);
        if (!bc) throw new Error("That frame is gone (it closed or navigated). Call read_page again.");
      } else if (KEY_OPS.has(op) && bc === top) {
        bc = clickFrame(top) ?? top;
      }
      const path = [];
      for (let hop = 0; hop <= 2 * MAX_FRAME_HOPS; hop++) {
        const wg = bc?.currentWindowGlobal;
        if (!wg) throw new Error("The page is still loading (no window in this frame yet). Wait and retry.");
        const result = await wg.getActor(ACTOR).sendQuery(op, current);
        if (result?.bubble) {
          if (!path.length) return result.bubble;
          [bc, current] = path.pop();
          current = { ...current, noDescend: true };
          continue;
        }
        if (!result?.descend) {
          if (CLICK_OPS.has(op)) {
            if (bc.parent) self.clickFrames.set(top, { id: bc.id, window: wg.innerWindowId });
            else self.clickFrames.delete(top);
          }
          return result;
        }
        path.push([bc, current]);
        bc = top.getAllBrowsingContextsInSubtree().find((c) => c.id === result.descend.id);
        current = { ...current, ...result.descend.args };
      }
      throw new Error("Too many nested frames.");
    }

    // Errors from the actor or from here reach the extension as ExtensionErrors, so their
    // message survives instead of becoming "An unexpected error occurred".
    const surfaced = (fn) => async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        throw new ExtensionError(e?.message ?? String(e));
      }
    };

    function tabIdOf(browserId) {
      for (const win of browserWindows()) {
        const tab = (win.gBrowser?.tabs ?? []).find((t) => t.linkedBrowser?.browserId === browserId);
        if (tab) return tabManager.getWrapper(tab)?.id ?? null;
      }
      return null;
    }

    return {
      claudePage: {
        call: surfaced((tabId, op, args) => run(tabId, op, args)),

        // Runs op in every frame of the tab at once, cross-origin ones included, top frame first.
        // A frame the actor doesn't run in answers null; one whose op failed answers { error }.
        // With args.frameOffsets, each frame is also sent `offset`: where its viewport sits in
        // the top frame's (null where that couldn't be measured).
        broadcast: surfaced(async (tabId, op, args) => {
          await self.ready;
          const top = topContext(tabId);
          const offsets = args?.frameOffsets ? await frameOffsetsUnder(top) : null;
          return Promise.all(
            top.getAllBrowsingContextsInSubtree().map(async (bc) => {
              const sent = offsets ? { ...args, frameOffsets: undefined, offset: offsets.get(bc.id) ?? null } : args;
              let actor;
              try {
                actor = bc.currentWindowGlobal?.getActor(ACTOR);
              } catch {
                return null;
              }
              if (!actor) return null;
              try {
                return await actor.sendQuery(op, sent ?? {});
              } catch (e) {
                return { error: e?.message ?? String(e) };
              }
            }),
          );
        }),

        // Where the frame with this browsing context id sits in its tab's top frame's viewport:
        // { x, y, scale } (frame-offset.sys.mjs), or null when it's gone or couldn't be measured.
        frameOffset: surfaced(async (tabId, frameId) => {
          await self.ready;
          const bc = topContext(tabId).getAllBrowsingContextsInSubtree().find((c) => c.id === frameId);
          return bc ? frameOffsetOf(bc) : null;
        }),

        setActive: surfaced(async (tabId, active) => {
          const tab = tabManager.get(tabId).nativeTab;
          const browser = tab.linkedBrowser;
          if (tab.selected) return browser.docShellIsActive;
          browser.docShellIsActive = active;
          return browser.docShellIsActive;
        }),

        // Keeps the windows holding these (session) tabs rendering while occluded, and lets go of
        // windows it kept before that hold none of them now. Answers how many windows it keeps.
        keepRendering: surfaced(async (tabIds) => {
          const want = new Set();
          for (const id of tabIds) {
            try {
              const win = windowOf(tabManager.get(id).nativeTab);
              if (win && !win.closed) want.add(win);
            } catch {
              // tab closed
            }
          }
          for (const win of self.renderingWindows) {
            if (want.has(win)) continue;
            self.renderingWindows.delete(win);
            try {
              if (!win.closed) forceWindowActive(win, false);
            } catch {
              // window closing
            }
          }
          for (const win of want) {
            forceWindowActive(win, true);
            self.renderingWindows.add(win);
          }
          return want.size;
        }),

        // Sets (or, with a null state, clears) the state icon drawn in a tab group's label.
        // Returns whether it is showing: false when the group or its label element isn't found or
        // the stylesheet didn't apply, and the caller then puts a glyph in the title instead.
        setGroupState: surfaced(async (groupId, state) => {
          if (state != null && !GROUP_STATES.has(state)) throw new Error(`Unknown group state "${state}".`);
          const id = internalGroupId(groupId);
          for (const win of browserWindows()) {
            const group = id && (win.gBrowser?.tabGroups ?? []).find((g) => g.id === id);
            const label = group?.querySelector(".tab-group-label");
            if (!label) continue;
            self.ensureSheet(win);
            if (state == null) {
              group.removeAttribute(STATE_ATTR);
              return true;
            }
            group.setAttribute(STATE_ATTR, state);
            return win.getComputedStyle(label, "::before").content !== "none";
          }
          return false;
        }),

        // Arms point and ask in these tabs (the ones chat panels are showing) and disarms the rest.
        // Arming again also takes down an outline left up.
        setPointTabs: surfaced(async (tabIds) => {
          await self.ready;
          const next = new Map();
          for (const id of tabIds) {
            try {
              const browser = tabManager.get(id).nativeTab.linkedBrowser;
              next.set(browser.browserId, browser);
            } catch {
              // tab closed
            }
          }
          const before = self.pointing;
          self.pointing = next;
          for (const [id, browser] of before) if (!next.has(id)) armFrames(browser, false);
          for (const browser of next.values()) armFrames(browser, true);
        }),

        // An Alt+click in an armed tab: (tabId, {ref, role, name, text, rect, frame, url, title}).
        onPick: new ExtensionCommon.EventManager({
          context,
          name: "claudePage.onPick",
          register: (fire) => {
            const observer = (browser, topic, data) => {
              if (!self.pointing.has(browser?.browserId)) return;
              const tab = windowOf(browser)?.gBrowser?.getTabForBrowser(browser);
              if (tab) fire.async(tabManager.getWrapper(tab).id, JSON.parse(data));
            };
            Services.obs.addObserver(observer, PICK_TOPIC);
            return () => Services.obs.removeObserver(observer, PICK_TOPIC);
          },
        }).api(),

        // Starts or stops recording the user's input in a tab (Teach). Steps arrive on onRecord.
        // Fields the redaction rules mask are recorded without their values.
        record: surfaced(async (tabId, on, redact) => {
          await self.ready;
          if (on && redact && typeof redact === "object") Services.ppmm.sharedData.set(RECORD_REDACT_KEY, JSON.parse(JSON.stringify(redact)));
          setRecording(tabManager.get(tabId).nativeTab.linkedBrowser.browserId, !!on);
          return true;
        }),

        onRecord: new ExtensionCommon.EventManager({
          context,
          name: "claudePage.onRecord",
          register: (fire) => {
            const observer = (subject, topic, data) => {
              let msg;
              try {
                msg = JSON.parse(data);
              } catch {
                return;
              }
              const tabId = tabIdOf(msg.browserId);
              if (tabId != null) fire.async(tabId, msg.step);
            };
            Services.obs.addObserver(observer, RECORD_TOPIC);
            return () => Services.obs.removeObserver(observer, RECORD_TOPIC);
          },
        }).api(),

        // Captures the console in these tabs (devtools) and stops in the rest. The rules go to
        // each frame, which cuts masked field values out of messages before sending them.
        devtoolsWatch: surfaced(async (tabIds, redact) => {
          await self.ready;
          const next = new Map();
          for (const id of tabIds) {
            try {
              const browser = tabManager.get(id).nativeTab.linkedBrowser;
              next.set(browser.browserId, browser);
            } catch {
              // tab closed
            }
          }
          const before = self.consoleTabs;
          self.consoleTabs = next;
          self.consoleRules = redact && typeof redact === "object" ? JSON.parse(JSON.stringify(redact)) : null;
          for (const [id, browser] of before) if (!next.has(id)) watchConsoleFrames(browser, false);
          for (const browser of next.values()) watchConsoleFrames(browser, true, self.consoleRules);
          self.listenConsole(next.size > 0);
          return next.size;
        }),

        onConsole: new ExtensionCommon.EventManager({
          context,
          name: "claudePage.onConsole",
          register: (fire) => {
            const observer = (subject, topic, data) => {
              let msg;
              try {
                msg = JSON.parse(data);
              } catch {
                return;
              }
              if (!self.consoleTabs.has(msg.browserId)) return;
              const tabId = tabIdOf(msg.browserId);
              if (tabId != null) fire.async(tabId, { entries: msg.entries, dropped: msg.dropped });
            };
            Services.obs.addObserver(observer, CONSOLE_TOPIC);
            return () => Services.obs.removeObserver(observer, CONSOLE_TOPIC);
          },
        }).api(),

        upload: surfaced(async (tabId, ref, paths) => {
          const files = [];
          let total = 0;
          for (const path of paths) {
            if (!PathUtils.isAbsolute(path)) throw new Error(`Not an absolute path: ${path}`);
            const bytes = await IOUtils.read(path);
            total += bytes.byteLength;
            if (total > MAX_UPLOAD_BYTES) throw new Error("Files exceed the 10 MB upload limit.");
            const name = PathUtils.filename(path);
            const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
            files.push({ name, type: MIME[ext] ?? "application/octet-stream", bytes });
          }
          return run(tabId, "upload", { ref, files });
        }),
      },
    };
  }
};
