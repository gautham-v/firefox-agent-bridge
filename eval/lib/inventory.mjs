// Page-side JS for the a11y probe: an inventory of interactive elements, run with
// javascript_tool. It walks the document, open shadow roots and same-origin frames (closed
// shadow roots are invisible to page script), and lists cross-origin frames with their size.
// Each element also gets a name source, so empty and heuristic names can be counted.

export const INVENTORY_JS = String.raw`(() => {
const INTERACTIVE_ROLES = new Set(["button","link","checkbox","radio","switch","tab","menuitem","menuitemcheckbox","menuitemradio","option","combobox","listbox","textbox","searchbox","slider","spinbutton","treeitem","gridcell"]);
const NAME_FROM_CONTENT = new Set(["button","link","tab","menuitem","menuitemcheckbox","menuitemradio","option","treeitem","checkbox","radio","switch","gridcell"]);
const out = { counts: {}, names: { proper: 0, heuristic: 0, empty: 0 }, total: 0, sameOriginFrames: 0, sameOriginFrameElements: 0, crossOriginFrames: [], shadowRoots: 0, samples: { empty: [], heuristic: [] } };
const visible = (el) => { try { if (!el.checkVisibility({ visibilityProperty: true })) return false; } catch {} const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
function kind(el) {
  const tag = el.tagName, role = (el.getAttribute("role") || "").split(/\s+/)[0];
  if (role && INTERACTIVE_ROLES.has(role)) return "role:" + role;
  if (tag === "A" && el.hasAttribute("href")) return "link";
  if (tag === "BUTTON" || tag === "SUMMARY") return "button";
  if (tag === "INPUT") { const t = el.type; if (t === "hidden") return null; if (["button","submit","reset","image"].includes(t)) return "button"; if (t === "checkbox" || t === "radio") return t; return "input"; }
  if (tag === "SELECT") return "select";
  if (tag === "TEXTAREA") return "textarea";
  if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "contenteditable";
  if (el.hasAttribute("onclick")) return "onclick";
  const ti = el.getAttribute("tabindex");
  if (ti !== null && Number(ti) >= 0 && tag !== "IFRAME") return "tabindex";
  return null;
}
function nameSource(el, k) {
  const doc = el.ownerDocument;
  const lb = el.getAttribute("aria-labelledby");
  if (lb && lb.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || "").join("").trim()) return "proper";
  if ((el.getAttribute("aria-label") || "").trim()) return "proper";
  if (el.labels && [...el.labels].some((l) => l.textContent.trim())) return "proper";
  if (el.tagName === "INPUT" && ["button","submit","reset"].includes(el.type) && el.value) return "proper";
  if ((el.tagName === "IMG" || el.type === "image") && el.getAttribute("alt")) return "proper";
  const role = k.startsWith("role:") ? k.slice(5) : { link: "link", button: "button", checkbox: "checkbox", radio: "radio" }[k];
  const text = (el.textContent || "").trim();
  if (role && NAME_FROM_CONTENT.has(role)) {
    if (text) return "proper";
    const img = el.querySelector("img[alt]:not([alt='']), svg[aria-label], [aria-label]");
    if (img) return "proper";
  }
  if ((el.getAttribute("title") || "").trim() || (el.getAttribute("placeholder") || "").trim()) return "heuristic";
  if (text) return "heuristic";
  return "empty";
}
function walk(root, inFrame) {
  const els = root.querySelectorAll("*");
  for (const el of els) {
    if (el.shadowRoot) { out.shadowRoots++; walk(el.shadowRoot, inFrame); }
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      const r = el.getBoundingClientRect();
      let doc = null;
      try {
        doc = el.contentDocument;
        // A frame that hasn't loaded its cross-origin src yet (lazy, or still loading) shows its
        // initial about:blank document; count it as cross-origin.
        const srcUrl = el.src ? new URL(el.src, location.href) : null;
        if (doc && srcUrl && /^https?:$/.test(srcUrl.protocol) && srcUrl.origin !== location.origin && doc.location.href === "about:blank") doc = null;
        if (doc && !doc.documentElement) doc = null;
      } catch { doc = null; }
      if (doc) { out.sameOriginFrames++; walk(doc, true); }
      else if (el.src || el.getAttribute("src")) {
        let host = ""; try { host = new URL(el.src, location.href).host; } catch {}
        out.crossOriginFrames.push({ src: String(el.src).slice(0, 300), host, w: Math.round(r.width), h: Math.round(r.height), visible: visible(el), title: el.title || el.getAttribute("aria-label") || "" });
      }
      continue;
    }
    const k = kind(el);
    if (!k || !visible(el)) continue;
    out.total++;
    if (inFrame) out.sameOriginFrameElements++;
    out.counts[k] = (out.counts[k] || 0) + 1;
    const ns = nameSource(el, k);
    out.names[ns]++;
    if (ns !== "proper" && out.samples[ns].length < 5) out.samples[ns].push((el.outerHTML || "").slice(0, 160));
  }
}
walk(document, false);
return JSON.stringify(out);
})()`;

// Parses read_page output into entry counts.
const ROLE_WORDS = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "combobox",
  "listbox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "gridcell", "file", "iframe", "heading", "img",
  "navigation", "main", "banner", "contentinfo", "form", "list", "listitem", "table", "row", "cell", "columnheader", "dialog",
  "complementary", "article", "region", "group", "paragraph", "search", "menu", "menubar", "tablist", "tabpanel", "toolbar",
  "tree", "grid", "alert", "alertdialog", "status", "progressbar", "separator", "presentation", "none", "document", "application",
]);

export function parseReadPage(text) {
  const lines = text.split("\n").filter((l) => /\[ref_\d+\]/.test(l));
  const r = { entries: lines.length, emptyName: 0, genericTag: 0, iframes: 0, byRole: {}, truncated: /\[Truncated at/.test(text) };
  for (const l of lines) {
    const head = l.trim().split(" ")[0];
    const role = head.replace(/\(.*\)$/, "");
    r.byRole[role] = (r.byRole[role] ?? 0) + 1;
    if (role === "iframe") r.iframes++;
    if (!ROLE_WORDS.has(role)) r.genericTag++; // included only for onclick/tabindex/contenteditable, no role
    if (/^\s*\S+ \[ref_\d+\]/.test(l)) r.emptyName++;
  }
  return r;
}
