// Eval tasks: read-only, public pages, no logins. Each has a fixed answer key (checked by hand
// in Firefox on 2026-09-29) and a checker over the JSON object the agent ends its reply with.
// Tasks whose pages change daily (job boards, package registries) also have liveKey(), which
// rebuilds the key from the site's public API at check time; the static key is kept for reference.
//
// arms: which non-baseline arms run this task (baseline runs every task).

import { checkFields, eqNorm, match, num, pyReq, sameSet } from "./lib/check.mjs";

const RULES = [
  "Use only the Firefox browser tools. This is read-only: don't sign in, submit forms, buy or post anything.",
  "Close every tab you opened (tabs_close_mcp) before you finish.",
  "End your reply with one line holding only a JSON object in exactly this shape:",
].join("\n");

const prompt = (body, shape) => `${body}\n\n${RULES}\n${shape}`;

export const TASKS = [
  // ---- articles (strip) ----------------------------------------------------------------------
  {
    id: "art-ars-dragon",
    kind: "article",
    arms: ["strip"],
    prompt: prompt(
      "Read the Ars Technica article at https://arstechnica.com/space/2026/09/nasa-has-a-dragon-dilemma-and-there-appear-to-be-no-good-answers/ and answer from the article only: how much NASA invested in developing and certifying Crew Dragon (billions of USD); how much more NASA will now invest in Boeing's Starliner (millions of USD); Starliner's price per seat to NASA during the ISS era (millions of USD); SpaceX's per-seat price for recent Dragon missions (millions of USD); and how many missions SpaceX has flown for NASA to the space station.",
      '{"crew_dragon_investment_billion_usd": 0, "starliner_additional_million_usd": 0, "starliner_seat_price_million_usd": 0, "dragon_recent_seat_price_million_usd": 0, "dragon_missions_flown_for_nasa": 0}',
    ),
    key: {
      crew_dragon_investment_billion_usd: 3.1,
      starliner_additional_million_usd: 359,
      starliner_seat_price_million_usd: 90,
      dragon_recent_seat_price_million_usd: 78.8,
      dragon_missions_flown_for_nasa: 13,
    },
    check: (a) =>
      checkFields(a, {
        crew_dragon_investment_billion_usd: num(3.1, 0.001),
        starliner_additional_million_usd: num(359),
        starliner_seat_price_million_usd: num(90),
        dragon_recent_seat_price_million_usd: num(78.8, 0.001),
        dragon_missions_flown_for_nasa: num(13),
      }),
  },
  {
    id: "art-ars-firefox",
    kind: "article",
    arms: ["strip"],
    prompt: prompt(
      "Read the Ars Technica interview at https://arstechnica.com/gadgets/2026/09/mozillas-head-of-firefox-talks-product-priorities-ai-skepticism-and-browser-choice/ and answer from the article only: which Firefox version number ships the redesign; the full name of the Forrester analyst quoted; the upper bound, in percent, that Ajit Varma gives for the share of Firefox engineering working on AI; and what Varma calls the biggest new area of investment over the last 12 months (a few words).",
      '{"firefox_version": 0, "forrester_analyst": "", "ai_engineering_share_max_percent": 0, "biggest_new_investment_area": ""}',
    ),
    key: {
      firefox_version: 157,
      forrester_analyst: "Paddy Harrington",
      ai_engineering_share_max_percent: 10,
      biggest_new_investment_area: "tools for enterprises and schools",
    },
    check: (a) =>
      checkFields(a, {
        firefox_version: num(157),
        forrester_analyst: match(/paddy\s+harrington/i),
        ai_engineering_share_max_percent: num(10),
        biggest_new_investment_area: match(/enterprise|school/i),
      }),
  },
  {
    id: "art-guardian-tang",
    kind: "article",
    arms: ["strip"],
    prompt: prompt(
      "Read the Guardian long read at https://www.theguardian.com/news/2026/sep/29/why-am-i-obsessed-with-chinas-ancient-golden-age-i-took-my-daughter-on-a-trip-to-find-out and answer from the article only: the length of Xi'an's city wall in km; how far the Huaqing hot springs are from Xi'an in km; how many chapters the Old Book of Tang has; the number of caves at the Longmen Grottoes given on the signpost; and the author's daughter's age.",
      '{"xian_wall_km": 0, "huaqing_distance_km": 0, "old_book_of_tang_chapters": 0, "longmen_caves": 0, "daughter_age": 0}',
    ),
    key: { xian_wall_km: 14, huaqing_distance_km: 20, old_book_of_tang_chapters: 200, longmen_caves: 2345, daughter_age: 11 },
    check: (a) =>
      checkFields(a, {
        xian_wall_km: num(14),
        huaqing_distance_km: num(20),
        old_book_of_tang_chapters: num(200),
        longmen_caves: num(2345),
        daughter_age: num(11),
      }),
  },

  // ---- list / search pages that load their data with fetch/XHR (data) -------------------------
  {
    id: "data-hn-readability",
    kind: "list",
    arms: ["data"],
    prompt: prompt(
      'On https://hn.algolia.com search for readability with the filters Stories, by Popularity, for All time (the site\'s default matching). How many of the matching stories have at least 50 points? Among those stories, which ones link to a URL whose host is exactly github.com? Give their titles as shown.',
      '{"stories_with_at_least_50_points": 0, "github_titles": [""]}',
    ),
    key: {
      stories_with_at_least_50_points: 41,
      github_titles: [
        "Show HN: Defuddle, an HTML-to-Markdown alternative to Readability",
        "Readability.js",
        "Readability-inspired Wikipedia Beautifier for Chrome",
      ],
    },
    check(a, key = this.key) {
      return checkFields(a, {
        stories_with_at_least_50_points: num(key.stories_with_at_least_50_points),
        github_titles: sameSet(key.github_titles),
      });
    },
  },
  {
    id: "data-crates-html",
    kind: "list",
    arms: ["data"],
    prompt: prompt(
      'On https://crates.io search for html parser and sort by All-Time Downloads. Look at the top 20 results. Which of those crates have a description containing the word "HTML" (any case)? Also give the name of the #1 result.',
      '{"top_crate": "", "html_crates": [""]}',
    ),
    key: {
      top_crate: "form_urlencoded",
      html_crates: ["form_urlencoded", "html5ever", "ammonia", "dom_query", "html2text", "lol_html", "password-rules-parser"],
    },
    async liveKey() {
      const r = await fetch("https://crates.io/api/v1/crates?q=html%20parser&sort=downloads&per_page=20", {
        headers: { "user-agent": "firefox-agent-bridge-eval (https://github.com/gautham-v/firefox-agent-bridge)" },
      });
      const j = await r.json();
      return { top_crate: j.crates[0].name, html_crates: j.crates.filter((c) => /html/i.test(c.description ?? "")).map((c) => c.name) };
    },
    check(a, key = this.key) {
      return checkFields(a, {
        top_crate: eqNorm(key.top_crate),
        html_crates: sameSet(key.html_crates), // norm() treats "_" and "-" alike, as crates.io does
      });
    },
  },
  {
    id: "data-ashby-ramp",
    kind: "list",
    arms: ["data"],
    prompt: prompt(
      "On Ramp's job board at https://jobs.ashbyhq.com/ramp, how many open roles are in the Engineering department? Which Engineering roles don't list New York among their locations? Give their titles as shown.",
      '{"engineering_count": 0, "non_new_york_engineering_titles": [""]}',
    ),
    key: {
      engineering_count: 37,
      // "Software Engineer, Forward Deployed" is listed as "San Francisco, CA; New York, NY (HQ)".
      non_new_york_engineering_titles: ["Software Engineer, International"],
    },
    async liveKey() {
      const j = await (await fetch("https://api.ashbyhq.com/posting-api/job-board/ramp")).json();
      const eng = j.jobs.filter((x) => x.department?.trim() === "Engineering");
      const places = (x) => [x.location, ...(x.secondaryLocations ?? []).map((l) => l.location)];
      return {
        engineering_count: eng.length,
        non_new_york_engineering_titles: eng.filter((x) => !places(x).some((l) => /new york/i.test(l ?? ""))).map((x) => x.title.trim()),
      };
    },
    check(a, key = this.key) {
      return checkFields(a, {
        engineering_count: num(key.engineering_count),
        non_new_york_engineering_titles: sameSet(key.non_new_york_engineering_titles),
      });
    },
  },

  // ---- compare several pages (fanout) --------------------------------------------------------
  {
    id: "cmp-pypi",
    kind: "compare",
    arms: ["fanout"],
    prompt: prompt(
      'Compare these five Python packages using their PyPI project pages (https://pypi.org/project/<name>/): requests, httpx, aiohttp, urllib3, flask. For each, give the latest version shown on the page and its "Requires: Python" constraint exactly as shown (e.g. ">=3.9").',
      '{"requests": {"version": "", "requires_python": ""}, "httpx": {...}, "aiohttp": {...}, "urllib3": {...}, "flask": {...}}',
    ),
    key: {
      requests: { version: "2.34.2", requires_python: ">=3.10" },
      httpx: { version: "0.28.1", requires_python: ">=3.8" },
      aiohttp: { version: "3.14.3", requires_python: ">=3.10" },
      urllib3: { version: "2.8.0", requires_python: ">=3.10" },
      flask: { version: "3.1.3", requires_python: ">=3.9" },
    },
    async liveKey() {
      const out = {};
      for (const p of Object.keys(this.key)) {
        const j = await (await fetch(`https://pypi.org/pypi/${p}/json`)).json();
        out[p] = { version: j.info.version, requires_python: j.info.requires_python };
      }
      return out;
    },
    check(a, key = this.key) {
      const checks = {};
      for (const [p, v] of Object.entries(key)) {
        checks[`${p}|version`] = eqNorm(v.version);
        checks[`${p}|requires_python`] = pyReq(v.requires_python);
      }
      return checkFields(a, checks);
    },
  },
  {
    id: "cmp-npm",
    kind: "compare",
    arms: ["fanout"],
    prompt: prompt(
      "Compare these five Node web frameworks using their npm package pages (https://www.npmjs.com/package/<name>): express, koa, fastify, hono, @hapi/hapi. For each, give the number of dependencies and the license shown for the latest version.",
      '{"express": {"dependencies": 0, "license": ""}, "koa": {...}, "fastify": {...}, "hono": {...}, "@hapi/hapi": {...}}',
    ),
    key: {
      express: { dependencies: 28, license: "MIT" },
      koa: { dependencies: 18, license: "MIT" },
      fastify: { dependencies: 15, license: "MIT" },
      hono: { dependencies: 0, license: "MIT" },
      "@hapi/hapi": { dependencies: 18, license: "BSD-3-Clause" },
    },
    async liveKey() {
      const out = {};
      for (const p of Object.keys(this.key)) {
        const j = await (await fetch(`https://registry.npmjs.org/${p.replace("/", "%2F")}/latest`)).json();
        out[p] = { dependencies: Object.keys(j.dependencies ?? {}).length, license: j.license };
      }
      return out;
    },
    check(a, key = this.key) {
      const checks = {};
      for (const [p, v] of Object.entries(key)) {
        checks[`${p}|dependencies`] = num(v.dependencies);
        checks[`${p}|license`] = eqNorm(v.license);
      }
      // "hapi" as a key is accepted for "@hapi/hapi".
      if (a && typeof a === "object" && !("@hapi/hapi" in a)) {
        const k = Object.keys(a).find((x) => /hapi/i.test(x));
        if (k) a = { ...a, "@hapi/hapi": a[k] };
      }
      return checkFields(a, checks);
    },
  },
];

export const ARMS = ["baseline", "strip", "data", "fanout"];
export const taskById = (id) => TASKS.find((t) => t.id === id);
