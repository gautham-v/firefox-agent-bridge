// Child side of the ClaudePage actor. Runs in the content process of every frame, with chrome
// privileges, so events it creates are trusted (isTrusted === true, user activation granted)
// and work in background tabs and unfocused windows without touching the OS cursor.

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { barLabel, fieldKind, marker, markLabels, scrub, selectorKind, siteSelectors } from "resource://firefox-agent-bridge/redact.sys.mjs";

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider",
  "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "listbox",
  "treeitem", "file",
]);

// Roles that are worth a line in the "all" tree even when not interactive.
const STRUCTURAL_ROLES = new Set([
  "heading", "img", "navigation", "main", "banner", "contentinfo", "form", "list", "listitem",
  "table", "row", "cell", "columnheader", "dialog", "alertdialog", "complementary", "region",
  "article", "iframe", "alert", "status", "menu", "menubar", "tablist", "tabpanel", "group",
  "radiogroup", "toolbar", "search", "paragraph",
]);

// Roles whose text content is already their name, so their text children are not repeated.
const NAME_FROM_CONTENT = new Set([
  "button", "link", "heading", "option", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "cell", "columnheader", "treeitem", "checkbox", "radio", "switch",
]);

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD"]);

const TAG_ROLES = {
  A: (el) => (el.hasAttribute("href") ? "link" : null),
  BUTTON: () => "button",
  SELECT: (el) => (el.multiple || el.size > 1 ? "listbox" : "combobox"),
  TEXTAREA: () => "textbox",
  H1: () => "heading", H2: () => "heading", H3: () => "heading",
  H4: () => "heading", H5: () => "heading", H6: () => "heading",
  IMG: (el) => (el.getAttribute("alt") === "" ? null : "img"),
  NAV: () => "navigation",
  MAIN: () => "main",
  HEADER: () => "banner",
  FOOTER: () => "contentinfo",
  FORM: () => "form",
  UL: () => "list", OL: () => "list", LI: () => "listitem",
  TABLE: () => "table", TR: () => "row", TD: () => "cell", TH: () => "columnheader",
  DIALOG: () => "dialog",
  ASIDE: () => "complementary",
  ARTICLE: () => "article",
  SECTION: (el) => (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null),
  OPTION: () => "option",
  SUMMARY: () => "button",
  IFRAME: () => "iframe",
  FIELDSET: () => "group",
  P: () => "paragraph",
  INPUT: (el) => {
    switch (el.type) {
      case "hidden": return null;
      case "checkbox": return el.getAttribute("role") === "switch" ? "switch" : "checkbox";
      case "radio": return "radio";
      case "button": case "submit": case "reset": case "image": return "button";
      case "range": return "slider";
      case "number": return "spinbutton";
      case "search": return "searchbox";
      case "file": return "file";
      default: return el.hasAttribute("list") ? "combobox" : "textbox";
    }
  },
};

const MODIFIER_KEYS = {
  cmd: "Meta", command: "Meta", meta: "Meta", win: "Meta", windows: "Meta", super: "Meta",
  ctrl: "Control", control: "Control",
  shift: "Shift",
  alt: "Alt", option: "Alt", opt: "Alt",
};

const NAMED_KEYS = {
  enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab",
  backspace: "Backspace", delete: "Delete", del: "Delete", space: " ", spacebar: " ",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", insert: "Insert",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

const MAX_REFS_PER_DOC = 50000;

// ---------------------------------------------------------------------------------------------
// Element refs. Each document keeps its own ref_N numbering; refs die with the document. Refs
// made in a child frame name it (ref_7@f12, after its browsing context id), so api.js can send
// ops on them straight to that frame.

const docStates = new WeakMap();

function docState(doc) {
  let s = docStates.get(doc);
  if (!s) {
    const bc = doc.defaultView?.browsingContext;
    s = { next: 1, byRef: new Map(), byEl: new WeakMap(), suffix: bc?.parent ? `@f${bc.id}` : "" };
    docStates.set(doc, s);
  }
  return s;
}

function refFor(el) {
  const s = docState(el.ownerDocument);
  let ref = s.byEl.get(el);
  if (!ref) {
    if (s.byRef.size >= MAX_REFS_PER_DOC) {
      s.byRef.clear();
      s.byEl = new WeakMap();
    }
    ref = `ref_${s.next++}${s.suffix}`;
    s.byEl.set(el, ref);
    s.byRef.set(ref, el);
  }
  return ref;
}

function resolveRef(doc, ref) {
  const el = docState(doc).byRef.get(ref);
  if (!el || !el.isConnected) {
    throw new Error(`${ref} is gone (the page re-rendered or navigated). Call find or read_page again for a fresh ref.`);
  }
  return el;
}

// ---------------------------------------------------------------------------------------------
// Roles, names, visibility

const clean = (s, max = 150) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

function roleOf(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.split(/\s+/)[0];
  if (el.isContentEditable && (el.parentElement === null || !el.parentElement.isContentEditable)) return "textbox";
  const fn = TAG_ROLES[el.tagName];
  return fn ? fn(el) : null;
}

function nameOf(el, role) {
  const doc = el.ownerDocument;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" ");
    if (clean(text)) return clean(text);
  }
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return clean(aria);
  if (el.labels?.length) {
    const text = Array.from(el.labels).map(labelText).join(" ");
    if (clean(text)) return clean(text);
  }
  if (el.tagName === "IMG" || (el.tagName === "INPUT" && el.type === "image")) {
    const alt = el.getAttribute("alt");
    if (alt) return clean(alt);
  }
  if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return clean(el.value);
  if (role && (NAME_FROM_CONTENT.has(role) || role === "heading")) {
    const text = clean(el.textContent);
    if (text) return text;
  }
  const title = el.getAttribute("title");
  if (title) return clean(title);
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return clean(placeholder);
  return "";
}

// A label's own text, leaving out the text of controls nested inside it (like a select's options).
function labelText(label) {
  const parts = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) parts.push(child.data);
      else if (child.nodeType === 1 && !["SELECT", "TEXTAREA", "INPUT", "BUTTON", "SCRIPT", "STYLE"].includes(child.tagName)) walk(child);
    }
  };
  walk(label);
  return parts.join(" ");
}

function isRendered(el) {
  if (el.hidden) return false;
  try {
    return el.checkVisibility({ visibilityProperty: true });
  } catch {
    return true;
  }
}

function isInteractive(el, role) {
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.isContentEditable) return true;
  if (el.hasAttribute("onclick")) return true;
  const tabindex = el.getAttribute("tabindex");
  return tabindex !== null && Number(tabindex) >= 0 && el.tagName !== "IFRAME";
}

function describe(el, role, name, red) {
  const tag = el.tagName.toLowerCase();
  const masked = red?.mask(el);
  const explicit = el.getAttribute("role");
  const native = TAG_ROLES[el.tagName]?.(el);
  // e.g. a <button role="link">: say so, since it has no href to read
  const label = explicit && role && native !== role && !["div", "span", "li"].includes(tag) ? `${role}(${tag})` : role || tag;
  const parts = [label];
  if (name) parts.push(JSON.stringify(name));
  parts.push(`[${refFor(el)}]`);
  if (masked && !isField(el)) parts.push(red.marker(el));
  if (role === "link") {
    const href = el.getAttribute("href");
    if (href && !href.startsWith("javascript:")) parts.push(`href=${JSON.stringify(clean(href, 200))}`);
  }
  if (role === "heading") {
    const level = el.getAttribute("aria-level") ?? el.tagName.match(/^H(\d)$/)?.[1];
    if (level) parts.push(`level=${level}`);
  }
  if (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "file", "hidden"].includes(el.type)) {
    if (el.type !== "text") parts.push(`type=${el.type}`);
    if (masked) {
      parts.push(`value=${red.marker(el)}`);
    } else if (el.type === "password") {
      if (el.value) parts.push("value=(set)");
    } else if (el.value) {
      parts.push(`value=${JSON.stringify(clean(el.value, 100))}`);
    }
    if (el.placeholder && el.placeholder !== name) parts.push(`placeholder=${JSON.stringify(clean(el.placeholder, 80))}`);
  }
  if (el.tagName === "TEXTAREA" && masked) parts.push(`value=${red.marker(el)}`);
  else if (el.tagName === "TEXTAREA" && el.value) parts.push(`value=${JSON.stringify(clean(el.value, 100))}`);
  if (el.tagName === "SELECT" && masked) {
    parts.push(`selected=${red.marker(el)}`);
    parts.push(`options=${el.options.length}`);
  } else if (el.tagName === "SELECT") {
    const selected = Array.from(el.selectedOptions).map((o) => clean(o.textContent, 60));
    parts.push(`selected=${JSON.stringify(selected.join(", "))}`);
    parts.push(`options=${el.options.length}`);
  }
  if (el.tagName === "INPUT" && el.type === "file") {
    parts.push(el.files?.length ? `files=${JSON.stringify(Array.from(el.files).map((f) => f.name).join(", "))}` : "files=none");
    if (el.accept) parts.push(`accept=${JSON.stringify(el.accept)}`);
  }
  if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
    parts.push(masked ? red.marker(el) : el.checked ? "checked" : "unchecked");
  } else {
    const ariaChecked = el.getAttribute("aria-checked");
    if (ariaChecked) parts.push(`checked=${ariaChecked}`);
  }
  for (const attr of ["aria-expanded", "aria-selected", "aria-pressed", "aria-current"]) {
    const v = el.getAttribute(attr);
    if (v && v !== "false") parts.push(`${attr.slice(5)}=${v}`);
  }
  if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
  if (el.required || el.getAttribute("aria-required") === "true") parts.push("required");
  if (el.tagName === "IFRAME") {
    const src = el.getAttribute("src");
    if (src) parts.push(`src=${JSON.stringify(clean(src, 200))}`);
  }
  return parts.join(" ");
}

// Child nodes as rendered: shadow trees (open or closed) and slotted content included.
function renderedChildren(node) {
  if (node.nodeType === 1) {
    const shadow = node.openOrClosedShadowRoot;
    // Form controls and media have browser-internal (UA widget) shadow trees; skip those.
    if (shadow && !shadow.isUAWidget()) return Array.from(shadow.childNodes);
    if (node.tagName === "SLOT") {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
  }
  return Array.from(node.childNodes);
}

// ---------------------------------------------------------------------------------------------
// Redaction. Fields the user's rules mark sensitive (redact.sys.mjs; background.js passes the
// rules in as `redact`) never have their values leave Firefox: text results read
// "[redacted: <kind>, filled|empty]" in their place, and screenshots are taken with a labeled bar
// drawn over each one. Typing into them works as usual.

const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const isField = (el) => FIELD_TAGS.has(el.tagName);

function isFilled(el) {
  if (!isField(el)) return !!(el.textContent ?? "").trim();
  if (el.type === "checkbox" || el.type === "radio") return el.checked;
  return el.value !== "";
}

// The page's site as the user would name it (checkout.acme-supply.com is acme-supply.com).
function siteOf(doc) {
  const host = doc.location?.hostname ?? "";
  try {
    return Services.eTLD.getBaseDomainFromHost(host);
  } catch {
    return host.replace(/^www\./, "") || "this page";
  }
}

// The document and every shadow root in it (open or closed), for finding masked elements that
// read_page and find would reach.
function allRoots(doc) {
  const roots = [doc];
  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll("*")) {
      const shadow = el.openOrClosedShadowRoot;
      if (shadow && !shadow.isUAWidget()) roots.push(shadow);
    }
  }
  return roots;
}

