#!/usr/bin/env node
// Strip probe: for ~20 article URLs, compares what the agent reads today (get_page_text) with a
// reader-view extraction, and checks whether the article's content survives.
//
// about:reader can't be opened with today's tools (tabs.update rejects it as an illegal URL and
// pages may not navigate to it), so reader view is reproduced with Mozilla's Readability.js,
// the library behind Firefox Reader View, injected as source through javascript_tool (which the
// page's CSP doesn't block). The "arm" column is the snippet the strip arm's agents run
// (Readability via import, DOM heuristic when CSP blocks the import).
//
//   node eval/probe-strip.mjs [--max-minutes 8] [--limit N] [--only url,url] [--redo]
// Writes eval/results/probe-strip.json; re-run to continue where it stopped.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READER_SNIPPET } from "./arms.mjs";
import { startMcp, sleep, tokens } from "./lib/mcp-client.mjs";
import { probeArgs, resultsFile, within } from "./lib/probe-util.mjs";

const EVAL = path.dirname(fileURLToPath(import.meta.url));
const args = probeArgs({ out: path.join(EVAL, "results/probe-strip.json") });
// URLs start only while 60s are left, and each gets at most 100s, so a run ends before
// --max-minutes.
const hardEnd = Date.now() + args.maxMinutes * 60_000 - 20_000;
const URL_BUDGET_MS = 100_000;

// facts: regexes that must survive in the text (from the task answer keys).
export const URLS = [
  { url: "https://arstechnica.com/space/2026/09/nasa-has-a-dragon-dilemma-and-there-appear-to-be-no-good-answers/", facts: ["\\$3\\.1 billion", "\\$359 million", "\\$90 million per seat", "\\$78\\.8 million", "13 missions"] },
  { url: "https://arstechnica.com/gadgets/2026/09/mozillas-head-of-firefox-talks-product-priorities-ai-skepticism-and-browser-choice/", facts: ["Firefox 157", "Paddy Harrington", "less than 10 percent", "enterprises and schools need"] },
  { url: "https://www.theguardian.com/news/2026/sep/29/why-am-i-obsessed-with-chinas-ancient-golden-age-i-took-my-daughter-on-a-trip-to-find-out", facts: ["14km in length", "20km from Xi", "200 chapters", "2,345 caves", "11-year-old"] },
  { url: "https://arstechnica.com/cars/2026/09/connected-car-data-privacy-is-still-abysmal-study-finds/" },
  { url: "https://www.bbc.com/news/articles/cqn8m342rgk9o" },
  { url: "https://apnews.com/article/hurricane-polo-landfall-mexico-baja-california-rachel-db57554d97c70cd44b99df9ff0a41668" },
  { url: "https://www.npr.org/2026/09/28/nx-s1-5982739/what-to-know-about-the-810-million-in-spending-canceled-by-president-trump" },
  { url: "https://www.theverge.com/tech/1001797/nothings-headphone-1-pro-review" },
  { url: "https://techcrunch.com/2026/09/29/tesla-secures-30b-in-new-credit-lines-as-it-looks-to-scale-cybercab-optimus/" },
  { url: "https://www.wired.com/story/anthropic-says-it-discovered-a-crispr-like-system-now-what/" },
  { url: "https://www.quantamagazine.org/mathematicians-harness-randomness-to-crack-a-55-year-old-conjecture-20260928/" },
  { url: "https://www.smithsonianmag.com/history/some-earliest-automobile-enthusiasts-signed-up-help-allies-world-war-i-also-ushered-in-mechanization-war-180989285/" },
  { url: "https://stackoverflow.blog/2026/09/29/your-phone-is-ai-s-newest-hardware/" },
  { url: "https://www.cnn.com/2026/09/29/economy/trump-just-banned-canadian-booze-heres-what-you-need-to-know" },
  { url: "https://simonwillison.net/2026/Sep/29/anthropic-frontier-red-team/" },
  { url: "https://www.nature.com/articles/d41586-026-03043-w" },
  { url: "https://hacks.mozilla.org/2026/08/intent-to-ship-jpeg-xl/" },
  { url: "https://www.aljazeera.com/news/2025/11/11/how-many-times-has-israel-violated-the-gaza-ceasefire-here-are-the-numbers" },
  { url: "https://en.wikipedia.org/wiki/Firefox" },
  { url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API" },
  { url: "https://github.com/mozilla/readability" },
  { url: "https://www.paulgraham.com/greatwork.html" },
];

const READABILITY_URL = "https://cdn.jsdelivr.net/npm/@mozilla/readability@0.6.0/Readability.js";
const CACHE = path.join(EVAL, ".cache/Readability-0.6.0.js");

async function readabilitySource() {
  if (!fs.existsSync(CACHE)) {
    const r = await fetch(READABILITY_URL);
    if (!r.ok) throw new Error(`fetching Readability.js: HTTP ${r.status}`);
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, await r.text());
  }
  return fs.readFileSync(CACHE, "utf8");
}

