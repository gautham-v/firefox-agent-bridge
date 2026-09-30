"use strict";

// Accessible names for read_page and find (experiment/names.sys.mjs), on small element trees
// shaped like the markup that gave empty or bare names in the accessibility probe.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "experiment", "names.sys.mjs"));

// A minimal DOM: h("a", { href: "/x" }, "text", h("img", { alt: "y" })). HTML tags are
// upper-cased as in a real document, svg and its children keep their case.
const SVG = new Set(["svg", "title", "path", "g", "desc", "text"]);
function h(tag, attrs = {}, ...children) {
  const el = {
    nodeType: 1,
    tagName: SVG.has(tag) ? tag : tag.toUpperCase(),
    attrs: { ...attrs },
    childNodes: [],
    parentElement: null,
    getAttribute: (n) => (n in el.attrs ? String(el.attrs[n]) : null),
    hasAttribute: (n) => n in el.attrs,
    get hidden() {
      return "hidden" in el.attrs;
    },
    get value() {
      return el.attrs.value ?? "";
    },
    get type() {
      return el.attrs.type ?? (el.tagName === "INPUT" ? "text" : undefined);
    },
    get textContent() {
      return el.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join("");
    },
    getRootNode: () => {
      let top = el;
      while (top.parentElement) top = top.parentElement;
      return top.root ?? top;
    },
    querySelector: (selector) => descendants(el).find((d) => matches(d, selector)) ?? null,
  };
  for (const c of children) {
    const node = typeof c === "string" ? { nodeType: 3, data: c } : c;
    if (node.nodeType === 1) node.parentElement = el;
    el.childNodes.push(node);
  }
  return el;
}

const descendants = (el) => el.childNodes.filter((c) => c.nodeType === 1).flatMap((c) => [c, ...descendants(c)]);

// Enough of CSS for the selectors names.sys.mjs uses: tags, [attr], [attr="v"], :not([attr="v"]).
function matches(el, selector) {
  return selector.split(",").some((part) => {
    const s = part.trim();
    const m = /^([a-z]*)((?:\[[^\]]+\])*)((?::not\(\[[^\]]+\]\))*)$/i.exec(s);
    if (!m) throw new Error(`selector not supported by the mock: ${s}`);
    const [, tag, has, not] = m;
    if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    const test1 = (a) => {
      const [, name, value] = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(a);
      return value === undefined ? el.hasAttribute(name) : el.getAttribute(name) === value;
    };
    const attrs = (x) => x.match(/\[[^\]]+\]/g) ?? [];
    return attrs(has).every(test1) && attrs(not).every((a) => !test1(a));
  });
}

// A document (or shadow root) that finds ids among its elements.
function root(...children) {
  const body = h("body", {}, ...children);
  body.root = { getElementById: (id) => descendants(body).find((d) => d.attrs.id === id) ?? null };
  return body;
}

test("a link around an image is named by the image's alt", async () => {
  const { accessibleName } = await load();
  const link = h("a", { href: "/wiki/File:Firefox_logo.svg" }, h("img", { alt: "Firefox logo", src: "logo.png" }));
  assert.equal(accessibleName(link, { fromContent: true }), "Firefox logo");
});

test("HN's vote arrow: a link whose only child has a title and no text", async () => {
  const { accessibleName } = await load();
  const vote = h("a", { id: "up_1", href: "vote?id=1&how=up" }, h("div", { class: "votearrow", title: "upvote" }));
  assert.equal(accessibleName(vote, { fromContent: true }), "upvote");
});

test("an icon button is named by its svg's title; one with text keeps its text", async () => {
  const { accessibleName } = await load();
  const icon = h("button", {}, h("svg", { viewBox: "0 0 16 16" }, h("title", {}, "Copy"), h("path", { d: "M0 0" })));
  assert.equal(accessibleName(icon, { fromContent: true }), "Copy");
  const both = h("button", {}, h("svg", { "aria-hidden": "true" }, h("title", {}, "icon")), " Save draft");
  assert.equal(accessibleName(both, { fromContent: true }), "Save draft");
});

test("hidden children, scripts and a nested select's options stay out of the name", async () => {
  const { accessibleName } = await load();
  const cell = h("td", {}, "Size ", h("span", { hidden: "" }, "(internal)"), h("select", {}, h("option", {}, "S"), h("option", {}, "M")), h("script", {}, "track()"));
  assert.equal(accessibleName(cell, { fromContent: true }), "Size");
});

test("plain text is named by textContent without a walk", async () => {
  const { accessibleName } = await load();
  const link = h("a", { href: "/wiki/SpiderMonkey" }, h("span", {}, "Spider"), "Monkey");
  link.querySelector = () => null;
  let read = 0;
  Object.defineProperty(link, "childNodes", { get: () => (read++, []) });
  Object.defineProperty(link, "textContent", { get: () => "SpiderMonkey" });
  assert.equal(accessibleName(link, { fromContent: true }), "SpiderMonkey");
  assert.equal(read, 0);
});

