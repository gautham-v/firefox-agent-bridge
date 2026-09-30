#!/usr/bin/env node
// Accessibility-tree probe. The a11y arm needs privileged code, so it can't be faked end to end;
// this measures what today's read_page misses instead. For ~20 real pages (payment forms,
// embedded editors, video embeds and login widgets in cross-origin iframes included), it
// compares:
//   - a JS inventory of visible interactive elements (links, buttons, inputs, role=*,
//     contenteditable, tabindex, onclick), walking open shadow roots and same-origin frames,
//     plus every cross-origin iframe with its size;
//   - for the larger visible cross-origin frames (up to 4 per page), the same inventory run on
//     the frame's URL in its own tab, as an estimate of what's inside (some frames render
//     differently outside their parent);
//   - read_page's entries (filter "interactive", uncapped and at the default 50k cap), and how
//     many have an empty name or are bare tags (div/span with onclick or tabindex, no role);
//   - output sizes (read_page interactive/all, chars and chars/4 tokens).
//
//   node eval/probe-a11y.mjs [--max-minutes 8] [--limit N] [--only url,url] [--redo]
// Writes eval/results/probe-a11y.json; re-run to continue where it stopped.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { INVENTORY_JS, parseReadPage } from "./lib/inventory.mjs";
import { startMcp, sleep, tokens } from "./lib/mcp-client.mjs";
import { probeArgs, resultsFile, within } from "./lib/probe-util.mjs";

const EVAL = path.dirname(fileURLToPath(import.meta.url));
const args = probeArgs({ out: path.join(EVAL, "results/probe-a11y.json") });
// Pages start only while 75s are left, and each gets at most 150s, so a run ends before
// --max-minutes.
const hardEnd = Date.now() + args.maxMinutes * 60_000 - 20_000;
const PAGE_BUDGET_MS = 150_000;
const MAX_FRAMES = 4;
const MIN_FRAME_AREA = 5000; // px², skips tracking pixels and hidden frames

