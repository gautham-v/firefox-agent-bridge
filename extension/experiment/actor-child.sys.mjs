// Child side of the ClaudePage actor. Runs in the content process of every frame, with chrome
// privileges, so events it creates are trusted (isTrusted === true, user activation granted)
// and work in background tabs and unfocused windows without touching the OS cursor.

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

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
// Element refs. Each document keeps its own ref_N numbering; refs die with the document.

const docStates = new WeakMap();

function docState(doc) {
  let s = docStates.get(doc);
  if (!s) {
    s = { next: 1, byRef: new Map(), byEl: new WeakMap() };
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
    ref = `ref_${s.next++}`;
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

function describe(el, role, name) {
  const tag = el.tagName.toLowerCase();
  const explicit = el.getAttribute("role");
  const native = TAG_ROLES[el.tagName]?.(el);
  // e.g. a <button role="link">: say so, since it has no href to read
  const label = explicit && role && native !== role && !["div", "span", "li"].includes(tag) ? `${role}(${tag})` : role || tag;
  const parts = [label];
  if (name) parts.push(JSON.stringify(name));
  parts.push(`[${refFor(el)}]`);
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
    if (el.type === "password") {
      if (el.value) parts.push("value=(set)");
    } else if (el.value) {
      parts.push(`value=${JSON.stringify(clean(el.value, 100))}`);
    }
    if (el.placeholder && el.placeholder !== name) parts.push(`placeholder=${JSON.stringify(clean(el.placeholder, 80))}`);
  }
  if (el.tagName === "TEXTAREA" && el.value) parts.push(`value=${JSON.stringify(clean(el.value, 100))}`);
  if (el.tagName === "SELECT") {
    const selected = Array.from(el.selectedOptions).map((o) => clean(o.textContent, 60));
    parts.push(`selected=${JSON.stringify(selected.join(", "))}`);
    parts.push(`options=${el.options.length}`);
  }
  if (el.tagName === "INPUT" && el.type === "file") {
    parts.push(el.files?.length ? `files=${JSON.stringify(Array.from(el.files).map((f) => f.name).join(", "))}` : "files=none");
    if (el.accept) parts.push(`accept=${JSON.stringify(el.accept)}`);
  }
  if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
    parts.push(el.checked ? "checked" : "unchecked");
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
// read_page

function readPage(doc, { filter = "all", depth = 15, maxChars = 50000, refId, frameScale = 1 } = {}) {
  const interactiveOnly = filter === "interactive";
  const lines = [];
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
    }
    let nextLevel = level;
    let nextDepth = depthLeft;
    let named = insideNamed;
    if (node.nodeType === 1) {
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      const include = interactive || (!interactiveOnly && role && STRUCTURAL_ROLES.has(role));
      if (include) {
        if (depthLeft <= 0) return;
        if (!push(`${"  ".repeat(level)}${describe(el, role, nameOf(el, role))}`)) return;
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
  const header = [
    `Page: ${doc.title}`,
    `URL: ${doc.location?.href}`,
    `Viewport (screenshot frame): ${Math.round(win.innerWidth * frameScale)}x${Math.round(win.innerHeight * frameScale)}; page scrolled ${Math.round(win.scrollY * frameScale)} of ${Math.round(doc.documentElement.scrollHeight * frameScale)} tall`,
    "",
  ];
  walk(root, 0, depth, false);
  let out = header.join("\n") + lines.join("\n");
  if (truncated) {
    out += `\n\n[Truncated at ${maxChars} characters. Use filter "interactive", a smaller depth, or ref_id to focus on part of the page.]`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// find: heuristic scoring over names, roles and attributes

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

function findElements(doc, { query, frameScale = 1 }) {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}$]+/u).filter((t) => t && !STOPWORDS.has(t));
  const phrase = query.toLowerCase().trim();
  const win = doc.defaultView;
  const scored = [];

  const visit = (node) => {
    if (node.nodeType === 1) {
      const el = node;
      if (SKIP_TAGS.has(el.tagName) || el.getAttribute("aria-hidden") === "true") return;
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      const ownText = !interactive && ownTextOf(el);
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
          const name = nameOf(el, role).toLowerCase();
          const extra = [
            el.id, el.getAttribute("name"), el.getAttribute("placeholder"), el.getAttribute("title"),
            el.getAttribute("data-test-id"), el.getAttribute("data-testid"), el.getAttribute("aria-describedby") ? "" : "",
            el.tagName === "A" ? el.getAttribute("href") : "",
            role === "heading" || role === "listitem" || role === "article" ? "" : clean(el.textContent, 300),
            el.tagName === "INPUT" ? `${el.type} ${el.accept ?? ""}` : "",
          ].filter(Boolean).join(" ").toLowerCase();
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
            const inView = r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
            if (inView) score += 0.5;
            scored.push({ el, role, score, rect: r });
          }
        }
      }
    }
    for (const child of renderedChildren(node)) {
      if (child.nodeType === 1 || child.nodeType === 11) visit(child);
    }
  };
  visit(doc.body ?? doc.documentElement);

  scored.sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  const matches = scored.filter((m) => m.score >= Math.max(1, best * 0.4)).slice(0, 20);
  if (!matches.length) return `No elements matched "${query}". Try read_page with filter "interactive".`;
  const lines = matches.map(({ el, role, rect, text }) => {
    const cx = Math.round((rect.left + rect.width / 2) * frameScale);
    const cy = Math.round((rect.top + rect.height / 2) * frameScale);
    const onScreen = rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
    const where = !(rect.width || rect.height) ? " (not rendered)" : onScreen ? ` at (${cx}, ${cy})` : " (off-screen; click by ref, or scroll_to first)";
    return `${describe(el, role, text ?? nameOf(el, role))}${where}`;
  });
  const more = matches.length === 20 && scored.length > 20 ? `\n[More than 20 matches; showing the best 20. Use a more specific query.]` : "";
  return `Found ${matches.length} element(s) for "${query}" (coordinates match the screenshot frame; clicking by ref is more reliable):\n${lines.join("\n")}${more}`;
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