// One per op: which elements are masked in this document, and which of them the op's output
// masked, for the "N fields masked on <site>" line.
function redactor(doc, rules) {
  const selectors = siteSelectors(rules, doc.location?.hostname);
  const cache = new Map();
  const used = new Set();
  let found = null;
  let secrets = null;

  // { kind, filled } for a masked element, else null. A field inside an element a site rule
  // matches is masked too.
  function mask(el) {
    if (cache.has(el)) return cache.get(el);
    let kind = isField(el) ? fieldKind(rules, { tag: el.tagName, type: el.type, autocomplete: el.getAttribute("autocomplete") }) : null;
    for (const sel of kind ? [] : selectors) {
      let hit = null;
      try {
        hit = el.closest(sel);
      } catch {
        // not a valid selector
      }
      if (hit) {
        kind = selectorKind(sel);
        break;
      }
    }
    const m = kind ? { kind, filled: isFilled(el) } : null;
    cache.set(el, m);
    return m;
  }

  // Every masked element in the document, shadow trees included.
  function elements() {
    if (found) return found;
    if (!rules?.always?.length && !selectors.length) return (found = []);
    const set = new Set();
    for (const root of allRoots(doc)) {
      for (const el of root.querySelectorAll("input, textarea, select")) if (mask(el)) set.add(el);
      for (const sel of selectors) {
        try {
          for (const el of root.querySelectorAll(sel)) set.add(el);
        } catch {
          // not a valid selector
        }
      }
    }
    found = [...set].filter((el) => mask(el));
    return found;
  }

  // What each masked element would give away: a field's value (and a select's option text), and
  // the text of anything else, whole and node by node.
  function secretList() {
    if (secrets) return secrets;
    secrets = [];
    for (const el of elements()) {
      const m = marker(mask(el).kind, mask(el).filled);
      const add = (text, echo) => text && secrets.push({ text, marker: m, echo, el });
      if (el.tagName === "SELECT") {
        for (const o of el.selectedOptions) {
          add(o.value, true);
          add(clean(o.textContent), true);
        }
      } else if (isField(el)) {
        add(el.value, true);
      } else {
        add(clean(el.innerText ?? el.textContent, 100000), false);
        const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) add(clean(n.data, 100000), true);
      }
    }
    return secrets;
  }

  return {
    mask,
    elements,
    siteRules: selectors.length > 0,
    marker(el) {
      used.add(el);
      const m = mask(el);
      return marker(m.kind, m.filled);
    },
    // Masked values and text found anywhere in the output. count: false for text that is only
    // matched against, never returned.
    scrub(text, count = true) {
      const list = secretList();
      if (!list.length || !text) return text;
      const out = scrub(text, list);
      if (count) for (const i of out.hits) used.add(list[i].el);
      return out.text;
    },
    // Page text has no field values, so masked fields are marked after their <label>'s line.
    markLabels(text) {
      const fields = elements().filter((el) => isField(el) && el.labels?.length && isRendered(el));
      if (!fields.length) return text;
      const out = markLabels(text, fields.map((el) => ({ label: labelText(el.labels[0]), marker: marker(mask(el).kind, mask(el).filled) })));
      for (const i of out.hits) used.add(fields[i]);
      return out.text;
    },
    site: () => siteOf(doc),
    // What the op's output masked, or null.
    masked: () => (used.size ? { count: used.size, site: siteOf(doc) } : null),
    // The op's answer: plain text, or with what was masked when anything was.
    result(text) {
      return used.size ? { text, masked: { count: used.size, site: siteOf(doc) } } : text;
    },
  };
}

// Bars over masked fields while a screenshot is taken. Like the cursor they're anonymous
// content, so the page can't see or remove them; they're removed right after the capture, or
// after a few seconds if the capture never says it's done.
const MASK_MAX_MS = 5000;
const masks = new WeakMap(); // document -> { content, timer }