test("aria-labelledby resolves ids in the element's own tree (a shadow root) and uses aria-label there", async () => {
  const { accessibleName } = await load();
  const field = h("input", { "aria-labelledby": "l1 l2" });
  root(h("span", { id: "l1" }, "Card"), h("span", { id: "l2", "aria-label": "number" }, "ignored"), field);
  assert.equal(accessibleName(field), "Card number");
});

test("labels, then placeholder; a label's own text leaves out a nested select", async () => {
  const { accessibleName } = await load();
  const select = h("select", {}, h("option", {}, "Sardine"));
  const label = h("label", {}, "Flavor ", select);
  select.labels = [label];
  assert.equal(accessibleName(select), "Flavor");
  assert.equal(accessibleName(h("input", { placeholder: "Search Wikipedia" })), "Search Wikipedia");
  assert.equal(accessibleName(h("div", { role: "textbox", "aria-placeholder": "Write a comment" })), "Write a comment");
});

test("buttons made from inputs: their value, or the browser's default label", async () => {
  const { accessibleName } = await load();
  assert.equal(accessibleName(h("input", { type: "submit", value: "Pay $20" })), "Pay $20");
  assert.equal(accessibleName(h("input", { type: "submit" })), "Submit");
  assert.equal(accessibleName(h("input", { type: "reset" })), "Reset");
  assert.equal(accessibleName(h("input", { type: "image", alt: "Go" })), "Go");
  assert.equal(accessibleName(h("input", { type: "button" })), "");
});

test("a fieldset by its legend, a table by its caption", async () => {
  const { accessibleName } = await load();
  assert.equal(accessibleName(h("fieldset", {}, h("legend", {}, "Shipping"), h("input", {}))), "Shipping");
  assert.equal(accessibleName(h("table", {}, h("caption", {}, "Releases"), h("tr", {}))), "Releases");
});

test("title comes after content; roles not named by content use only attributes", async () => {
  const { accessibleName } = await load();
  assert.equal(accessibleName(h("a", { href: "/", title: "Home page" }, "Home"), { fromContent: true }), "Home");
  assert.equal(accessibleName(h("a", { href: "/", title: "Home page" }), { fromContent: true }), "Home page");
  assert.equal(accessibleName(h("div", { role: "region" }, "lots of text")), "");
});

test("long content is cut at the cap", async () => {
  const { contentName, NAME_MAX } = await load();
  const name = contentName(h("a", {}, h("img", { alt: "x" }), "y".repeat(400)));
  assert.equal(name.length, NAME_MAX);
  assert.ok(name.endsWith("…"));
});

test("a focusable div is named by its text; a wrapper around controls is left out", async () => {
  const { focusableEntry } = await load();
  // Square's usage guide steps: <li tabindex=0 aria-expanded=false> with the step's text inside.
  const step = h("li", { tabindex: "0", "aria-expanded": "false" }, h("div", {}, "Install the SDK"));
  assert.deepEqual(focusableEntry(step, "listitem", { interactiveOnly: true }), { name: "Install the SDK", skip: false });
  // A scroll box made focusable, around links: no line in the interactive tree.
  const scroller = h("div", { tabindex: "0" }, h("a", { href: "/a" }, "A"), h("a", { href: "/b" }, "B"));
  assert.deepEqual(focusableEntry(scroller, null, { interactiveOnly: true }), { name: "", skip: true });
  // With a role, the "all" tree keeps its line (the structure), unnamed.
  const list = h("ul", { tabindex: "0" }, h("li", {}, h("a", { href: "/a" }, "A")));
  assert.deepEqual(focusableEntry(list, "list", { interactiveOnly: false }), { name: "", skip: false });
  // An onclick or a state keeps the line: it may do something of its own.
  const card = h("div", { onclick: "open()" }, h("a", { href: "/a" }, "A"));
  assert.equal(focusableEntry(card, null, { interactiveOnly: true }).skip, false);
  const toggle = h("div", { tabindex: "0", "aria-expanded": "true" }, h("button", {}, "x"));
  assert.equal(focusableEntry(toggle, null, { interactiveOnly: true }).skip, false);
  // A name it already has wins.
  assert.deepEqual(focusableEntry(scroller, null, { name: "Results", interactiveOnly: true }), { name: "Results", skip: false });
});

test("a focusable element's text name is shorter than a link's", async () => {
  const { focusableEntry } = await load();
  const box = h("div", { tabindex: "0" }, "z".repeat(300));
  assert.equal(focusableEntry(box, null).name.length, 80);
});