function pageText(doc) {
  const source = doc.body ?? doc.documentElement;
  const text = (source.innerText ?? source.textContent ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const limit = 200000;
  return `Title: ${doc.title}\nURL: ${doc.location?.href}\n\n${text.length > limit ? text.slice(0, limit) + "\n[Truncated]" : text}`;
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

function fire(win, target, Ctor, type, init) {
  const event = new win[Ctor](type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: win,
    ...init,
  });
  return win.windowUtils.dispatchDOMEventViaPresShellForTesting(target, event);
}

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';

// Resolves a click target: by ref (scrolled into view) or by point (with frame descent).
function pointTarget(doc, { x, y, ref }) {
  const win = doc.defaultView;
  if (ref) {
    const el = resolveRef(doc, ref);
    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.left < 0 || r.bottom > win.innerHeight || r.right > win.innerWidth) {
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
    filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.4));
    transition: transform ${CURSOR_MOVE_MS}ms cubic-bezier(.3,.7,.3,1), opacity 300ms ease;
  }
  .arrow.on { opacity: 1; }
  .arrow.down svg { transform: scale(.92); transform-origin: 5px 4px; }
  .ripple {
    position: absolute; left: 0; top: 0; width: 36px; height: 36px; margin: -18px 0 0 -18px;
    border-radius: 50%; border: 2px solid #261F25; box-shadow: 0 0 0 1.5px rgba(255,255,255,.85), inset 0 0 0 1.5px rgba(255,255,255,.85); opacity: 0;
  }
  .ripple.go { animation: ripple 450ms ease-out; }
  @keyframes ripple { from { opacity: .9; scale: .3; } to { opacity: 0; scale: 1.4; } }