const MASK_CSS = `
  :host { all: initial; }
  .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; overflow: hidden; }
  .bar {
    position: absolute; box-sizing: border-box; border-radius: 4px; background: #1c1b22; color: #fbfbfe;
    display: flex; align-items: center; padding: 0 8px; overflow: hidden;
    font: 11px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: .02em;
  }
  .bar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

function clearMask(doc) {
  const m = masks.get(doc);
  if (!m) return;
  masks.delete(doc);
  clearTimeout(m.timer);
  try {
    doc.removeAnonymousContent(m.content);
  } catch {
    // document going away
  }
}

// The masked elements in the viewport, each with its box. With the viewport's size unknown, every
// one counts rather than none.
function maskedBoxes(doc, red) {
  const size = viewSize(doc.defaultView);
  const view = { width: size.width || Infinity, height: size.height || Infinity };
  const els = red.elements().filter((el) => isRendered(el));
  // A masked element inside another one is already covered.
  const outer = els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
  const bars = [];
  for (const el of outer) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom <= 0 || r.right <= 0 || r.top >= view.height || r.left >= view.width) continue;
    bars.push({ el, r });
  }
  return bars;
}

function drawMask(doc, red) {
  const bars = maskedBoxes(doc, red);
  if (!bars.length) return 0;
  let content;
  try {
    content = doc.insertAnonymousContent();
  } catch {
    throw new Error("Could not draw over sensitive fields in this frame.");
  }
  const style = doc.createElement("style");
  style.textContent = MASK_CSS;
  const layer = doc.createElement("div");
  layer.className = "layer";
  for (const { el, r } of bars) {
    // Inset a little, like the field's own border, when there's room.
    const inset = r.height >= 16 && r.width >= 24 ? 2 : 0;
    const bar = doc.createElement("div");
    bar.className = "bar";
    bar.style.cssText = `left: ${r.left + inset}px; top: ${r.top + inset}px; width: ${r.width - 2 * inset}px; height: ${r.height - 2 * inset}px;`;
    if (r.height >= 14 && r.width >= 48) {
      const m = red.mask(el);
      const label = doc.createElement("span");
      label.textContent = barLabel(m.kind, m.filled);
      bar.appendChild(label);
    }
    layer.appendChild(bar);
  }
  content.root.append(style, layer);
  masks.set(doc, { content, timer: setTimeout(() => clearMask(doc), MASK_MAX_MS) });
  return bars.length;
}

// Sent to every frame of a tab around a capture: on hides the agent cursor and covers masked
// fields; off undoes both. Answers how many fields were covered, the site, and whether this is
// the top frame (whose site the result names).
function capture(doc, { on, redact }) {
  cursorVisible(doc, { visible: !on });
  clearMask(doc);
  const top = !doc.defaultView.browsingContext.parent;
  if (!on) return { masked: 0, top };
  const red = redactor(doc, redact);
  return { masked: drawMask(doc, red), site: red.site(), top };
}

// Where the masked fields are, for the agent cam's frames that Save as GIF keeps (panel.js). The
// sidebar draws their bars itself, so nothing shows on the page: each box is in this frame's
// viewport, with where the viewport sits on screen to place a child frame's boxes in the tab.
function maskRects(doc, { redact }) {
  const win = doc.defaultView;
  const red = redactor(doc, redact);
  const rects = maskedBoxes(doc, red).map(({ el, r }) => {
    const m = red.mask(el);
    return { x: r.left, y: r.top, width: r.width, height: r.height, label: barLabel(m.kind, m.filled) };
  });
  return { rects, screenX: win.mozInnerScreenX, screenY: win.mozInnerScreenY, ...viewSize(win), top: !win.browsingContext.parent };
}

// ---------------------------------------------------------------------------------------------
// read_page. A child frame (an iframe, also one inside a shadow root, cross-origin or not) gets a
// line of its own ending in frame=f<id>, and its id goes in `frames`: background.js then reads
// that frame too (with `inner`, which leaves out the header) and puts its tree under the line.

function readPage(doc, { filter = "all", depth = 15, maxChars = 50000, refId, frameScale = 1, redact, inner = false, origin } = {}) {
  const interactiveOnly = filter === "interactive";
  const red = redactor(doc, redact);
  const lines = [];
  const frames = [];
  let chars = 0;
  let truncated = false;

  const push = (line) => {
    if (chars + line.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    chars += line.length + 1;
    return true;
  };

  const walk = (node, level, depthLeft, insideNamed) => {
    if (truncated) return;
    if (node.nodeType === 3) {
      if (interactiveOnly || insideNamed) return;
      const text = clean(node.data, 300);
      if (text.length > 1) push(`${"  ".repeat(level)}text ${JSON.stringify(text)}`);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    const el = node;
    if (node.nodeType === 1) {
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.getAttribute("aria-hidden") === "true") return;
      if (!isRendered(el)) {
        // display:contents and similar still have rendered children
        if (el.ownerDocument.defaultView.getComputedStyle(el)?.display !== "contents") return;
      }
      if (FRAME_TAGS.has(el.tagName) && el.browsingContext && !red.mask(el)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || depthLeft <= 0) return; // tracking pixels and the like
        const id = el.browsingContext.id;
        if (push(`${"  ".repeat(level)}${describe(el, "iframe", nameOf(el, "iframe"), red)} frame=f${id}`)) frames.push(id);
        return;
      }
    }
    let nextLevel = level;
    let nextDepth = depthLeft;
    let named = insideNamed;
    if (node.nodeType === 1) {
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      const include = interactive || (!interactiveOnly && role && STRUCTURAL_ROLES.has(role));
      // A masked element (not a field) reads as one marker; the fields inside it still show,
      // its text doesn't.
      if (red.mask(el) && !isField(el)) {
        if (depthLeft <= 0) return;
        if (!push(`${"  ".repeat(level)}${include ? describe(el, role, "", red) : `text ${red.marker(el)}`}`)) return;
        for (const child of renderedChildren(node)) walk(child, level + 1, depthLeft - 1, true);
        return;
      }
      if (include) {
        if (depthLeft <= 0) return;
        if (!push(`${"  ".repeat(level)}${describe(el, role, nameOf(el, role), red)}`)) return;
        nextLevel = level + 1;
        nextDepth = depthLeft - 1;
        if (role && NAME_FROM_CONTENT.has(role)) named = true;
      }
      if (el.tagName === "SELECT" || el.tagName === "TEXTAREA") return;
    }
    for (const child of renderedChildren(node)) walk(child, nextLevel, nextDepth, named);
  };

  const root = refId ? resolveRef(doc, refId) : doc.body ?? doc.documentElement;
  const win = doc.defaultView;
  const view = viewSize(win);
  const px = (n) => Math.round(n * frameScale);
  // Read by a ref in a child frame, the viewport is that frame's, a part of the screenshot:
  // `origin` (the top frame's viewport on screen) says where.
  const child = !!win.browsingContext.parent;
  const place = child && origin ? ` at (${px(win.mozInnerScreenX - origin.x)}, ${px(win.mozInnerScreenY - origin.y)}) in the screenshot` : "";
  const header = [
    `${child ? "Frame" : "Page"}: ${doc.title}`,
    `URL: ${doc.location?.href}`,
    child
      ? `Frame viewport (a part of the page, not the whole screenshot): ${px(view.width)}x${px(view.height)}${place}; frame scrolled ${px(win.scrollY)} of ${px(doc.documentElement.scrollHeight)} tall`
      : `Viewport (screenshot frame): ${px(view.width)}x${px(view.height)}; page scrolled ${px(win.scrollY)} of ${px(doc.documentElement.scrollHeight)} tall`,
    "",
  ];
  walk(root, 0, depth, false);
  let out = (inner ? "" : header.join("\n")) + lines.join("\n");
  if (truncated && !inner) {
    out += `\n\n[Truncated at ${maxChars} characters. Use filter "interactive", a smaller depth, or ref_id to focus on part of the page.]`;
  }
  const text = red.scrub(out);
  if (inner || frames.length) return { text, masked: red.masked(), frames, truncated };
  return red.result(text);
}

// ---------------------------------------------------------------------------------------------
// find: heuristic scoring over names, roles and attributes. background.js runs it in every
// frame of the tab at once and merges the answers by score, so each frame answers its best
// matches as { score, line } rather than text. `origin` is the top frame's viewport (its place
// on screen and size), so a child frame's coordinates are given in the top frame's, which is what
// screenshots and clicks use. Only the best FIND_MAX are described; the scores of the rest that
// were close behind go along so the merged answer can say how many more there were.

const FIND_MAX = 8;
const FIND_KEEP = 0.5; // of the best score

const STOPWORDS = new Set(["the", "a", "an", "for", "on", "in", "of", "to", "with", "and", "or", "that", "this", "at", "by", "is", "it", "element", "page"]);

const ROLE_WORDS = {
  button: ["button"],
  btn: ["button"],
  link: ["link"],
  input: ["textbox", "searchbox", "combobox", "spinbutton"],
  field: ["textbox", "searchbox", "combobox", "spinbutton"],
  textbox: ["textbox", "searchbox"],
  box: ["textbox", "searchbox", "combobox", "checkbox"],
  bar: ["searchbox", "textbox", "combobox"],
  search: ["searchbox", "search"],
  dropdown: ["combobox", "listbox", "button"],
  select: ["combobox", "listbox"],
  menu: ["menu", "menuitem", "combobox", "button"],
  checkbox: ["checkbox", "switch"],
  toggle: ["switch", "checkbox", "button"],
  radio: ["radio"],
  option: ["option", "radio"],
  tab: ["tab"],
  heading: ["heading"],
  title: ["heading"],
  image: ["img"],
  upload: ["file"],
  file: ["file"],
  resume: ["file"],
  dialog: ["dialog", "alertdialog"],
  modal: ["dialog", "alertdialog"],
};

function findElements(doc, { query, frameScale = 1, origin, redact }) {
  const win = doc.defaultView;
  const view = viewSize(win);
  const child = !!win.browsingContext.parent;
  // A frame with no size shows nothing (a hidden or tracking frame).
  if (child && !(view.width > 1 && view.height > 1)) return { matches: [], rest: [], masked: null };
  const red = redactor(doc, redact);
  // What is scored is masked too, so a query can't probe for a masked value.
  const hide = (s) => red.scrub(s, false);
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}$]+/u).filter((t) => t && !STOPWORDS.has(t));
  const phrase = query.toLowerCase().trim();
  const scored = [];

  const visit = (node) => {
    if (node.nodeType === 1) {
      const el = node;
      if (SKIP_TAGS.has(el.tagName) || el.getAttribute("aria-hidden") === "true") return;
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      const ownText = !interactive && !(red.mask(el) && !isField(el)) && hide(ownTextOf(el));
      if (ownText && isRendered(el)) {
        const hay = ownText.toLowerCase();
        let score = 0;
        for (const t of tokens) if (hay.includes(t)) score += 2;
        if (hay.includes(phrase)) score += 5;
        if (score > 0) scored.push({ el, role: role ?? "text", score, rect: el.getBoundingClientRect(), text: clean(ownText, 150) });
      }
      if (interactive || (role && STRUCTURAL_ROLES.has(role) && role !== "paragraph")) {
        const fileInput = el.tagName === "INPUT" && el.type === "file";
        const rendered = isRendered(el);
        // Hidden file inputs are the usual upload target, so they stay findable.
        if (rendered || fileInput) {
          const name = hide(nameOf(el, role)).toLowerCase();
          const extra = [
            el.id, el.getAttribute("name"), el.getAttribute("placeholder"), el.getAttribute("title"),
            el.getAttribute("data-test-id"), el.getAttribute("data-testid"), el.getAttribute("aria-describedby") ? "" : "",
            el.tagName === "A" ? el.getAttribute("href") : "",
            role === "heading" || role === "listitem" || role === "article" ? "" : clean(el.textContent, 300),
            el.tagName === "INPUT" ? `${el.type} ${el.accept ?? ""}` : "",
          ].filter(Boolean).map(hide).join(" ").toLowerCase();
          let score = 0;
          for (const t of tokens) {
            const word = new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
            if (word.test(name)) score += 3;
            else if (name.includes(t)) score += 1;
            else if (word.test(extra)) score += 1;
            else if (extra.includes(t)) score += 0.5;
            if (ROLE_WORDS[t]?.includes(role)) score += 2;
          }
          if (name && phrase.includes(name) && name.length > 2) score += 3;
          if (name && name.includes(phrase)) score += 5;
          if (score > 0) {
            if (interactive) score += 1;
            const r = el.getBoundingClientRect();
            const inView = r.bottom > 0 && r.right > 0 && r.top < view.height && r.left < view.width;
            if (inView) score += 0.5;
            scored.push({ el, role, score, rect: r, interactive });
          }
        }
      }
    }
    for (const child of renderedChildren(node)) {
      if (child.nodeType === 1 || child.nodeType === 11) visit(child);
    }
  };
  visit(doc.body ?? doc.documentElement);

  // Text inside a matched button or link is the same target twice.
  const targets = scored.filter((m) => m.interactive).map((m) => m.el);
  const kept = scored.filter((m) => m.role !== "text" || !targets.some((t) => t !== m.el && t.contains(m.el)));
  kept.sort((a, b) => b.score - a.score);
  const best = kept.length ? kept[0].score : 0;
  const close = kept.filter((m) => m.score >= Math.max(1, best * FIND_KEEP));
  const top = close.slice(0, FIND_MAX);
  // Where this frame's viewport sits in the top frame's, in CSS pixels.
  const dx = child && origin ? win.mozInnerScreenX - origin.x : 0;
  const dy = child && origin ? win.mozInnerScreenY - origin.y : 0;
  const inTop = (x, y) => !child || !origin || (x >= 0 && y >= 0 && x < origin.width && y < origin.height);
  const where = child ? ` (in frame ${doc.location?.host || "about:blank"})` : "";
  const matches = top.map(({ el, role, rect, text, score }) => {
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const cx = Math.round((x + dx) * frameScale);
    const cy = Math.round((y + dy) * frameScale);
    const onScreen = rect.bottom > 0 && rect.right > 0 && rect.top < view.height && rect.left < view.width && inTop(x + dx, y + dy);
    const at = !(rect.width || rect.height) ? " (not rendered)" : onScreen ? ` at (${cx}, ${cy})` : " (off-screen)";
    const name = red.mask(el) && !isField(el) ? "" : text ?? nameOf(el, role);
    return { score, line: red.scrub(`${describe(el, role, name, red)}${at}${where}`) };
  });
  return { matches, rest: close.slice(FIND_MAX).map((m) => m.score), masked: red.masked() };
}

// Text directly inside an element (not in child elements), for elements like spans and divs
// that hold visible copy. Headings, links and buttons are covered by their names instead.
function ownTextOf(el) {
  if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return "";
  let text = "";
  for (const child of el.childNodes) if (child.nodeType === 3) text += child.data;
  text = text.replace(/\s+/g, " ").trim();
  if (text.length < 3) return "";
  // include inline children (e.g. <span>Over <b>100</b> people</span>) as part of the text
  return clean(el.textContent, 300);
}

// ---------------------------------------------------------------------------------------------
// get_page_text

function pageText(doc, { redact } = {}) {
  const red = redactor(doc, redact);
  const source = doc.body ?? doc.documentElement;
  const raw = (source.innerText ?? source.textContent ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text = red.scrub(red.markLabels(raw));
  const limit = 200000;
  return red.result(red.scrub(`Title: ${doc.title}\nURL: ${doc.location?.href}\n\n`) + (text.length > limit ? text.slice(0, limit) + "\n[Truncated]" : text));
}

// ---------------------------------------------------------------------------------------------
// Mouse

function deepElementFromPoint(doc, x, y) {
  let el = doc.elementFromPoint(x, y);
  while (el) {
    const shadow = el.openOrClosedShadowRoot;
    if (!shadow || shadow.isUAWidget()) break;
    const inner = shadow.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

// When a point lands on a frame element, the caller re-sends the op to that frame's
// actor with coordinates translated into the frame's viewport.
function frameDescent(el, x, y) {
  if (!el || !["IFRAME", "FRAME", "EMBED", "OBJECT"].includes(el.tagName) || !el.browsingContext) return null;
  const win = el.ownerDocument.defaultView;
  const r = el.getBoundingClientRect();
  const cs = win.getComputedStyle(el);
  const dx = r.left + el.clientLeft + parseFloat(cs.paddingLeft || 0);
  const dy = r.top + el.clientTop + parseFloat(cs.paddingTop || 0);
  return { descend: { id: el.browsingContext.id, args: { x: x - dx, y: y - dy, ref: undefined } } };
}

function modifierInit(modifiers) {
  const init = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
  for (const m of (modifiers ?? "").toLowerCase().split("+").map((s) => s.trim()).filter(Boolean)) {
    const key = MODIFIER_KEYS[m];
    if (key === "Meta") init.metaKey = true;
    else if (key === "Control") init.ctrlKey = true;
    else if (key === "Shift") init.shiftKey = true;
    else if (key === "Alt") init.altKey = true;
    else throw new Error(`Unknown modifier "${m}"`);
  }
  return init;
}

// Event coordinates. Events dispatched through the pres shell take their position from
// screenX/screenY, read as device pixels, so clientX/clientY alone are overwritten.
function at(win, x, y) {
  const dpr = win.devicePixelRatio;
  return { clientX: x, clientY: y, screenX: (win.mozInnerScreenX + x) * dpr, screenY: (win.mozInnerScreenY + y) * dpr };
}

// Events go through the pres shell, as real input does, so default actions run (focus, :active,
// a click after mousedown and mouseup, wheel scrolling). Where that dispatch fails (it has thrown
// NS_ERROR_UNEXPECTED over MDN's live-sample frame, which sits in shadow roots and runs out of
// process), the same event is dispatched on the target instead. The pres shell dispatch marks an
// event trusted before it checks for a pres shell, so it should stay trusted. That path skips the
// default actions, so directDispatches counts it, and click sends the click event itself.
let directDispatches = 0;

function fire(win, target, Ctor, type, init) {
  const event = new win[Ctor](type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: win,
    ...init,
  });
  try {
    return win.windowUtils.dispatchDOMEventViaPresShellForTesting(target, event);
  } catch {
    directDispatches++;
    return target.dispatchEvent(event);
  }
}

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';

// Resolves a click target: by ref (scrolled into view) or by point (with frame descent).
function pointTarget(doc, { x, y, ref }) {
  const win = doc.defaultView;
  if (ref) {
    const el = resolveRef(doc, ref);
    let r = el.getBoundingClientRect();
    const view = viewSize(win);
    if (r.top < 0 || r.left < 0 || r.bottom > view.height || r.right > view.width) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      r = el.getBoundingClientRect();
    }
    return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  if (typeof x !== "number" || typeof y !== "number") throw new Error("A coordinate or ref is required.");
  const el = deepElementFromPoint(doc, x, y);
  if (!el) throw new Error("Nothing at that point; it may be outside the viewport. Take a fresh screenshot.");
  return { el, x, y };
}

// ---------------------------------------------------------------------------------------------
// Visible cursor. Drawn as anonymous content (the layer devtools highlighters use): it renders
// above the page but is not in the page's DOM, can't be hit-tested, and page scripts can't see it.

const CURSOR_MOVE_MS = 350;
const CURSOR_IDLE_MS = 20000;
const cursors = new WeakMap(); // document -> { content, arrow, ripple, x, y, idle }

const CURSOR_CSS = `
  :host { all: initial; }
  .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; overflow: hidden; }
  .arrow {
    position: absolute; left: 0; top: 0; width: 20px; height: 28px; opacity: 0;
    filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.4)) drop-shadow(0 0 2.7px rgba(144,89,255,.5))
      drop-shadow(0 0 8.8px rgba(144,89,255,.54));
    transition: transform ${CURSOR_MOVE_MS}ms cubic-bezier(.3,.7,.3,1), opacity 300ms ease;
  }
  .arrow.on { opacity: 1; }
  .arrow.down svg { transform: scale(.92); transform-origin: 5px 4px; }
  .ripple {
    position: absolute; left: 0; top: 0; width: 36px; height: 36px; margin: -18px 0 0 -18px;
    border-radius: 50%; border: 2px solid #7542E5; box-shadow: 0 0 0 1.5px rgba(255,255,255,.85), inset 0 0 0 1.5px rgba(255,255,255,.85); opacity: 0;
  }
  .ripple.go { animation: ripple 450ms ease-out; }
  @keyframes ripple { from { opacity: .9; scale: .3; } to { opacity: 0; scale: 1.4; } }