export const PAGES = [
  // payment forms (card fields in cross-origin iframes)
  { url: "https://stripe-payments-demo.appspot.com/", tag: "payment" },
  { url: "https://developer.squareup.com/reference/sdks/web/payments/card-payments", tag: "payment" },
  { url: "https://www.paypal.com/buttons/", tag: "payment" },
  { url: "https://docs.stripe.com/payments/checkout", tag: "payment" },
  // embedded editors
  { url: "https://css-tricks.com/snippets/css/a-guide-to-flexbox/", tag: "editor" }, // CodePen embeds
  { url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button", tag: "editor" }, // mdnplay.dev live samples
  { url: "https://jsfiddle.net/", tag: "editor" },
  { url: "https://codepen.io/pen/", tag: "editor" },
  { url: "https://www.typescriptlang.org/play", tag: "editor" },
  { url: "https://www.w3schools.com/tryit/tryit.asp?filename=tryhtml_default", tag: "editor" },
  // video embeds
  { url: "https://developers.google.com/youtube/iframe_api_reference", tag: "video" },
  { url: "https://www.w3schools.com/html/tryit.asp?filename=tryhtml_youtubeiframe", tag: "video" },
  // login / captcha widgets
  { url: "https://accounts.hcaptcha.com/demo", tag: "login" },
  { url: "https://www.google.com/recaptcha/api2/demo", tag: "login" },
  { url: "https://demo.turnstile.workers.dev/", tag: "login" }, // widget sits in a closed shadow root
  // ordinary pages
  { url: "https://news.ycombinator.com/", tag: "plain" },
  { url: "https://en.wikipedia.org/wiki/Firefox", tag: "plain" },
  { url: "https://github.com/mozilla/readability", tag: "plain" },
  { url: "https://jobs.ashbyhq.com/ramp", tag: "plain" },
  { url: "https://www.theguardian.com/international", tag: "plain" },
  { url: "https://www.bbc.com/news", tag: "plain" },
  { url: "https://www.npmjs.com/package/express", tag: "plain" },
  { url: "https://excalidraw.com/", tag: "app" },
];

const results = resultsFile(args.out);
let todo = PAGES.filter((p) => (!args.only || args.only.includes(p.url)) && (args.redo || !results.has(p.url)));
if (Number.isFinite(args.limit)) todo = todo.slice(0, args.limit);
console.log(`probe-a11y: ${todo.length} page(s) to do, ${Object.keys(results.data.rows).length} saved`);

const m = await startMcp({ name: "eval-probe-a11y" });
try {
  const tab = await m.newTab();
  const frameTab = await m.newTab();
  for (const { url, tag } of todo) {
    const left = hardEnd - Date.now();
    if (left < 75_000) {
      console.log("time's up; run again to continue");
      break;
    }
    const t0 = Date.now();
    let cancelled = false;
    try {
      await within(Math.min(PAGE_BUDGET_MS, left), (async () => {
      await within(45_000, m.call("navigate", { tabId: tab, url }), "navigate");
      await sleep(4000); // embeds and widgets load after the page
      const inv = await within(30_000, m.js(tab, INVENTORY_JS), "inventory");
      const rpInteractive = await within(30_000, m.call("read_page", { tabId: tab, filter: "interactive", max_chars: 2_000_000 }), "read_page interactive");
      const rpInteractiveDefault = await within(30_000, m.call("read_page", { tabId: tab, filter: "interactive" }), "read_page interactive default");
      const rpAll = await within(30_000, m.call("read_page", { tabId: tab }), "read_page all");
      const parsed = parseReadPage(rpInteractive);
      const parsedDefault = parseReadPage(rpInteractiveDefault);

      // What's inside the bigger cross-origin frames, opened on their own.
      const frames = inv.crossOriginFrames
        .filter((f) => f.visible && f.w * f.h >= MIN_FRAME_AREA && /^https?:/.test(f.src))
        .sort((a, b) => b.w * b.h - a.w * a.h)
        .slice(0, MAX_FRAMES);
      const frameInventories = [];
      for (const f of frames) {
        if (cancelled) return;
        try {
          await within(20_000, m.call("navigate", { tabId: frameTab, url: f.src }), "frame navigate");
          await sleep(2500);
          const fi = await within(15_000, m.js(frameTab, INVENTORY_JS), "frame inventory");
          frameInventories.push({ host: f.host, w: f.w, h: f.h, total: fi.total, counts: fi.counts, names: fi.names });
        } catch (e) {
          frameInventories.push({ host: f.host, w: f.w, h: f.h, error: e.message.slice(0, 200) });
        }
      }
      await m.call("navigate", { tabId: frameTab, url: "about:blank" }).catch(() => {});

      const topOnly = inv.total - inv.sameOriginFrameElements;
      const row = {
        url, tag,
        at: new Date().toISOString(),
        ms: Date.now() - t0,
        inventory: {
          total: inv.total,
          top_document: topOnly,
          same_origin_frame_elements: inv.sameOriginFrameElements,
          same_origin_frames: inv.sameOriginFrames,
          open_shadow_roots: inv.shadowRoots,
          counts: inv.counts,
          names: inv.names,
          name_samples: inv.samples,
        },
        cross_origin_frames: {
          count: inv.crossOriginFrames.length,
          visible: inv.crossOriginFrames.filter((f) => f.visible).length,
          visible_area_px: inv.crossOriginFrames.filter((f) => f.visible).reduce((s, f) => s + f.w * f.h, 0),
          hosts: [...new Set(inv.crossOriginFrames.map((f) => f.host))],
          list: inv.crossOriginFrames.slice(0, 15),
          opened: frameInventories,
          interactive_inside_opened: frameInventories.reduce((s, f) => s + (f.total ?? 0), 0),
        },
        read_page: {
          entries: parsed.entries,
          empty_name: parsed.emptyName,
          generic_tag: parsed.genericTag,
          iframe_entries: parsed.iframes,
          by_role: parsed.byRole,
          chars_interactive_uncapped: rpInteractive.length,
          chars_interactive_default: rpInteractiveDefault.length,
          entries_at_default_cap: parsedDefault.entries,
          truncated_at_default_cap: parsedDefault.truncated,
          chars_all_default: rpAll.length,
          tokens_interactive_uncapped: tokens(rpInteractive),
          tokens_all_default: tokens(rpAll),
        },
      };
      // Interactive elements the agent can't reach through read_page: same-origin frame contents
      // (read_page walks the top frame only), and what's inside cross-origin frames.
      row.gap = {
        top_document_minus_read_page: topOnly - parsed.entries,
        same_origin_frame_elements: inv.sameOriginFrameElements,
        cross_origin_frame_elements_estimate: row.cross_origin_frames.interactive_inside_opened,
        missed_estimate: Math.max(0, topOnly - parsed.entries) + inv.sameOriginFrameElements + row.cross_origin_frames.interactive_inside_opened,
      };
      if (cancelled) return;
      results.save(url, row);
      console.log(
        `ok ${url.slice(0, 70)}  inv ${inv.total} (frames ${inv.sameOriginFrameElements})  read_page ${parsed.entries} (empty ${parsed.emptyName}, bare ${parsed.genericTag})  xo-frames ${inv.crossOriginFrames.length} inside ${row.cross_origin_frames.interactive_inside_opened}  ${(row.ms / 1000).toFixed(0)}s`,
      );
      })(), "page");
    } catch (e) {
      cancelled = true;
      results.save(url, { url, tag, at: new Date().toISOString(), error: e.message.slice(0, 300) });
      console.log(`error ${url}: ${e.message.slice(0, 200)}`);
    }
  }
} finally {
  await m.close();
}
