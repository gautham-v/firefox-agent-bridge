// Accessible names for read_page, find and click results, in the order ARIA's name computation
// takes them: aria-labelledby, aria-label, what HTML gives the element (its labels, an image's
// alt, a button's value, a fieldset's legend, a table's caption, an svg's <title>), its content
// for roles named by their content (links, buttons, headings...), then title and placeholder.
//
// Content is read the way the name computation reads it, not as textContent: a link around an
// image is named by the image's alt, an icon button by its svg's <title>, a child with no text by
// its title (HN's vote arrows), and hidden children, scripts and nested form fields (a select's
// options) are left out. Most elements hold plain text, so only a subtree with one of those in it
// is walked.
//
// Elements are passed in, and `children` says how to walk them (the actor passes one that goes
// into shadow roots and slots), so node tests can use plain objects.

export const NAME_MAX = 150;

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "desc"]);
const FIELDS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
const LABEL_SKIP = new Set(["SELECT", "TEXTAREA", "INPUT", "BUTTON", "SCRIPT", "STYLE"]);
// A subtree with none of these in it is named by its textContent.
const SPECIAL = "img, svg, area, input, select, textarea, script, style, noscript, template, [aria-label], [aria-hidden], [hidden], [title]";
const BUTTON_DEFAULTS = { submit: "Submit", reset: "Reset", image: "Submit" };

const squash = (s) => (s ?? "").replace(/\s+/g, " ").trim();
export const clip = (s, max = NAME_MAX) => {
  const t = squash(s);
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

const attr = (el, name) => el.getAttribute?.(name) ?? null;
const kids = (node) => Array.from(node.childNodes ?? []);
const hiddenEl = (el) => el.hidden === true || attr(el, "aria-hidden") === "true";

// The element an id refers to, looked up in the element's own tree first (a shadow root).
function byId(el, id) {
  return el.getRootNode?.()?.getElementById?.(id) ?? el.ownerDocument?.getElementById?.(id) ?? null;
}

// A label's own text, leaving out the text of controls nested inside it (like a select's options).
export function labelText(label) {
  const parts = [];
  const walk = (node) => {
    for (const child of kids(node)) {
      if (child.nodeType === 3) parts.push(child.data);
      else if (child.nodeType === 1 && !LABEL_SKIP.has(child.tagName)) walk(child);
    }
  };
  walk(label);
  return parts.join(" ");
}

const firstChild = (el, tag) => kids(el).find((c) => c.nodeType === 1 && c.tagName === tag) ?? null;

// What HTML itself names the element by, or "".
function nativeName(el) {
  const tag = el.tagName;
  if (el.labels?.length) {
    const text = clip(Array.from(el.labels).map(labelText).join(" "));
    if (text) return text;
  }
  if (tag === "IMG" || tag === "AREA") return clip(attr(el, "alt"));
  if (tag === "INPUT") {
    const type = (el.type ?? attr(el, "type") ?? "").toLowerCase();
    if (type === "image") return clip(attr(el, "alt")) || clip(el.value) || BUTTON_DEFAULTS.image;
    if (type === "button") return clip(el.value);
    if (type in BUTTON_DEFAULTS) return clip(el.value) || BUTTON_DEFAULTS[type];
    return "";
  }
  if (tag === "FIELDSET") return clip(firstChild(el, "LEGEND")?.textContent);
  if (tag === "TABLE") return clip(firstChild(el, "CAPTION")?.textContent);
  if (tag === "svg") return clip(firstChild(el, "title")?.textContent);
  return "";
}

// The name an element's content gives it: its text, with images by their alt, icons by their
// <title>, and children with no text by their title.
export function contentName(el, { children = kids, max = NAME_MAX } = {}) {
  if (typeof el.querySelector === "function" && !el.openOrClosedShadowRoot && !el.querySelector(SPECIAL)) return clip(el.textContent, max);
  const parts = [];
  let size = 0;
  const add = (s, spaced) => {
    parts.push(spaced ? ` ${s} ` : s);
    size += s.length;
  };
  const walk = (node) => {
    for (const child of children(node)) {
      if (size > max) return;
      if (child.nodeType === 3) {
        add(child.data, false);
        continue;
      }
      if (child.nodeType !== 1 || SKIP.has(child.tagName) || hiddenEl(child) || FIELDS.has(child.tagName)) continue;
      const own = clip(attr(child, "aria-label")) || nativeName(child);
      if (own) {
        add(own, true);
        continue;
      }
      const before = size;
      walk(child);
      const title = size === before && clip(attr(child, "title"));
      if (title) add(title, true);
    }
  };
  walk(el);
  return clip(parts.join(""), max);
}

// The element's name, or "". fromContent: its role takes its name from its content.
export function accessibleName(el, { fromContent = false, children = kids } = {}) {
  const labelledBy = attr(el, "aria-labelledby");
  if (labelledBy) {
    const text = clip(
      labelledBy
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => {
          const ref = byId(el, id);
          return ref ? clip(attr(ref, "aria-label")) || contentName(ref, { children }) : "";
        })
        .join(" "),
    );
    if (text) return text;
  }
  const aria = clip(attr(el, "aria-label"));
  if (aria) return aria;
  const native = nativeName(el);
  if (native) return native;
  if (fromContent) {
    const text = contentName(el, { children });
    if (text) return text;
  }
  for (const name of ["title", "placeholder", "aria-placeholder"]) {
    const v = clip(attr(el, name));
    if (v) return v;
  }
  return "";
}

// Controls inside an element, found by a selector (so not inside shadow roots): a focusable
// wrapper around them (a scroll box, a card around its link) isn't a target of its own.
const CONTROLS = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"], [onclick], [role="button"], [role="link"]';
const STATES = ["aria-expanded", "aria-pressed", "aria-selected", "aria-checked", "aria-current"];

// How read_page lists an element that is interactive only because it has a tabindex or onclick
// (no interactive role): named by its text like a button, up to `max` characters. One that only
// wraps other controls gets no name (they carry their own), and in the interactive tree, or when
// it has no role at all, its line is left out, unless it has an onclick or carries a state
// (expanded, pressed...). Answers { name, skip }.
export function focusableEntry(el, role, { name = "", interactiveOnly = false, children = kids, max = 80 } = {}) {
  if (name) return { name, skip: false };
  const wraps = typeof el.querySelector === "function" && !!el.querySelector(CONTROLS);
  if (!wraps) return { name: contentName(el, { children, max }), skip: false };
  const keep = el.hasAttribute?.("onclick") || STATES.some((s) => el.hasAttribute?.(s));
  return { name: "", skip: !keep && (interactiveOnly || !role) };
}
