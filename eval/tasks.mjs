// Eval tasks: read-only, public pages, no logins. Each has a fixed answer key (checked by hand
// in Firefox on 2026-09-29) and a checker over the JSON object the agent ends its reply with.
// Tasks whose pages change daily (job boards, package registries) also have liveKey(), which
// rebuilds the key from the site's public API at check time; the static key is kept for reference.
//
// arms: which non-baseline arms run this task (baseline runs every task).
//
// Prompts name "the Firefox browser tools"; promptFor() swaps in "Chrome" for Claude in Chrome
// runs, so both browsers get the same prompt otherwise.

import { checkFields, eqNorm, match, norm, num, pyReq, sameSet } from "./lib/check.mjs";

const RULES = [
  "Use only the Firefox browser tools. This is read-only: don't sign in, submit forms, buy or post anything.",
  "Close every tab you opened (tabs_close_mcp) before you finish.",
  "End your reply with one line holding only a JSON object in exactly this shape:",
].join("\n");

const prompt = (body, shape) => `${body}\n\n${RULES}\n${shape}`;

// General tasks may submit a form, but only to a test endpoint the task names.
const GENERAL_RULES = [
  "Use only the Firefox browser tools. Don't sign in, buy or post anything, and don't submit any form except where the task says to.",
  "Close every tab you opened (tabs_close_mcp) before you finish.",
  "End your reply with one line holding only a JSON object in exactly this shape:",
].join("\n");
const generalPrompt = (body, shape) => `${body}\n\n${GENERAL_RULES}\n${shape}`;

export const promptFor = (task, browser = "firefox") =>
  browser === "chrome" ? task.prompt.replaceAll("the Firefox browser tools", "the Chrome browser tools") : task.prompt;