const BLOCKS_FN = String.raw`const __blocks = (root) => [...root.querySelectorAll("h1, h2, h3, h4, h5, p, li, blockquote, pre, figcaption, td, th, dt, dd")]
  .filter((e) => !e.querySelector("p, li, blockquote, pre"))
  .map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");`;

const readerJs = (src) => `${src}
;${BLOCKS_FN}
const __a = new Readability(document.cloneNode(true)).parse();
JSON.stringify(__a ? { title: __a.title, byline: __a.byline, excerpt: __a.excerpt, text: __blocks(new DOMParser().parseFromString(__a.content, "text/html").body) } : { text: "" })`;

// The article's own long paragraphs and the numbers in them, from the live DOM, as the
// reference for what should survive.
const REFERENCE_JS = String.raw`(() => {
  const long = (root) => [...root.querySelectorAll("p")].filter((p) => { try { if (!p.checkVisibility()) return false; } catch {} return p.textContent.trim().length >= 120; });
  let root = document.querySelector("article, main, [role=main]");
  if (!root || long(root).length < 3) root = document.body;
  const paras = long(root).map((p) => p.textContent.replace(/\s+/g, " ").trim());
  const nums = [...new Set(paras.join(" ").match(/\d[\d,.]*\d/g) || [])];
  const consent = /cookie|consent|privacy choices|manage preferences/i.test(document.body.innerText.slice(0, 5000) + [...document.querySelectorAll("[role=dialog], dialog[open]")].map((d) => d.innerText).join(" "));
  return JSON.stringify({ paras, nums, consent_words: consent, root: root === document.body ? "body" : root.tagName.toLowerCase() });
})()`;

const normText = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");

function coverage(text, ref, facts) {
  const t = normText(text);
  const paraHit = ref.paras.filter((p) => t.includes(normText(p).slice(0, 100))).length;
  const numHit = ref.nums.filter((n) => text.includes(n)).length;
  return {
    chars: text.length,
    tokens: tokens(text),
    para_recall: ref.paras.length ? +(paraHit / ref.paras.length).toFixed(3) : null,
    num_recall: ref.nums.length ? +(numHit / ref.nums.length).toFixed(3) : null,
    facts: facts ? facts.map((f) => new RegExp(f, "i").test(text.replace(/\s+/g, " "))) : undefined,
  };
}

const results = resultsFile(args.out);
let todo = URLS.filter((u) => (!args.only || args.only.includes(u.url)) && (args.redo || !results.has(u.url)));
if (Number.isFinite(args.limit)) todo = todo.slice(0, args.limit);
console.log(`probe-strip: ${todo.length} URL(s) to do, ${Object.keys(results.data.rows).length} saved`);

const src = await readabilitySource();
const m = await startMcp({ name: "eval-probe-strip" });
try {
  const tab = await m.newTab();
  for (const { url, facts } of todo) {
    const left = hardEnd - Date.now();
    if (left < 60_000) {
      console.log("time's up; run again to continue");
      break;
    }
    const t0 = Date.now();
    let cancelled = false;
    try {
      await within(Math.min(URL_BUDGET_MS, left), (async () => {
      await within(45_000, m.call("navigate", { tabId: tab, url }), "navigate");
      await sleep(2500);
      const pageText = await within(20_000, m.call("get_page_text", { tabId: tab }), "get_page_text");
      const ref = await within(20_000, m.js(tab, REFERENCE_JS), "reference");
      let reader;
      try {
        reader = await within(20_000, m.js(tab, readerJs(src)), "readability");
      } catch (e) {
        reader = { text: "", error: e.message.slice(0, 200) };
      }
      let arm;
      try {
        arm = await within(20_000, m.js(tab, READER_SNIPPET), "arm snippet");
      } catch (e) {
        arm = { text: "", via: "error", error: e.message.slice(0, 200) };
      }
      const row = {
        url,
        at: new Date().toISOString(),
        ms: Date.now() - t0,
        reference: { root: ref.root, paragraphs: ref.paras.length, numbers: ref.nums.length, consent_words: ref.consent_words },
        page_text: coverage(pageText, ref, facts),
        reader: { ...coverage(reader.text ?? "", ref, facts), title: reader.title ?? null, error: reader.error },
        arm: { ...coverage(arm.text ?? "", ref, facts), via: arm.via, error: arm.error },
      };
      row.reader.token_ratio = row.page_text.tokens ? +(row.reader.tokens / row.page_text.tokens).toFixed(3) : null;
      row.arm.token_ratio = row.page_text.tokens ? +(row.arm.tokens / row.page_text.tokens).toFixed(3) : null;
      if (cancelled) return;
      results.save(url, row);
      console.log(`ok ${url.slice(0, 90)}  page ${row.page_text.tokens}t  reader ${row.reader.tokens}t (${row.reader.token_ratio}) paras ${row.reader.para_recall}  arm ${row.arm.via} ${row.arm.tokens}t`);
      })(), "url");
    } catch (e) {
      cancelled = true;
      results.save(url, { url, at: new Date().toISOString(), error: e.message.slice(0, 300) });
      console.log(`error ${url}: ${e.message.slice(0, 200)}`);
    }
  }
} finally {
  await m.close();
}