`;

// A tailless pointer (tip at 5,4) in Firefox purple with a purple glow, so it can't be mistaken
// for the user's cursor. Built with createElementNS rather than parsed, since some pages
// (LinkedIn) break DOMParser for SVG.
const ARROW_PATH = "M5 4 L5 19.6 L9.6 15.3 L16.4 14.9 Z";

function arrowSvg(doc) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(NS, "svg");
  for (const [k, v] of [["width", "20"], ["height", "28"], ["viewBox", "0 0 20 28"]]) svg.setAttribute(k, v);
  const path = doc.createElementNS(NS, "path");
  for (const [k, v] of [
    ["d", ARROW_PATH], ["fill", "#7542E5"], ["stroke", "#fff"], ["stroke-width", "1.8"],
    ["stroke-linejoin", "round"], ["paint-order", "stroke"],
  ]) path.setAttribute(k, v);
  svg.appendChild(path);
  return svg;
}

function cursorFor(doc) {
  let c = cursors.get(doc);
  if (c) return c;
  let content;
  try {
    content = doc.insertAnonymousContent();
  } catch {
    return null; // documents without a pres shell (e.g. still loading) get no cursor
  }
  const root = content.root;
  const style = doc.createElement("style");
  style.textContent = CURSOR_CSS;
  const layer = doc.createElement("div");
  layer.className = "layer";
  const ripple = doc.createElement("div");
  ripple.className = "ripple";
  const arrow = doc.createElement("div");
  arrow.className = "arrow";
  arrow.appendChild(arrowSvg(doc));
  layer.append(ripple, arrow);
  root.append(style, layer);
  c = { content, arrow, ripple, x: null, y: null, idle: null };
  cursors.set(doc, c);
  return c;
}

// Moves the cursor to (x, y) and resolves once it has arrived. In a tab the user isn't looking at
// (animate false) it jumps there, so input isn't held up by an animation no one sees.
async function moveCursor(doc, x, y, animate = true) {
  const c = cursorFor(doc);
  if (!c) return;
  const first = c.x === null;
  c.arrow.style.transition = !animate ? "none" : first ? "opacity 300ms ease" : "";
  c.arrow.style.transform = `translate(${x - 5}px, ${y - 4}px)`;
  c.arrow.classList.add("on");
  const moved = first ? 0 : Math.hypot(x - c.x, y - c.y);
  c.x = x;
  c.y = y;
  clearTimeout(c.idle);
  c.idle = setTimeout(() => c.arrow.classList.remove("on"), CURSOR_IDLE_MS);
  if (!animate) return;
  if (moved > 2) await new Promise((r) => setTimeout(r, CURSOR_MOVE_MS));
  else if (first) await new Promise((r) => setTimeout(r, 150));
}

// Puts the cursor at (x, y) at once, so it follows a drag instead of easing behind it.
function trackCursor(doc, x, y) {
  const c = cursors.get(doc);
  if (!c) return;
  c.arrow.style.transition = "none";
  c.arrow.style.transform = `translate(${x - 5}px, ${y - 4}px)`;
  c.x = x;
  c.y = y;
}

function pressCursor(doc, down) {
  const c = cursors.get(doc);
  if (!c) return;
  c.arrow.classList.toggle("down", down);
  if (!down) {
    c.ripple.style.transform = `translate(${c.x}px, ${c.y}px)`;
    c.ripple.classList.remove("go");
    void c.ripple.getBoundingClientRect(); // restart the animation
    c.ripple.classList.add("go");
  }
}

// Hidden while a screenshot is taken, so the agent sees the page as it is. Outlines and the
// point-and-ask hint go too.
function cursorVisible(doc, { visible }) {
  const c = cursors.get(doc);
  if (c) c.arrow.style.visibility = visible ? "" : "hidden";
  const m = marks.get(doc);
  if (m) m.layer.style.visibility = visible ? "" : "hidden";
  return true;
}

// What a click hit, in words: the nearest interactive ancestor if the target itself is a bare
// span or label inside one, plus its name or text.
function clickedLabel(el) {
  let target = el;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (isInteractive(node, roleOf(node)) || node.tagName === "LABEL") {
      target = node;
      break;
    }
  }
  const role = roleOf(target);
  const text = clean(nameOf(target, role) || target.textContent, 70);
  return `${role || target.tagName.toLowerCase()}${text ? ` "${text}"` : ""}`;
}

async function click(doc, args) {
  if (!args.ref) {
    const descent = frameDescent(deepElementFromPoint(doc, args.x, args.y), args.x, args.y);
    if (descent) return descent;
  }
  let { el, x, y } = pointTarget(doc, args);
  const win = doc.defaultView;
  const button = args.button ?? 0;
  const buttons = button === 2 ? 2 : button === 1 ? 4 : 1;
  const count = args.clickCount ?? 1;
  const base = { ...at(win, x, y), button, ...modifierInit(args.modifiers) };
  const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };

  await moveCursor(doc, x, y, args.animate !== false);
  // The page may have re-rendered while the cursor moved. Like a real mouse, the click lands
  // on whatever is at the point now; a ref that was replaced has to be looked up again.
  if (!el.isConnected || !args.ref) {
    if (args.ref) throw new Error(`${args.ref} was removed from the page before the click. Call find or read_page again.`);
    el = deepElementFromPoint(doc, x, y);
    if (!el) throw new Error("Nothing at that point any more; the page changed. Take a fresh screenshot.");
  }
  pressCursor(doc, true);
  fire(win, el, "PointerEvent", "pointerover", { ...pointer, buttons: 0 });
  fire(win, el, "MouseEvent", "mouseover", { ...base, buttons: 0 });
  fire(win, el, "PointerEvent", "pointermove", { ...pointer, buttons: 0 });
  fire(win, el, "MouseEvent", "mousemove", { ...base, buttons: 0 });
  for (let i = 1; i <= count; i++) {
    fire(win, el, "PointerEvent", "pointerdown", { ...pointer, buttons, detail: i });
    const allowed = fire(win, el, "MouseEvent", "mousedown", { ...base, buttons, detail: i });
    if (allowed && i === 1 && el.isConnected) {
      const focusable = el.closest?.(FOCUSABLE);
      if (focusable && doc.activeElement !== focusable) focusable.focus();
    }
    fire(win, el, "PointerEvent", "pointerup", { ...pointer, buttons: 0, detail: i });
    const up = directDispatches;
    fire(win, el, "MouseEvent", "mouseup", { ...base, buttons: 0, detail: i });
    // Dispatched on the element, mousedown and mouseup make no click, so it is sent here.
    if (directDispatches > up && button === 0) {
      fire(win, el, "MouseEvent", "click", { ...base, buttons: 0, detail: i });
      if (i === 2) fire(win, el, "MouseEvent", "dblclick", { ...base, buttons: 0, detail: 2 });
    }
  }
  if (button === 2) {
    el.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, view: win, ...base, buttons: 0 }));
  }
  pressCursor(doc, false);
  // What was clicked is named from its text, which only a site rule can mask; without one the
  // page isn't searched, so clicks stay fast.
  const red = redactor(doc, args.redact);
  const out = red.siteRules ? red.result(red.scrub(`Clicked ${clickedLabel(el)}`)) : `Clicked ${clickedLabel(el)}`;
  // A click that may open a tab says so, and background.js waits a little longer for it.
  if (!opensTab(el, base, button)) return out;
  return typeof out === "string" ? { text: out, opens: true } : { ...out, opens: true };
}

// Whether a click here opens a new tab: a link or form that targets another window (or a
// <base target> that does), or a middle or modified click on a link.
function opensTab(el, init, button) {
  const newWindow = (t) => !!t && !["_self", "_parent", "_top"].includes(t.trim().toLowerCase());
  const base = el.ownerDocument.querySelector("base[target]")?.getAttribute("target");
  const link = el.closest?.("a[href], area[href]");
  if (link) return newWindow(link.getAttribute("target") ?? base) || button === 1 || init.metaKey || init.ctrlKey || init.shiftKey;
  const submit = el.closest?.("button, input[type=submit], input[type=image]");
  const form = submit && ["submit", "image"].includes(submit.type) ? submit.form : null;
  return !!form && newWindow(submit.getAttribute("formtarget") ?? form.getAttribute("target") ?? base);
}

async function hover(doc, args) {
  if (!args.ref) {
    const descent = frameDescent(deepElementFromPoint(doc, args.x, args.y), args.x, args.y);
    if (descent) return descent;
  }
  const { el, x, y } = pointTarget(doc, args);
  const win = doc.defaultView;
  const base = { ...at(win, x, y), buttons: 0 };
  const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
  await moveCursor(doc, x, y, args.animate !== false);
  fire(win, el, "PointerEvent", "pointerover", pointer);
  fire(win, el, "MouseEvent", "mouseover", base);
  el.dispatchEvent(new win.PointerEvent("pointerenter", { ...pointer, bubbles: false, view: win }));
  el.dispatchEvent(new win.MouseEvent("mouseenter", { ...base, bubbles: false, view: win }));
  fire(win, el, "PointerEvent", "pointermove", pointer);
  fire(win, el, "MouseEvent", "mousemove", base);
  return `Hovered ${el.tagName.toLowerCase()}`;
}

const DRAG_STEPS = 24;
const DRAG_STEP_MS = 20;

async function drag(doc, { x0, y0, x, y, animate = true }) {
  const win = doc.defaultView;
  const start = deepElementFromPoint(doc, x0, y0);
  if (!start) throw new Error("Nothing at the drag start point.");
  await moveCursor(doc, x0, y0, animate);
  pressCursor(doc, true);
  const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  fire(win, start, "PointerEvent", "pointerdown", { ...pointer, ...at(win, x0, y0), buttons: 1 });
  fire(win, start, "MouseEvent", "mousedown", { ...at(win, x0, y0), buttons: 1 });
  // Moves are spread over frames: canvas apps (Excalidraw, Figma) handle pointermove once per
  // animation frame, so a burst of moves followed by pointerup draws nothing.
  for (let i = 1; i <= DRAG_STEPS; i++) {
    const cx = x0 + ((x - x0) * i) / DRAG_STEPS;
    const cy = y0 + ((y - y0) * i) / DRAG_STEPS;
    const over = deepElementFromPoint(doc, cx, cy) ?? start;
    trackCursor(doc, cx, cy);
    fire(win, over, "PointerEvent", "pointermove", { ...pointer, ...at(win, cx, cy), buttons: 1 });
    fire(win, over, "MouseEvent", "mousemove", { ...at(win, cx, cy), buttons: 1 });
    await new Promise((r) => setTimeout(r, DRAG_STEP_MS));
  }
  await moveCursor(doc, x, y, animate);
  const end = deepElementFromPoint(doc, x, y) ?? start;
  pressCursor(doc, false);
  fire(win, end, "PointerEvent", "pointerup", { ...pointer, ...at(win, x, y), buttons: 0 });
  fire(win, end, "MouseEvent", "mouseup", { ...at(win, x, y), buttons: 0 });
  return `Dragged from ${start.tagName.toLowerCase()} to ${end.tagName.toLowerCase()}`;
}

function scrollableAncestor(win, el, vertical) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement ?? node.getRootNode()?.host) {
    const cs = win.getComputedStyle(node);
    const overflow = vertical ? cs.overflowY : cs.overflowX;
    const canScroll = vertical ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth;
    if (canScroll && (overflow === "auto" || overflow === "scroll" || overflow === "overlay")) return node;
  }
  return null;
}

function scroll(doc, args) {
  const { direction = "down", amount = 3 } = args;
  const win = doc.defaultView;
  const view = viewSize(win);
  const x = args.x ?? view.width / 2;
  const y = args.y ?? view.height / 2;
  const el = deepElementFromPoint(doc, x, y);
  const descent = args.x == null || args.noDescend ? null : frameDescent(el, x, y);
  if (descent) return descent;
  const vertical = direction === "up" || direction === "down";
  const sign = direction === "down" || direction === "right" ? 1 : -1;
  const delta = sign * amount * 100;
  const target = (el && scrollableAncestor(win, el, vertical)) || doc.scrollingElement || doc.documentElement;
  // Coming back up from a frame, the wheel event already went to that frame's element. A wheel
  // event that can't be sent at all still leaves the scroll below to happen.
  if (el && !args.noDescend) {
    try {
      fire(win, el, "WheelEvent", "wheel", {
        ...at(win, x, y), deltaMode: 0,
        deltaX: vertical ? 0 : delta, deltaY: vertical ? delta : 0,
      });
    } catch {
      // the page gets no wheel event
    }
  }
  const before = vertical ? target.scrollTop : target.scrollLeft;
  target.scrollBy({ top: vertical ? delta : 0, left: vertical ? 0 : delta, behavior: "instant" });
  const after = vertical ? target.scrollTop : target.scrollLeft;
  const which = target === doc.scrollingElement ? "page" : target.tagName.toLowerCase();
  const text = `Scrolled ${which} ${direction} by ${Math.round(Math.abs(after - before))}px`;
  // Like a real wheel, a frame that can't scroll any further passes the scroll to its parent.
  if (after === before && win.browsingContext.parent) return { bubble: text };
  return text;
}

// Answers the element's center in this frame's viewport, in CSS pixels. In a child frame it also
// answers where the frame's viewport sits on screen, so background.js can give the center in the
// top frame's viewport (screenshot coordinates), as find does.
function scrollTo(doc, { ref }) {
  const el = resolveRef(doc, ref);
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const win = doc.defaultView;
  const frame = win.browsingContext.parent ? { host: doc.location?.host || "about:blank", screenX: win.mozInnerScreenX, screenY: win.mozInnerScreenY } : null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, frame };
}

// ---------------------------------------------------------------------------------------------
// Keyboard, through nsITextInputProcessor so events are trusted and default actions run.

function focusDescent(doc) {
  const active = doc.activeElement;
  if (active && ["IFRAME", "FRAME"].includes(active.tagName) && active.browsingContext) {
    return { descend: { id: active.browsingContext.id, args: {} } };
  }
  return null;
}

// The element keys go to: the focused one, inside shadow roots too. Null when it's the page.
function keyTarget(doc) {
  let el = doc.activeElement;
  for (let shadow = el?.openOrClosedShadowRoot; shadow && !shadow.isUAWidget() && shadow.activeElement; shadow = el.openOrClosedShadowRoot) {
    el = shadow.activeElement;
  }
  return el && el !== doc.body && el !== doc.documentElement ? el : null;
}

// Where keys went, and the value they left, so the result shows whether they did anything:
// 'combobox "Flavor" = "Sardine"', or 'no element focused; keys went to the page'. In a child
// frame (api.js sends keys to the frame the last click landed in), the frame is named.
function keyReport(doc, redact) {
  const el = keyTarget(doc);
  const frame = doc.defaultView.browsingContext.parent ? ` in frame ${doc.location?.host || "about:blank"}` : "";
  if (!el) return `no element focused${frame}; keys went to the page`;
  const red = redactor(doc, redact);
  const role = roleOf(el);
  const name = clean(nameOf(el, role), 70);
  let value = "";
  if (red.mask(el)) value = ` ${red.marker(el)}`;
  else if (el.tagName === "SELECT") value = ` = ${JSON.stringify(Array.from(el.selectedOptions).map((o) => clean(o.textContent, 60)).join(", "))}`;
  else if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) value = el.checked ? " (checked)" : " (unchecked)";
  else if (el.tagName === "INPUT" && el.type === "password") value = el.value ? " = (set)" : " = (empty)";
  else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") value = ` = ${JSON.stringify(clean(el.value, 100))}`;
  else if (el.isContentEditable) value = ` = ${JSON.stringify(clean(el.innerText, 100))}`;
  const out = `${role || el.tagName.toLowerCase()}${name ? ` ${JSON.stringify(name)}` : ""}${value}${frame}`;
  // As with clicks, the page is only searched for masked text when a site rule could mask a name.
  return red.result(red.siteRules ? red.scrub(out) : out);
}

// "<what> → <report>", keeping the redaction mark when the report has one.
function reported(what, report) {
  return typeof report === "string" ? `${what} → ${report}` : { ...report, text: `${what} → ${report.text}` };
}

function textInputProcessor(win) {
  const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
  if (!tip.beginInputTransactionForTests(win)) throw new Error("Could not start keyboard input in this page.");
  return tip;
}

function keyboardEvent(win, tip, key) {
  const init = { key };
  if ([...key].length === 1) {
    try {
      init.code = tip.guessCodeValueOfPrintableKeyInUSEnglishKeyboardLayout(key);
      init.keyCode = tip.guessKeyCodeValueOfPrintableKeyInUSEnglishKeyboardLayout(key);
    } catch {
      // non-US characters have no guessable code; key alone is enough
    }
  } else {
    try {
      init.code = tip.computeCodeValueOfNonPrintableKey(key);
    } catch {
      // unknown key name
    }
  }
  return new win.KeyboardEvent("", init);
}

function press(win, tip, key) {
  const ev = keyboardEvent(win, tip, key);
  tip.keydown(ev);
  tip.keyup(ev);
}

function type(doc, { text, redact }) {
  const descent = focusDescent(doc);
  if (descent) return descent;
  const win = doc.defaultView;
  const tip = textInputProcessor(win);
  for (const ch of text) {
    if (ch === "\n") press(win, tip, "Enter");
    else if (ch === "\t") press(win, tip, "Tab");
    else if (ch !== "\r") press(win, tip, ch);
  }
  return reported(`Typed ${[...text].length} character(s)`, keyReport(doc, redact));
}

function parseCombo(combo) {
  const parts = combo.split("+").filter((p) => p !== "");
  if (combo.endsWith("++")) parts.push("+");
  const modifiers = [];
  let key = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIER_KEYS[lower] && part !== parts[parts.length - 1]) modifiers.push(MODIFIER_KEYS[lower]);
    else if (MODIFIER_KEYS[lower]) key = MODIFIER_KEYS[lower];
    else key = NAMED_KEYS[lower] ?? (part.length === 1 ? part : part[0].toUpperCase() + part.slice(1));
  }
  if (!key) throw new Error(`No key in "${combo}"`);
  return { modifiers, key };
}

function key(doc, { keys, repeat = 1, redact }) {
  const descent = focusDescent(doc);
  if (descent) return descent;
  const win = doc.defaultView;
  const combos = keys.trim().split(/\s+/).map(parseCombo);
  for (const { key: name } of combos) {
    if (/^[=\-0]$/.test(name) && combos.some((c) => c.modifiers.includes("Meta") || c.modifiers.includes("Control"))) {
      throw new Error("Page zoom shortcuts are not supported. Use the zoom action instead.");
    }
  }
  const tip = textInputProcessor(win);
  for (let r = 0; r < repeat; r++) {
    for (const { modifiers, key: name } of combos) {
      const mods = modifiers.map((m) => keyboardEvent(win, tip, m));
      for (const m of mods) tip.keydown(m);
      press(win, tip, name);
      for (const m of mods.reverse()) tip.keyup(m);
    }
  }
  return reported(`Pressed ${keys}${repeat > 1 ? ` x${repeat}` : ""}`, keyReport(doc, redact));
}

// ---------------------------------------------------------------------------------------------
// form_input

// Filling a masked field works as usual; only what the result reads back is masked.
function formInput(doc, { ref, value, redact }) {
  const el = resolveRef(doc, ref);
  const win = doc.defaultView;
  const red = redactor(doc, redact);
  const dispatch = (type) => el.dispatchEvent(new win.Event(type, { bubbles: true }));

  if (el.tagName === "SELECT") {
    const wanted = String(value).trim().toLowerCase();
    const options = Array.from(el.options);
    const option =
      options.find((o) => o.value === String(value)) ??
      options.find((o) => o.textContent.trim().toLowerCase() === wanted) ??
      options.find((o) => o.textContent.trim().toLowerCase().includes(wanted));
    if (!option) {
      const list = options.map((o) => JSON.stringify(clean(o.textContent, 50))).join(", ");
      throw new Error(`No option matching ${JSON.stringify(value)}. Options: ${list}`);
    }
    el.value = option.value;
    option.selected = true;
    dispatch("input");
    dispatch("change");
    if (red.mask(el)) return red.result(`Selected an option in ${ref} ${red.marker(el)}`);
    return `Selected ${JSON.stringify(clean(option.textContent, 80))} in ${ref}`;
  }

  if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
    const want = value === true || value === "true" || value === 1 || value === "on" || value === "checked";
    if (el.checked !== want) el.click();
    if (red.mask(el)) return red.result(`Set ${ref} ${red.marker(el)}`);
    return `${ref} is now ${el.checked ? "checked" : "unchecked"}`;
  }

  const role = el.getAttribute("role");
  if ((role === "checkbox" || role === "switch" || role === "radio") && typeof value === "boolean") {
    if ((el.getAttribute("aria-checked") === "true") !== value) el.click();
    return `${ref} aria-checked is now ${el.getAttribute("aria-checked")}`;
  }

  if (el.isContentEditable) {
    el.focus();
    win.getSelection().selectAllChildren(el);
    doc.execCommand("insertText", false, String(value));
    return `Set text of ${ref}`;
  }

  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    el.focus();
    // Assigning through the Xray wrapper calls the native setter, skipping any
    // framework-installed setter on the instance, so React sees a real change.
    el.value = String(value);
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: String(value) }));
    dispatch("change");
    if (red.mask(el)) return red.result(`Set ${ref} ${red.marker(el)}`);
    return `Set ${ref} to ${JSON.stringify(clean(el.value, 100))}`;
  }

  throw new Error(`${ref} is a ${el.tagName.toLowerCase()}, not a form field. Use computer clicks for custom widgets.`);
}

// ---------------------------------------------------------------------------------------------
// javascript_tool: evaluated in a sandbox whose prototype is the page window, so page globals
// and the DOM are reachable while the page's CSP (no eval) does not apply.

const sandboxes = new WeakMap();

// Evaluated inside the sandbox (via its source text), so everything it touches is sandbox-side.
function sandboxRunner() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const indirectEval = eval;

  function serialize(value) {
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value;
    if (typeof value === "function") return "[function " + (value.name || "anonymous") + "]";
    if (value && typeof value.nodeType === "number" && typeof value.nodeName === "string") {
      const html = value.outerHTML ?? value.textContent ?? value.nodeName;
      return html.length > 3000 ? html.slice(0, 3000) + "…" : html;
    }
    const seen = new WeakSet();
    try {
      const json = JSON.stringify(value, (k, v) => {
        if (v && typeof v === "object") {
          if (typeof v.nodeType === "number" && typeof v.nodeName === "string") return "<" + v.nodeName.toLowerCase() + ">";
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      }, 2);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  }

  // Index just past the last top-level ";" or newline that ends a statement, skipping strings,
  // template literals, comments and brackets. Everything after it is the final statement.
  function lastStatementStart(code) {
    let depth = 0;
    let last = 0;
    for (let i = 0; i < code.length; i++) {
      const c = code[i];
      if (c === "/" && code[i + 1] === "/") {
        const end = code.indexOf("\n", i);
        if (end < 0) break;
        i = end - 1;
        continue;
      }
      if (c === "/" && code[i + 1] === "*") {
        const end = code.indexOf("*/", i + 2);
        if (end < 0) break;
        i = end + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        for (i++; i < code.length && code[i] !== c; i++) if (code[i] === "\\") i++;
        continue;
      }
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        depth--;
        if (depth === 0 && c === "}") last = i + 1;
      } else if (depth === 0 && (c === ";" || c === "\n")) last = i + 1;
    }
    return last;
  }

  function withReturn(code) {
    const body = code.replace(/[\s;]+$/, "");
    let start = lastStatementStart(body);
    while (start < body.length && /\s/.test(body[start])) start++;
    const tail = body.slice(start);
    if (!tail || /^(return|const|let|var|if|for|while|do|switch|try|throw|function|class|import|export)\b/.test(tail)) return body;
    return body.slice(0, start) + "return " + tail;
  }

  return async function run(code) {
    try {
      let result;
      if (/\bawait\b/.test(code)) {
        let fn;
        try {
          fn = new AsyncFunction("return (" + code + "\n)");
        } catch {
          try {
            fn = new AsyncFunction(withReturn(code));
          } catch {
            fn = new AsyncFunction(code);
          }
        }
        result = await fn();
      } else {
        result = await indirectEval(code);
      }
      return { ok: true, value: serialize(result) };
    } catch (e) {
      return { ok: false, value: (e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : String(e)) };
    }
  };
}

const SANDBOX_RUNNER = `(${sandboxRunner})()`;

// A masked field's value in the script's result (or error) is masked like anywhere else. That
// only catches the value as it is: a script can still read it and return it transformed.
async function evaluate(doc, { code, redact }) {
  const win = doc.defaultView;
  let sandbox = sandboxes.get(win);
  if (!sandbox) {
    sandbox = Cu.Sandbox(win, {
      sandboxPrototype: win,
      wantXrays: false,
      sameZoneAs: win,
      sandboxName: "Firefox Agent Bridge javascript_tool",
    });
    sandbox.__claudeRun = Cu.evalInSandbox(SANDBOX_RUNNER, sandbox);
    sandboxes.set(win, sandbox);
  }
  const outcome = await Cu.evalInSandbox("__claudeRun", sandbox)(code);
  const value = String(outcome.value);
  const limit = 100000;
  const red = redactor(doc, redact);
  const text = red.scrub(value.length > limit ? value.slice(0, limit) + "\n[Truncated]" : value);
  if (!outcome.ok) throw new Error(text);
  return red.result(text);
}

// ---------------------------------------------------------------------------------------------
// file_upload

function setFiles(win, input, files) {
  const list = files.map((f) => new win.File([Cu.cloneInto(f.bytes, win)], f.name, { type: f.type }));
  input.mozSetFileArray(list);
  input.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  return Array.from(input.files).map((f) => `${f.name} (${f.size} bytes)`).join(", ");
}

// Clicks an upload button whose file input only exists after the click (LinkedIn Easy Apply),
// with the page's file-input click()/showPicker() swapped for a capture, so no native picker
// opens. Resolves with the input the page tried to open.
async function captureFileInput(doc, button) {
  const win = doc.defaultView;
  const proto = Cu.waiveXrays(win).HTMLInputElement.prototype;
  const originals = { click: proto.click, showPicker: proto.showPicker };
  const hadOwn = { click: Object.hasOwn(proto, "click"), showPicker: Object.hasOwn(proto, "showPicker") };
  let captured = null;
  const intercept = (name) =>
    Cu.exportFunction(function (...args) {
      if (this.type === "file") {
        captured = this;
        return undefined;
      }
      return originals[name].apply(this, args);
    }, proto, { defineAs: name });
  intercept("click");
  intercept("showPicker");
  try {
    await click(doc, { ref: refFor(button) });
    for (let i = 0; i < 20 && !captured; i++) await new Promise((r) => setTimeout(r, 100));
  } finally {
    for (const name of ["click", "showPicker"]) {
      if (hadOwn[name]) proto[name] = originals[name];
      else delete proto[name];
    }
  }
  return captured ? Cu.unwaiveXrays(captured) : null;
}

async function upload(doc, { ref, files }) {
  let el = resolveRef(doc, ref);
  const win = doc.defaultView;
  if (!(el.tagName === "INPUT" && el.type === "file")) {
    const inner = el.control ?? el.querySelector?.('input[type="file"]');
    if (inner?.type === "file") {
      el = inner;
    } else {
      const input = await captureFileInput(doc, el);
      if (!input) {
        throw new Error(`${ref} is a ${el.tagName.toLowerCase()} and clicking it did not ask for a file. Use find for "file input" to get the input's ref.`);
      }
      return `Clicked ${ref} with the file picker suppressed and set its file input: ${setFiles(win, input, files)}`;
    }
  }
  return `Set file(s) on ${ref}: ${setFiles(win, el, files)}`;
}

