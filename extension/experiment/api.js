/* global ExtensionAPI, ExtensionUtils, ChromeUtils, Services, IOUtils, PathUtils, Ci */
"use strict";

const { ExtensionError } = ExtensionUtils;

// Parent-process half of the extension. Page work happens in the ClaudePage JSWindowActor,
// which runs inside each frame's content process, where events it creates are trusted.

const ACTOR = "ClaudePage";
const RES_HOST = "firefox-agent-bridge";
const MODULES = ["actor-child.sys.mjs", "actor-parent.sys.mjs", "redact.sys.mjs"];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_FRAME_HOPS = 8;
// Tab group state icons: a stylesheet added to every browser window draws the icon from this
// attribute on the <tab-group> element, in the group's label (see group-state.css).
const STATE_ATTR = "fab-state";
const GROUP_STATES = new Set(["idle", "working", "needs", "paused", "done", "disconnected", "earlier"]);
const STATE_SHEET = "experiment/group-state.css";

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

function browserWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")];
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
      child: { esModuleURI: `resource://${RES_HOST}/actor-child.sys.mjs` },
      allFrames: true,
      safeForUntrustedWebProcess: true,
    });
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) return;
    this.removeSheets();
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

    // Runs op in the tab's top frame. When the child answers { descend: { id, args } } the
    // target lives in a child frame (possibly another process), so the op is re-sent there.
    // A frame that answers { bubble } couldn't act (a scroll over a frame that can't scroll),
    // so the op goes back to the frame that descended, with noDescend set.
    async function run(tabId, op, args) {
      await self.ready;
      const top = topContext(tabId);
      let bc = top;
      let current = args ?? {};
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
        if (!result?.descend) return result;
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

    return {
      claudePage: {
        call: surfaced((tabId, op, args) => run(tabId, op, args)),

        // Runs op in every frame of the tab at once, cross-origin ones included, top frame first.
        // A frame the actor doesn't run in answers null; one whose op failed answers { error }.
        broadcast: surfaced(async (tabId, op, args) => {
          await self.ready;
          return Promise.all(
            topContext(tabId).getAllBrowsingContextsInSubtree().map(async (bc) => {
              let actor;
              try {
                actor = bc.currentWindowGlobal?.getActor(ACTOR);
              } catch {
                return null;
              }
              if (!actor) return null;
              try {
                return await actor.sendQuery(op, args ?? {});
              } catch (e) {
                return { error: e?.message ?? String(e) };
              }
            }),
          );
        }),

        setActive: surfaced(async (tabId, active) => {
          const tab = tabManager.get(tabId).nativeTab;
          const browser = tab.linkedBrowser;
          if (tab.selected) return browser.docShellIsActive;
          browser.docShellIsActive = active;
          return browser.docShellIsActive;
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