`;

// The macOS arrow at its default size (tip at 5,4), filled #261F25 instead of black. Built with
// createElementNS rather than parsed, since some pages (LinkedIn) break DOMParser for SVG.
const ARROW_PATH = "M5 4 L5 20.6 L9.1 16.7 L11.8 23.1 L14.6 21.9 L11.9 15.6 L17.4 15.6 Z";

function arrowSvg(doc) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(NS, "svg");
  for (const [k, v] of [["width", "20"], ["height", "28"], ["viewBox", "0 0 20 28"]]) svg.setAttribute(k, v);
  const path = doc.createElementNS(NS, "path");
  for (const [k, v] of [
    ["d", ARROW_PATH], ["fill", "#261F25"], ["stroke", "#fff"], ["stroke-width", "1.6"],
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

// Moves the cursor to (x, y) and resolves once it has arrived.
async function moveCursor(doc, x, y) {
  const c = cursorFor(doc);
  if (!c) return;
  const first = c.x === null;
  c.arrow.style.transition = first ? "opacity 300ms ease" : "";
  c.arrow.style.transform = `translate(${x - 5}px, ${y - 4}px)`;
  c.arrow.classList.add("on");
  const moved = first ? 0 : Math.hypot(x - c.x, y - c.y);
  c.x = x;
  c.y = y;
  clearTimeout(c.idle);
  c.idle = setTimeout(() => c.arrow.classList.remove("on"), CURSOR_IDLE_MS);
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

// Hidden while a screenshot is taken, so Claude sees the page as it is.
function cursorVisible(doc, { visible }) {
  const c = cursors.get(doc);
  if (c) c.arrow.style.visibility = visible ? "" : "hidden";
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
  const { el, x, y } = pointTarget(doc, args);
  const win = doc.defaultView;
  const button = args.button ?? 0;
  const buttons = button === 2 ? 2 : button === 1 ? 4 : 1;
  const count = args.clickCount ?? 1;
  const base = { ...at(win, x, y), button, ...modifierInit(args.modifiers) };
  const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };

  await moveCursor(doc, x, y);
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
    fire(win, el, "MouseEvent", "mouseup", { ...base, buttons: 0, detail: i });
  }
  if (button === 2) {
    el.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, view: win, ...base, buttons: 0 }));
  }
  pressCursor(doc, false);
  return `Clicked ${clickedLabel(el)}`;
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
  await moveCursor(doc, x, y);
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

async function drag(doc, { x0, y0, x, y }) {
  const win = doc.defaultView;
  const start = deepElementFromPoint(doc, x0, y0);
  if (!start) throw new Error("Nothing at the drag start point.");
  await moveCursor(doc, x0, y0);
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
  await moveCursor(doc, x, y);
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
  const x = args.x ?? win.innerWidth / 2;
  const y = args.y ?? win.innerHeight / 2;
  const el = deepElementFromPoint(doc, x, y);
  const descent = args.x == null ? null : frameDescent(el, x, y);
  if (descent) return descent;
  const vertical = direction === "up" || direction === "down";
  const sign = direction === "down" || direction === "right" ? 1 : -1;
  const delta = sign * amount * 100;
  const target = (el && scrollableAncestor(win, el, vertical)) || doc.scrollingElement || doc.documentElement;
  if (el) {
    fire(win, el, "WheelEvent", "wheel", {
      ...at(win, x, y), deltaMode: 0,
      deltaX: vertical ? 0 : delta, deltaY: vertical ? delta : 0,
    });
  }
  const before = vertical ? target.scrollTop : target.scrollLeft;
  target.scrollBy({ top: vertical ? delta : 0, left: vertical ? 0 : delta, behavior: "instant" });
  const after = vertical ? target.scrollTop : target.scrollLeft;
  const which = target === doc.scrollingElement ? "page" : target.tagName.toLowerCase();
  return `Scrolled ${which} ${direction} by ${Math.round(Math.abs(after - before))}px`;
}

function scrollTo(doc, { ref, frameScale = 1 }) {
  const el = resolveRef(doc, ref);
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return `Scrolled ${ref} into view; its center is now at (${Math.round((r.left + r.width / 2) * frameScale)}, ${Math.round((r.top + r.height / 2) * frameScale)})`;
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

function type(doc, { text }) {
  const descent = focusDescent(doc);
  if (descent) return descent;
  const win = doc.defaultView;
  const tip = textInputProcessor(win);
  for (const ch of text) {
    if (ch === "\n") press(win, tip, "Enter");
    else if (ch === "\t") press(win, tip, "Tab");
    else if (ch !== "\r") press(win, tip, ch);
  }
  const active = doc.activeElement;
  return `Typed ${[...text].length} character(s) into ${active ? active.tagName.toLowerCase() : "the page"}`;
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

function key(doc, { keys, repeat = 1 }) {
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
  return `Pressed ${keys}${repeat > 1 ? ` x${repeat}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// form_input

function formInput(doc, { ref, value }) {
  const el = resolveRef(doc, ref);
  const win = doc.defaultView;
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
    return `Selected ${JSON.stringify(clean(option.textContent, 80))} in ${ref}`;
  }

  if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
    const want = value === true || value === "true" || value === 1 || value === "on" || value === "checked";
    if (el.checked !== want) el.click();
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

async function evaluate(doc, { code }) {
  const win = doc.defaultView;
  let sandbox = sandboxes.get(win);
  if (!sandbox) {
    sandbox = Cu.Sandbox(win, {
      sandboxPrototype: win,
      wantXrays: false,
      sameZoneAs: win,
      sandboxName: "Claude for Firefox javascript_tool",
    });
    sandbox.__claudeRun = Cu.evalInSandbox(SANDBOX_RUNNER, sandbox);
    sandboxes.set(win, sandbox);
  }
  const outcome = await Cu.evalInSandbox("__claudeRun", sandbox)(code);
  const value = String(outcome.value);
  const limit = 100000;
  const text = value.length > limit ? value.slice(0, limit) + "\n[Truncated]" : value;
  if (!outcome.ok) throw new Error(text);
  return text;
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

// Size of the rendered text, polled by navigate to wait out single-page-app loading.
function textSize(doc) {
  return (doc.body?.innerText ?? "").length;
}

function viewport(doc) {
  const win = doc.defaultView;
  return {
    width: win.innerWidth,
    height: win.innerHeight,
    dpr: win.devicePixelRatio,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
    title: doc.title,
    url: doc.location?.href,
  };
}

const OPS = {
  viewport,
  textSize,
  cursorVisible,
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
};

export class ClaudePageChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    const op = OPS[name];
    if (!op) throw new Error(`Unknown op ${name}`);
    const doc = this.document;
    if (!doc) throw new Error("No document in this frame.");
    return op(doc, data ?? {});
  }
}