// ---------------------------------------------------------------------------------------------
// Point and ask. While the chat panel is open, api.js arms the tab its window shows (pointArm,
// in every frame). Holding Alt there outlines the element under the pointer in ink, and
// Alt+click attaches it to the chat instead of reaching the page. The other way, mark draws the
// agent's purple outline and label on an element by ref. Both are anonymous content, like the
// cursor. Frames coordinate through the parent actor ("point" messages come back to every frame
// as pointSync): the top frame shows the hint, and only the frame under the pointer an outline.

const MARK_PAD = 3;
const MARK_HOVER_MS = 10000; // a hover whose end never arrived (the panel closed) still clears
const MARK_REVEAL_MS = 2500;
const ADDED_MS = 1200;
const CROP_HOLD_MS = 1000;
const FRAME_TAGS = new Set(["IFRAME", "FRAME", "EMBED", "OBJECT"]);
// What an Alt+click keeps from the page; the pick itself happens on pointerdown.
const PICK_EVENTS = new Set(["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"]);
// Roles an Alt+click stops at on its way up from what is under the pointer, when no control is.
const PICK_ROLES = new Set([
  "img", "figure", "heading", "paragraph", "listitem", "list", "cell", "columnheader", "row", "table",
  "article", "form", "group", "dialog", "alertdialog", "region", "navigation", "complementary",
  "tabpanel", "toolbar", "search", "status", "alert", "canvas", "video", "audio",
]);
const PICK_TAGS = { FIGURE: "figure", CANVAS: "canvas", VIDEO: "video", AUDIO: "audio", PICTURE: "img", svg: "img" };
const HINT = Services.appinfo.OS === "Darwin" ? "⌥ Click to add to chat" : "Alt+click to add to chat";