const str = (v) => String(v ?? "").trim();

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

  // ---- general browsing (browser comparison; baseline only) ----------------------------------
  // Answer keys checked by hand on 2026-09-30 in Firefox (mcp__firefox__* tools); the iframe
  // select was also tried in Chrome (mcp__claude-in-chrome__* tools).
  {
    id: "gen-wiki-chain",
    kind: "general",
    arms: [],
    prompt: generalPrompt(
      "Start at https://en.wikipedia.org/wiki/Firefox and move only by following links between Wikipedia articles (no search box, no typed URLs after the start page): open the article on Firefox's JavaScript engine, then the article on the person who wrote that engine, then the article on the university where that person earned his bachelor's degree. Report the engine, the person, the university, the year the university was established, and its athletics nickname.",
      '{"engine": "", "person": "", "university": "", "established": 0, "nickname": ""}',
    ),
    key: { engine: "SpiderMonkey", person: "Brendan Eich", university: "Santa Clara University", established: 1851, nickname: "Broncos" },
    check: (a) =>
      checkFields(a, {
        engine: match(/spidermonkey/i),
        person: match(/brendan\s+eich/i),
        university: match(/santa\s+clara\s+university/i),
        established: num(1851),
        nickname: match(/broncos?/i),
      }),
  },
  {
    id: "gen-pydocs-search",
    kind: "general",
    arms: [],
    prompt: generalPrompt(
      "Go to https://docs.python.org/3/ and use the site's own search to search for: array bisection. Open the top result. Report the module's name, the Python version in which its functions gained the key parameter (as a string, e.g. \"3.8\"), and the list that the grade() example on that page evaluates to.",
      '{"module": "", "key_param_added_in": "", "grade_example_output": [""]}',
    ),
    key: { module: "bisect", key_param_added_in: "3.10", grade_example_output: ["F", "A", "C", "C", "B", "A", "A"] },
    check: (a) =>
      checkFields(a, {
        module: (v) => norm(v) === "bisect",
        key_param_added_in: (v) => /^(python\s*)?3\.10$/i.test(str(v)),
        grade_example_output: (v) => JSON.stringify(Array.isArray(v) ? v.map(str) : typeof v === "string" ? v.match(/[A-F]/g) : null) === JSON.stringify(["F", "A", "C", "C", "B", "A", "A"]),
      }),
  },
  {
    id: "gen-elements-table",
    kind: "general",
    arms: [],
    prompt: generalPrompt(
      "On https://en.wikipedia.org/wiki/List_of_chemical_elements, use the main table to find, among the period 6 d-block elements, the one with the highest melting point and the one with the highest density. Give each one's symbol and the value exactly as the table lists it (melting point in K, density in g/cm3).",
      '{"highest_melting": {"symbol": "", "melting_point_k": 0}, "highest_density": {"symbol": "", "density_g_cm3": 0}}',
    ),
    key: { highest_melting: { symbol: "W", melting_point_k: 3695 }, highest_density: { symbol: "Os", density_g_cm3: 22.59 } },
    check: (a) =>
      checkFields(a, {
        "highest_melting|symbol": (v) => str(v) === "W",
        "highest_melting|melting_point_k": num(3695),
        "highest_density|symbol": (v) => str(v) === "Os",
        "highest_density|density_g_cm3": num(22.59, 0.001),
      }),
  },
  {
    id: "gen-quotes-scroll",
    kind: "general",
    arms: [],
    prompt: generalPrompt(
      "https://quotes.toscrape.com/scroll loads more quotes as you scroll down. Load the whole list, then report how many quotes it has in total, how many of them are by J.K. Rowling, and who wrote the last quote in the list.",
      '{"total_quotes": 0, "jk_rowling_quotes": 0, "last_quote_author": ""}',
    ),
    key: { total_quotes: 100, jk_rowling_quotes: 9, last_quote_author: "George R.R. Martin" },
    check: (a) =>
      checkFields(a, {
        total_quotes: num(100),
        jk_rowling_quotes: num(9),
        last_quote_author: match(/george\s+r\.?\s*r\.?\s+martin/i),
      }),
  },
  {
    id: "gen-httpbin-form",
    kind: "general",
    arms: [],
    prompt: generalPrompt(
      "Fill in the test form at https://httpbin.org/forms/post (httpbin.org is a public test service; submitting this form is fine) with: customer name Eval Tester, telephone 555-0100, e-mail eval@example.com, pizza size Large, toppings Onion and Mushroom (nothing else), preferred delivery time 18:45, delivery instructions: Leave at door 42. Submit it and read the echoed response page. Report the \"form\" object exactly as echoed and the echoed Content-Length request header.",
      '{"form": {"custname": "", "custtel": "", "custemail": "", "size": "", "topping": [""], "delivery": "", "comments": ""}, "content_length": 0}',
    ),
    key: {
      form: { custname: "Eval Tester", custtel: "555-0100", custemail: "eval@example.com", size: "large", topping: ["onion", "mushroom"], delivery: "18:45", comments: "Leave at door 42" },
      content_length: 151,
    },
    check: (a) =>
      checkFields(a, {
        "form|custname": (v) => str(v) === "Eval Tester",
        "form|custtel": (v) => str(v) === "555-0100",
        "form|custemail": (v) => str(v) === "eval@example.com",
        "form|size": (v) => str(v) === "large",
        "form|topping": (v) => Array.isArray(v) && JSON.stringify([...v].map(str).sort()) === JSON.stringify(["mushroom", "onion"]),
        "form|delivery": (v) => str(v) === "18:45",
        "form|comments": (v) => str(v) === "Leave at door 42",
        content_length: num(151),
      }),
  },
  {
    id: "gen-mdn-iframe",
    kind: "general",
    arms: [],
    prompt: generalPrompt(
      "On https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/change_event, the \"<select> element\" example has a live Result that runs in an embedded frame from another origin. In that live Result on the MDN page, choose Sardine in the ice cream flavor dropdown. Report the exact text the example displays after your choice, and how many options the dropdown has (including the placeholder).",
      '{"displayed_text": "", "option_count": 0}',
    ),
    key: { displayed_text: "You like sardine", option_count: 4 },
    check: (a) =>
      checkFields(a, {
        displayed_text: (v) => norm(v) === "you like sardine",
        option_count: num(4),
      }),
  },
  {
    id: "gen-apg-datepicker",
    kind: "general",
    arms: [],
    prompt: generalPrompt(
      "On https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/, use the example's \"Choose Date\" button and its calendar dialog (don't type into the date field) to pick the last Friday of February 2027. Report the value the Date field then shows, and the accessible name (aria-label) the button next to the field then has.",
      '{"date_field_value": "", "button_label": ""}',
    ),
    key: { date_field_value: "2/26/2027", button_label: "Change Date, Friday February 26, 2027" },
    check: (a) =>
      checkFields(a, {
        date_field_value: (v) => /^0?2\/26\/2027$/.test(str(v)),
        button_label: match(/friday,?\s+february\s+26,?\s+2027/i),
      }),
  },
  {
    id: "gen-datatables-scroll",
    kind: "general",
    arms: [],
    prompt: generalPrompt(
      "https://datatables.net/extensions/scroller/examples/initialisation/simple.html shows a table that only renders the rows in view as you scroll it. Find the row with ID 1873 and report its first name, last name, ZIP / post code and country, plus the total number of entries in the table.",
      '{"first_name": "", "last_name": "", "zip": "", "country": "", "total_entries": 0}',
    ),
    key: { first_name: "Ora", last_name: "Hays", zip: "B6F 9Z9", country: "Martinique", total_entries: 2500 },
    check: (a) =>
      checkFields(a, {
        first_name: (v) => norm(v) === "ora",
        last_name: (v) => norm(v) === "hays",
        zip: (v) => str(v).replace(/\s+/g, "").toUpperCase() === "B6F9Z9",
        country: (v) => norm(v) === "martinique",
        total_entries: num(2500),
      }),
  },
];

export const ARMS = ["baseline", "strip", "data", "fanout"];
export const taskById = (id) => TASKS.find((t) => t.id === id);