const points = new WeakMap(); // document -> { armed, x, y, shown, owner, hold }
const marks = new WeakMap(); // document -> { win, layer, hint, pick, agent, raf }

// Ink is the page's text color: near-black, or near-white on a dark page. The agent's is purple.
const MARK_CSS = `
  :host { all: initial; }
  .layer {
    position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; overflow: hidden;
    --ink: #15141a; --paper: #fbfbfe;
    font: 12px/16px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  .layer.dark { --ink: #fbfbfe; --paper: #15141a; }
  .hint {
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%); padding: 3px 10px;
    border-radius: 6px; background: var(--ink); color: var(--paper); white-space: nowrap;
  }
  .box { position: absolute; border-radius: 6px; box-shadow: 0 0 0 2px var(--ink), 0 0 0 3px var(--paper); }
  .box.agent { box-shadow: 0 0 0 2px #7542e5, 0 0 0 3px #fff; }
  .tag {
    position: absolute; left: -2px; bottom: calc(100% + 5px); max-width: min(320px, 90vw);
    padding: 1px 6px; border-radius: 4px; background: var(--ink); color: var(--paper);
    font-size: 11px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .box.agent .tag { background: #7542e5; color: #fff; }
  .box.below .tag { bottom: auto; top: calc(100% + 5px); }
  [hidden] { display: none; }
`;

function marksFor(doc) {
  let m = marks.get(doc);
  if (m) return m;
  let content;
  try {
    content = doc.insertAnonymousContent();
  } catch {
    return null; // no pres shell (still loading, or display: none)
  }
  const div = (cls, text = "") => {
    const n = doc.createElement("div");
    n.className = cls;
    n.textContent = text;
    return n;
  };
  const box = (cls) => {
    const node = div(`box ${cls}`);
    const tag = div("tag");
    node.append(tag);
    node.hidden = true;
    return { node, tag, el: null, timer: null };
  };
  const style = doc.createElement("style");
  style.textContent = MARK_CSS;
  const layer = div("layer");
  const hint = div("hint", HINT);
  hint.hidden = true;
  m = { win: doc.defaultView, layer, hint, pick: box("pick"), agent: box("agent"), raf: 0 };
  layer.append(hint, m.pick.node, m.agent.node);
  content.root.append(style, layer);
  marks.set(doc, m);
  return m;
}

function pageIsDark(doc) {
  const win = doc.defaultView;
  for (const node of [doc.body, doc.documentElement]) {
    if (!node) continue;
    const [r, g, b, a] = (win.getComputedStyle(node).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
    if (r != null && (a == null || a > 0.5)) return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }
  return win.matchMedia("(prefers-color-scheme: dark)").matches;
}

function placeBox(box) {
  const r = box.el.getBoundingClientRect();
  const s = box.node.style;
  s.left = `${r.left - MARK_PAD}px`;
  s.top = `${r.top - MARK_PAD}px`;
  s.width = `${r.width + 2 * MARK_PAD}px`;
  s.height = `${r.height + 2 * MARK_PAD}px`;
  box.node.classList.toggle("below", r.top - MARK_PAD < 26);
}

// Shown boxes follow their element through scrolling and layout changes.
function follow(m) {
  if (m.raf) return;
  const tick = () => {
    m.raf = 0;
    for (const b of [m.pick, m.agent]) {
      if (b.el && !b.el.isConnected) hideBox(b);
      else if (b.el) placeBox(b);
    }
    if (m.pick.el || m.agent.el) m.raf = m.win.requestAnimationFrame(tick);
  };
  m.raf = m.win.requestAnimationFrame(tick);
}

function showBox(m, box, el, label) {
  clearTimeout(box.timer);
  box.el = el;
  box.tag.textContent = label;
  box.node.hidden = false;
  placeBox(box);
  follow(m);
}

function hideBox(box) {
  clearTimeout(box.timer);
  box.el = null;
  box.node.hidden = true;
}

// What an Alt+click picks: the nearest control around the point, else the nearest element that
// stands for something (an image, a figure, a paragraph, a table...), else what is under the
// pointer. One that covers most of the viewport is too broad, and the element itself wins.
function pickTarget(hit) {
  const doc = hit.ownerDocument;
  const win = doc.defaultView;
  const up = (node) => node.parentElement ?? node.getRootNode()?.host ?? null;
  const within = (node) => node && node !== doc.body && node !== doc.documentElement;
  const fit = (node) => {
    const r = node.getBoundingClientRect();
    const view = viewSize(win);
    return r.width * r.height > view.width * view.height * 0.6 ? hit : node;
  };
  for (let node = hit; within(node); node = up(node)) {
    if (isInteractive(node, roleOf(node))) return fit(node);
  }
  for (let node = hit; within(node); node = up(node)) {
    if (node.tagName === "svg" && node.ownerSVGElement) continue;
    if (PICK_ROLES.has(roleOf(node) ?? PICK_TAGS[node.tagName])) return fit(node);
  }
  return hit;
}

const pickRole = (el) => roleOf(el) ?? PICK_TAGS[el.tagName] ?? el.tagName.toLowerCase();

function pickName(el, role) {
  const own = nameOf(el, role);
  if (own) return own;
  const caption = el.querySelector?.("figcaption, caption, legend, h1, h2, h3, h4, h5, h6, [role=heading], title");
  return clean(caption?.textContent || el.innerText || el.textContent, 60);
}

function pickLabel(el) {
  const role = pickRole(el);
  const name = pickName(el, role);
  return name ? `${role} · ${clean(name, 60)}` : role;
}

function visibleText(el) {
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.type === "password" ? "" : clean(el.value, 1000);
  return clean(el.innerText ?? el.textContent, 1000);
}

// A frame starts pointing (asks for the hint) or takes the outline over from another frame.
function aim(actor, doc, p) {
  if (Date.now() < p.hold) return;
  const hit = deepElementFromPoint(doc, p.x, p.y);
  // Over a child frame, that frame draws the outline.
  const target = hit && !FRAME_TAGS.has(hit.tagName) && hit !== doc.body && hit !== doc.documentElement ? pickTarget(hit) : null;
  if (!p.shown || (target && !p.owner)) actor.sendAsyncMessage("point", { hint: true, owner: target ? actor.browsingContext.id : null });
  p.shown = true;
  p.owner = !!target;
  const m = marksFor(doc);
  if (!m) return;
  if (!target) return hideBox(m.pick);
  if (target === m.pick.el) return;
  m.layer.classList.toggle("dark", pageIsDark(doc));
  showBox(m, m.pick, target, pickLabel(target));
}

function endPoint(actor, doc, p) {
  p.shown = false;
  p.owner = false;
  clearPoint(doc);
  actor.sendAsyncMessage("point", { clear: true });
}

function clearPoint(doc) {
  const m = marks.get(doc);
  if (!m) return;
  m.hint.hidden = true;
  hideBox(m.pick);
}

// The element goes to the extension (through the parent actor) with where it is, so background
// can crop it out of a capture of the tab. The outline is hidden meanwhile; pointAdded brings it
// back once the capture is done.
function pick(actor, doc, p, x, y) {
  const hit = deepElementFromPoint(doc, x, y);
  if (!hit || FRAME_TAGS.has(hit.tagName) || hit === doc.body || hit === doc.documentElement) return;
  const el = pickTarget(hit);
  const win = doc.defaultView;
  const view = viewSize(win);
  const role = pickRole(el);
  const r = el.getBoundingClientRect();
  const x0 = Math.max(0, r.left);
  const y0 = Math.max(0, r.top);
  p.hold = Date.now() + CROP_HOLD_MS;
  const m = marks.get(doc);
  if (m) hideBox(m.pick);
  actor.sendAsyncMessage("pick", {
    ref: refFor(el),
    role,
    name: pickName(el, role),
    text: visibleText(el),
    rect: { x: x0, y: y0, width: Math.max(0, Math.min(view.width, r.right) - x0), height: Math.max(0, Math.min(view.height, r.bottom) - y0) },
    frame: { x: win.mozInnerScreenX, y: win.mozInnerScreenY },
    url: doc.location?.href ?? "",
    title: doc.title,
  });
}

// Alt alone: Alt with Cmd, Ctrl or Shift is some other shortcut.
const altOnly = (e) => e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;

function onPointEvent(actor, doc, p, e) {
  if (PICK_EVENTS.has(e.type)) {
    if (!altOnly(e) || e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "pointerdown") pick(actor, doc, p, e.clientX, e.clientY);
    return;
  }
  switch (e.type) {
    case "mousemove":
      p.x = e.clientX;
      p.y = e.clientY;
      if (altOnly(e)) aim(actor, doc, p);
      else if (p.shown) endPoint(actor, doc, p);
      break;
    case "keydown":
      if (e.key === "Alt" && altOnly(e) && !e.repeat) {
        if (p.x != null) aim(actor, doc, p);
        else if (!p.shown) {
          p.shown = true;
          actor.sendAsyncMessage("point", { hint: true, owner: null });
        }
      } else if (e.key === "Escape" && p.shown) endPoint(actor, doc, p);
      break;
    case "keyup":
      if (e.key !== "Alt" || !p.shown) break;
      e.preventDefault(); // on Windows and Linux, a lone Alt would show the menu bar
      endPoint(actor, doc, p);
      break;
    case "blur":
      if (e.target === doc.defaultView && p.shown) endPoint(actor, doc, p);
      break;
    case "pagehide":
      p.shown = false;
      clearPoint(doc);
      break;
  }
}

function pointArm(doc, { on }) {
  const p = points.get(doc) ?? { armed: false, x: null, y: null, shown: false, owner: false, hold: 0 };
  Object.assign(p, { armed: !!on, shown: false, owner: false });
  points.set(doc, p);
  clearPoint(doc);
  return true;
}

// What another frame (or this one) said, relayed by the parent actor.
function pointSync(doc, { hint, owner, clear }) {
  const p = points.get(doc);
  if (!p?.armed) return false;
  const bc = doc.defaultView.browsingContext;
  if (clear) {
    Object.assign(p, { shown: false, owner: false });
    clearPoint(doc);
    return true;
  }
  if (hint && !bc.parent) {
    const m = marksFor(doc);
    if (m) {
      m.layer.classList.toggle("dark", pageIsDark(doc));
      m.hint.hidden = false;
      p.shown = true;
    }
  }
  if (owner !== bc.id) {
    p.owner = false;
    const m = marks.get(doc);
    if (m) hideBox(m.pick);
  }
  return true;
}

// A pick's name and text as the agent may read them. The pick itself is made without the
// redaction rules, so background asks for these again with them before the pick goes anywhere.
function pickInfo(doc, { ref, redact }) {
  const el = resolveRef(doc, ref);
  const red = redactor(doc, redact);
  const role = pickRole(el);
  if (red.mask(el)) return { name: isField(el) ? red.scrub(pickName(el, role)) : "", text: red.marker(el) };
  return { name: red.scrub(pickName(el, role)), text: red.scrub(visibleText(el)) };
}

function pointAdded(doc, { ref }) {
  const p = points.get(doc);
  if (p) p.hold = 0;
  const el = resolveRef(doc, ref);
  const m = marksFor(doc);
  if (!m) return false;
  showBox(m, m.pick, el, "Added to chat");
  m.pick.timer = setTimeout(() => {
    if (m.pick.el === el && !p?.shown) hideBox(m.pick);
  }, ADDED_MS);
  return true;
}

// The agent pointing at an element (a hover or click on its link in the panel). A click
// scrolls it into view, and its outline stays up a moment; clear takes a hover's down.
function mark(doc, { ref, label, reveal, clear }) {
  if (clear) {
    const m = marks.get(doc);
    if (m?.agent.el && m.agent.el === docState(doc).byRef.get(ref)) hideBox(m.agent);
    return true;
  }
  const el = resolveRef(doc, ref);
  const m = marksFor(doc);
  if (!m) return false;
  if (reveal) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  showBox(m, m.agent, el, clean(label, 80) || ref);
  m.agent.timer = setTimeout(() => hideBox(m.agent), reveal ? MARK_REVEAL_MS : MARK_HOVER_MS);
  return true;
}

// Teach: recording what the user does in a tab, and finding a recorded target again on replay
// (docs/teach.md). The user's trusted clicks, typing, selects and Enter presses reach
// handleEvent below (api.js registers the events) in tabs the parent has listed in sharedData,
// and each becomes a step sent to the parent actor. Nothing typed into a password or other
// secret field leaves this process: the step only says where the value should come from.

const RECORDING_KEY = "firefox-agent-bridge:recording";
const RECORD_REDACT_KEY = "firefox-agent-bridge:record-redact";
const TYPE_SETTLE_MS = 600;
const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "number", "password", "date", "time", "datetime-local", "month", "week"]);

function isTextField(el) {
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return TEXT_TYPES.has(el.type);
  return el.isContentEditable;
}

// "keychain" for a saved password, "ask" for what changes every time (one-time codes, card
// security codes), null for an ordinary field.
function secretKind(el) {
  const auto = String(el.autocomplete ?? "").toLowerCase();
  const hints = [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, nameOf(el, roleOf(el))].filter(Boolean).join(" ");
  if (/one-time-code|cc-/.test(auto) || /\b(otp|2fa|one.?time|verification code|security code|cvv|cvc|csc|ssn|social security)\b/i.test(hints)) return "ask";
  if (el.type === "password" || /password/.test(auto) || /\b(password|passcode|passphrase|pin)\b/i.test(hints)) return "keychain";
  return null;
}

// A selector that is likely to survive a reload: an id that doesn't look generated, a test or
// form attribute, or tag and position under the nearest such ancestor.
function cssPath(el) {
  const quote = (v) => `"${v.replace(/["\\]/g, "\\$&")}"`;
  const parts = [];
  for (let node = el; node?.nodeType === 1 && parts.length < 5; node = node.parentElement) {
    if (node.id && !/\d{3,}|[:.\s]/.test(node.id) && node.id.length < 60) {
      parts.unshift(`#${node.ownerDocument.defaultView.CSS.escape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const attr = ["data-testid", "data-test-id", "name", "aria-label"].find((a) => node.getAttribute(a) && node.getAttribute(a).length < 80);
    if (attr) part += `[${attr}=${quote(node.getAttribute(attr))}]`;
    else if (node.parentElement) {
      const same = Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (node === node.ownerDocument.body) break;
  }
  return parts.join(" > ");
}

// Short text around an element, from the nearest ancestor that says more than the element does:
// the row a Renew button sits in, the label beside an unnamed field.
function nearText(el, name) {
  for (let node = el.parentElement, i = 0; node && i < 4; node = node.parentElement, i++) {
    const text = clean(node.textContent, 121);
    if (text.length > 120) return "";
    if (text && text !== name) return text;
  }
  return "";
}

// An element's accessible name, or for one with no role (a clickable div), its own text.
const targetName = (el, role) => nameOf(el, role) || (role ? "" : clean(ownTextOf(el), 150));

function targetOf(el) {
  const role = roleOf(el);
  const name = targetName(el, role);
  const target = { role: role || el.tagName.toLowerCase(), name };
  const css = cssPath(el);
  if (css) target.css = css;
  const near = nearText(el, name);
  if (near) target.near = near;
  return target;
}

// What a click was on: the nearest interactive ancestor or label, as clickedLabel reads it.
function clickTarget(el) {
  for (let node = el; node?.nodeType === 1; node = node.parentElement) {
    if (isInteractive(node, roleOf(node)) || node.tagName === "LABEL") return node;
  }
  return el;
}

const composedTarget = (event) => {
  const t = event.composedTarget ?? event.composedPath?.()[0] ?? event.target;
  return t?.nodeType === 1 ? t : t?.parentElement ?? null;
};

// The redaction rules background gave when recording started: a field they mask is recorded
// like a secret one (no value), and masked text is kept out of target names.
function recordRedactor(doc) {
  let rules = null;
  try {
    rules = Services.cpmm.sharedData.get(RECORD_REDACT_KEY) ?? null;
  } catch {
    // no rules: only the built-in secret fields are left out
  }
  return rules ? redactor(doc, rules) : null;
}

function recordedTarget(el, red) {
  const target = targetOf(el);
  if (!red) return target;
  target.name = red.scrub(target.name, false);
  if (target.near) target.near = red.scrub(target.near, false);
  return target;
}

function isRecording(actor) {
  try {
    const ids = Services.cpmm.sharedData.get(RECORDING_KEY);
    return Array.isArray(ids) && ids.includes(actor.browsingContext.browserId);
  } catch {
    return false;
  }
}

function recordStep(actor, step) {
  try {
    actor.sendAsyncMessage("record", { ...step, url: actor.document?.location?.href ?? "" });
  } catch {
    // the page is going away
  }
}

// Typing is reported once the field has been quiet a moment, and again after each later pause;
// every report carries the same field id, so it stays one step.
const fieldIds = new WeakMap();
let nextField = 1;

function flushTyping(actor) {
  const r = actor.rec;
  if (!r?.typing) return;
  clearTimeout(r.timer);
  const el = r.typing;
  r.typing = null;
  if (!el.isConnected) return;
  if (!fieldIds.has(el)) fieldIds.set(el, `f${nextField++}`);
  const red = recordRedactor(el.ownerDocument);
  const step = { action: "type", target: recordedTarget(el, red), field: fieldIds.get(el) };
  const secret = secretKind(el) ?? (red?.mask(el) ? "ask" : null);
  if (secret) step.secret = secret;
  else step.value = String(el.isContentEditable ? el.innerText : el.value).slice(0, 2000);
  recordStep(actor, step);
}

function onRecordEvent(actor, event) {
  const r = (actor.rec ??= { typing: null, timer: 0, label: null, enterAt: 0 });
  const el = composedTarget(event);
  switch (event.type) {
    case "click": {
      // A double click is one step; a label's click is followed by one on its control; Enter in
      // a form's field clicks its submit button, and the Enter is already the step.
      if (event.button !== 0 || event.detail > 1 || !el) return;
      if (event.detail === 0 && Date.now() - (r.enterAt ?? 0) < 200) return;
      const target = clickTarget(el);
      if (r.label && r.label.control === target && Date.now() - r.label.at < 100) return;
      if (target.closest?.("select")) return; // opening a select; its change is the step
      // Focusing a field, directly or through its label; the typing is the step.
      if (isTextField(target) || (target.tagName === "LABEL" && target.control && isTextField(target.control))) return;
      flushTyping(actor);
      r.label = target.tagName === "LABEL" ? { control: target.control, at: Date.now() } : null;
      recordStep(actor, { action: "click", target: recordedTarget(target, recordRedactor(target.ownerDocument)) });
      return;
    }
    case "input":
      if (!el || !isTextField(el)) return;
      if (r.typing && r.typing !== el) flushTyping(actor);
      r.typing = el;
      clearTimeout(r.timer);
      r.timer = setTimeout(() => flushTyping(actor), TYPE_SETTLE_MS);
      return;
    case "change":
      if (el?.tagName === "SELECT") {
        flushTyping(actor);
        const red = recordRedactor(el.ownerDocument);
        const step = { action: "select", target: recordedTarget(el, red) };
        if (red?.mask(el)) step.secret = "ask";
        else step.value = clean(Array.from(el.selectedOptions).map((o) => o.textContent).join(", "), 200);
        recordStep(actor, step);
      } else if (el && el === r.typing) flushTyping(actor);
      return;
    case "keydown":
      if (event.key !== "Enter" || event.isComposing || !el || el.tagName !== "INPUT" || !isTextField(el)) return;
      flushTyping(actor);
      r.enterAt = Date.now();
      recordStep(actor, { action: "key", key: "Enter", target: recordedTarget(el, recordRedactor(el.ownerDocument)) });
      return;
    case "pagehide":
      flushTyping(actor);
  }
}

// Replay: finds a recorded target on the page as it is now. Role and accessible name first, then
// the CSS selector, then looser matches; among several, the one whose surroundings or selector
// match the recording. Returns a ref for the click, fill and formInput ops.
const norm = (s) => clean(s, 300).toLowerCase();

function locate(doc, { target }) {
  const want = { role: target?.role ?? "", name: norm(target?.name), css: target?.css ?? "", near: norm(target?.near) };
  const els = [];
  const walk = (node) => {
    for (const child of renderedChildren(node)) {
      if (child.nodeType !== 1 || SKIP_TAGS.has(child.tagName) || child.getAttribute("aria-hidden") === "true") continue;
      els.push(child);
      walk(child);
    }
  };
  walk(doc.body ?? doc.documentElement);
  const rendered = (el) => isRendered(el) || (el.tagName === "INPUT" && el.type === "file");
  // Names are worked out only for elements that get that far, and each only once.
  const roles = new Map();
  const names = new Map();
  const roleAt = (el) => {
    if (!roles.has(el)) roles.set(el, roleOf(el) || el.tagName.toLowerCase());
    return roles.get(el);
  };
  const nameAt = (el) => {
    if (!names.has(el)) names.set(el, norm(targetName(el, roleOf(el))));
    return names.get(el);
  };
  const nearOf = (el) => norm(nearText(el, targetName(el, roleOf(el))));
  let bySelector = null;
  try {
    bySelector = want.css ? doc.querySelector(want.css) : null;
  } catch {
    // not a selector this page's engine accepts
  }
  if (bySelector && !rendered(bySelector)) bySelector = null;
  const pick = (list) => {
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    return list.find((el) => want.near && nearOf(el) === want.near) ?? list.find((el) => el === bySelector) ?? list[0];
  };
  const loose = (a, b) => a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
  const candidates = els.filter(rendered);
  const tiers = [
    ["role and name", () => want.name && candidates.filter((el) => roleAt(el) === want.role && nameAt(el) === want.name)],
    ["selector", () => bySelector && (!want.name || roleAt(bySelector) === want.role) && [bySelector]],
    ["role and a similar name", () => want.name && candidates.filter((el) => roleAt(el) === want.role && loose(nameAt(el), want.name))],
    ["name", () => want.name && candidates.filter((el) => isInteractive(el, roleOf(el)) && nameAt(el) === want.name)],
    ["selector", () => bySelector && [bySelector]],
    ["nearby text", () => want.near && candidates.filter((el) => roleAt(el) === want.role && nearOf(el) === want.near)],
  ];
  for (const [how, list] of tiers) {
    const el = pick(list() || []);
    if (el) return { ref: refFor(el), how, file: el.tagName === "INPUT" && el.type === "file" };
  }
  return { missing: true };
}

// Replaces a field's contents by typing, as the user did: focus, select what is there, type.
async function fill(doc, { ref, text }) {
  const el = resolveRef(doc, ref);
  const win = doc.defaultView;
  let r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > viewSize(win).height) {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    r = el.getBoundingClientRect();
  }
  await moveCursor(doc, r.left + r.width / 2, r.top + r.height / 2);
  el.focus();
  if (el.isContentEditable) win.getSelection().selectAllChildren(el);
  else el.select?.();
  if (text) type(doc, { text: String(text) });
  else press(win, textInputProcessor(win), "Delete");
  return `Typed ${[...String(text ?? "")].length} character(s) into ${clickedLabel(el)}`;
}

function contains(doc, { text }) {
  return (doc.body?.innerText ?? "").toLowerCase().includes(String(text ?? "").toLowerCase());
}

// ---------------------------------------------------------------------------------------------

// Size of the rendered text, polled by navigate to wait out single-page-app loading.
function textSize(doc) {
  return (doc.body?.innerText ?? "").length;
}

// The viewport's size in CSS pixels. innerWidth/innerHeight have read 0x0 in a session tab while
// Firefox's window was occluded (on another macOS Space), likely a size the page hadn't taken yet
// because it wasn't getting refresh ticks. The scrolling element's client size (the viewport
// less scrollbars) stands in; 0 when neither knows, and background then asks the tab and the
// captured image.
function viewSize(win) {
  const doc = win.document;
  const root = doc?.scrollingElement ?? doc?.documentElement;
  return { width: win.innerWidth || root?.clientWidth || 0, height: win.innerHeight || root?.clientHeight || 0 };
}

function viewport(doc) {
  const win = doc.defaultView;
  return {
    ...viewSize(win),
    dpr: win.devicePixelRatio,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
    // where the viewport sits on screen, to place a child frame's rect in the tab
    screenX: win.mozInnerScreenX,
    screenY: win.mozInnerScreenY,
    title: doc.title,
    url: doc.location?.href,
  };
}

// ---------------------------------------------------------------------------------------------
// devtools (the opt-in tool): in a tab the extension watches, api.js sends "consoleWatch" to
// every frame, and again to each document that loads there later. The frame then takes its own
// window's console messages and script errors: those logged before it was told, which the
// console keeps per window, and each one after. They go to the parent in batches, with masked
// field values cut out first, as they are from javascript_tool's result.

const CONSOLE_FLUSH_MS = 250;
const CONSOLE_BATCH_MAX = 200;
const CONSOLE_ARG_CHARS = 1000;
// inner window id (as a string, the console's own key) -> { actor, pending, dropped, timer, rules }
const consoleWatchers = new Map();
let consoleListening = false;

// An argument as text, without running page code: page objects are seen through Xrays, which
// hide getters and page-defined methods, and objects are only shown one level deep.
function consoleArg(v, nested = false) {
  try {
    if (v === null) return "null";
    if (typeof v === "string") return nested ? JSON.stringify(v.slice(0, 200)) : v;
    if (typeof v !== "object" && typeof v !== "function") return String(v);
    if (typeof v === "function") return `ƒ ${v.name || "anonymous"}`;
    const cls = ChromeUtils.getClassName(v, true);
    if (/Error$/.test(cls)) return `${v.name || cls}: ${v.message ?? ""}`;
    if (typeof v.nodeType === "number") return v.nodeType === 1 ? `<${v.localName}${v.id ? `#${v.id}` : ""}>` : v.nodeName;
    if (nested) return Array.isArray(v) ? `Array(${v.length})` : cls;
    if (Array.isArray(v)) return `[${Array.from(v).slice(0, 20).map((x) => consoleArg(x, true)).join(", ")}${v.length > 20 ? ", …" : ""}]`;
    const keys = Object.keys(v);
    const shown = keys.slice(0, 20).map((k) => {
      const d = Object.getOwnPropertyDescriptor(v, k);
      return `${k}: ${d && "value" in d ? consoleArg(d.value, true) : "…"}`;
    });
    return `${cls === "Object" ? "" : `${cls} `}{${shown.join(", ")}${keys.length > 20 ? ", …" : ""}}`;
  } catch {
    return "[object]";
  }
}

// console.log's arguments as one line, with %s-style substitutions applied and %c styles dropped.
function consoleText(msg) {
  const args = Array.from(msg.arguments ?? []);
  if (msg.level === "timeEnd" || msg.level === "timeLog") return `${msg.timer?.name ?? "default"}: ${msg.timer?.duration ?? "?"}ms`;
  if (msg.level === "count") return `${msg.counter?.label ?? "default"}: ${msg.counter?.count ?? "?"}`;
  const parts = [];
  if (typeof args[0] === "string" && args[0].includes("%")) {
    const format = args.shift();
    parts.push(
      format.replace(/%[sdifoOc%]/g, (m) => {
        if (m === "%%") return "%";
        if (!args.length) return m;
        const v = args.shift();
        if (m === "%c") return "";
        if (m === "%d" || m === "%i") return String(parseInt(typeof v === "object" ? NaN : v, 10));
        if (m === "%f") return String(typeof v === "object" ? NaN : Number(v));
        return consoleArg(v);
      }),
    );
  }
  for (const v of args) parts.push(consoleArg(v));
  return parts.join(" ").slice(0, CONSOLE_ARG_CHARS);
}

function apiEntry(msg) {
  return { level: msg.level, text: consoleText(msg), source: msg.filename, line: msg.lineNumber, time: msg.timeStamp };
}

function errorEntry(msg) {
  const level = msg.flags & Ci.nsIScriptError.warningFlag ? "warning" : msg.flags & Ci.nsIScriptError.infoFlag ? "info" : "error";
  return { level, text: String(msg.errorMessage ?? "").slice(0, CONSOLE_ARG_CHARS), source: msg.sourceName, line: msg.lineNumber, time: msg.timeStamp };
}

// Console API calls in this process. The console names the window each came from.
const consoleApiObserver = {
  observe(subject, topic, id) {
    const msg = subject?.wrappedJSObject ?? subject;
    const w = consoleWatchers.get(String(id)) ?? consoleWatchers.get(String(msg?.innerID));
    if (w && !msg.chromeContext) queue(w, apiEntry(msg));
  },
};

// Script errors and warnings (uncaught exceptions, CSP, failed loads) in this process.
const consoleErrorListener = {
  observe(msg) {
    if (!(msg instanceof Ci.nsIScriptError) || msg.isFromChromeContext) return;
    const w = consoleWatchers.get(String(msg.innerWindowID));
    if (w) queue(w, errorEntry(msg));
  },
};

function listenConsole(on) {
  if (on === consoleListening) return;
  consoleListening = on;
  if (on) {
    Services.obs.addObserver(consoleApiObserver, "console-api-log-event");
    Services.console.registerListener(consoleErrorListener);
  } else {
    Services.obs.removeObserver(consoleApiObserver, "console-api-log-event");
    Services.console.unregisterListener(consoleErrorListener);
  }
}

function queue(w, entry) {
  if (w.pending.length >= CONSOLE_BATCH_MAX) {
    w.pending.shift();
    w.dropped++;
  }
  w.pending.push(entry);
  if (!w.timer) w.timer = setTimeout(() => flushConsole(w), CONSOLE_FLUSH_MS);
}

// Sends what's pending. Masked field values are cut out first; if the page can't be checked for
// them, the messages' text isn't sent at all.
function flushConsole(w) {
  clearTimeout(w.timer);
  w.timer = null;
  if (!w.pending.length && !w.dropped) return;
  let entries = w.pending;
  const dropped = w.dropped;
  w.pending = [];
  w.dropped = 0;
  if (w.rules) {
    try {
      const red = redactor(w.actor.document, w.rules);
      entries = entries.map((e) => ({ ...e, text: red.scrub(e.text, false) }));
    } catch {
      entries = entries.map((e) => ({ ...e, text: "(not shown: couldn't check it for masked field values)" }));
    }
  }
  try {
    w.actor.sendAsyncMessage("console", { entries, dropped });
  } catch {
    // the window is gone
  }
}

function consoleWatch(actor, { on, redact }) {
  const id = String(actor.manager.innerWindowId);
  const known = consoleWatchers.get(id);
  if (!on) {
    if (known) stopConsole(id);
    return false;
  }
  if (known) {
    known.rules = redact ?? null;
    return true;
  }
  const w = { actor, pending: [], dropped: 0, timer: null, rules: redact ?? null };
  consoleWatchers.set(id, w);
  actor.consoleId = id;
  // What this window logged before now, from the console's own caches, oldest first.
  const earlier = [];
  try {
    const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);
    for (const m of storage.getEvents(id) ?? []) {
      const msg = m?.wrappedJSObject ?? m;
      if (!msg.chromeContext) earlier.push(apiEntry(msg));
    }
  } catch {
    // no console storage in this process
  }
  try {
    for (const m of Services.console.getMessageArray() ?? []) {
      if (m instanceof Ci.nsIScriptError && !m.isFromChromeContext && String(m.innerWindowID) === id) earlier.push(errorEntry(m));
    }
  } catch {
    // nothing kept
  }
  earlier.sort((a, b) => a.time - b.time);
  for (const e of earlier) queue(w, e);
  listenConsole(true);
  return true;
}

function stopConsole(id) {
  const w = consoleWatchers.get(id);
  if (!w) return;
  clearTimeout(w.timer);
  consoleWatchers.delete(id);
  if (!consoleWatchers.size) listenConsole(false);
}

const OPS = {
  viewport,
  textSize,
  cursorVisible,
  capture,
  maskRects,
  readPage,
  find: findElements,
  text: pageText,
  click,
  hover,
  drag,
  scroll,
  scrollTo,
  type,
  key,
  formInput,
  evaluate,
  upload,
  pointArm,
  pointSync,
  pickInfo,
  pointAdded,
  mark,
  locate,
  fill,
  contains,
};

export class ClaudePageChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    if (name === "consoleWatch") return consoleWatch(this, data ?? {});
    const op = OPS[name];
    if (!op) throw new Error(`Unknown op ${name}`);
    const doc = this.document;
    if (!doc) throw new Error("No document in this frame.");
    return op(doc, data ?? {});
  }

  // The events api.js registers for this actor. Point and ask acts in armed documents only, and
  // Teach records the user's own input in a tab being recorded. An Alt+click that point and ask
  // swallowed is a pick, not a step.
  handleEvent(event) {
    if (!event.isTrusted) return;
    // A page going away sends its console messages now, before its window can't.
    if (event.type === "pagehide" && this.consoleId) {
      const w = consoleWatchers.get(this.consoleId);
      if (w) flushConsole(w);
    }
    let doc;
    try {
      doc = this.document;
    } catch {
      return; // the window is going away
    }
    const p = doc && points.get(doc);
    if (p?.armed) onPointEvent(this, doc, p, event);
    if (event.defaultPrevented && p?.armed) return;
    if (isRecording(this)) onRecordEvent(this, event);
  }

  didDestroy() {
    if (this.consoleId) stopConsole(this.consoleId);
  }
}
