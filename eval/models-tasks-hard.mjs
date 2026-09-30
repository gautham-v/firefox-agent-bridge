// Hard tier for the model x effort benchmark (models.mjs --tier hard). Round 1's six tasks
// (models-tasks.mjs) were at ceiling for Sonnet, Opus and Fable at every effort, and so was a
// first draft of this tier (an aggregation trap, US/Moscow/Sydney DST, a simpler tie-break, a
// books-to-TodoMVC compare, a UI Testing Playground gauntlet and a tldraw loop): Sonnet low
// passed all six in 14-147s, mostly by writing JavaScript against the page (fetching every page,
// or building the tldraw diagram through the editor's API). So this tier adds two kinds of
// difficulty:
// - Rules that must be read, with traps that punish skimming or remembering: 2026 tax law
//   (changed in 2025), the 2026 World Cup tie-breakers (changed from 2022) applied through four
//   levels, and time-zone history for places whose offsets or DST changed.
// - Three tasks that forbid javascript_tool, so the page has to be read and driven like a user
//   would: star ratings that exist only as icons, a canvas diagram with precise layout, and a
//   gauntlet of widgets that resist naive input. Using javascript_tool on those scores 0 (the
//   harness passes the agent's tool calls to check()).
// Same shape as round 1 otherwise: partial credit over named sub-goals, answer tasks checked from
// the final JSON, state tasks checked in the tabs the agent leaves open.
//
// Answer keys and how they were checked (2026-09-29):
// - tax-2026: irs.gov's 2026 inflation-adjustment release (brackets, standard deduction) and its
//   fact sheet on the 2025 law's new deductions (overtime premium only, tips, car-loan interest
//   only for US final assembly); arithmetic by hand, below.
// - wc-tiebreak: the tie-breaking criteria in Wikipedia's 2026 FIFA World Cup article (head-to-
//   head first, re-applied to teams still level, then goal difference, goals, fair play with one
//   deduction per player per match, FIFA ranking) and its third-place table (with the Ghana −3 /
//   Ecuador −5 conduct-score note), applied by hand to invented results.
// - shuttle-timezones: UTC launch times from Wikipedia's List of Space Shuttle missions (the
//   STS-128 row's date is the local date; a footnote says the UTC time is the next day); local
//   times from Node's ICU tz database (tzdata 2026c) for America/Caracas, Australia/Lord_Howe and
//   Pacific/Apia.
// - books-no-js: every book of every category on books.toscrape.com fetched and averaged by
//   script; the TodoMVC inspector and checker run against a list built through the MCP client.
// - uitp-no-js, tldraw-no-js: inspectors and checkers run against pages driven to the goal
//   state through the MCP client.

import { norm, num, toNumber } from "./lib/check.mjs";
import { answerRules, get, sameBag, sameList, score, stateRules } from "./models-tasks.mjs";

export { score };

const NO_JS = "Don't use javascript_tool at all in this task (a run that uses it scores 0); read and operate the pages with the other tools, as a user would.";

// Wraps a check so that any javascript_tool call zeroes every sub-goal (and says so).
const noJs = (check) =>
  function (a, state, trace = []) {
    const used = trace.some((c) => /javascript_tool$/.test(c.name));
    const fields = check.call(this, a, state, trace);
    if (!used) return { ...fields, no_javascript: true };
    return { ...Object.fromEntries(Object.keys(fields).map((k) => [k, false])), no_javascript: false };
  };

// tldraw Editor via React's fiber tree; shapes with label text, fill, dash, bindings.
const TLDRAW_JS = String.raw`(() => {
  const el = document.querySelector(".tl-canvas") || document.querySelector(".tl-container");
  if (!el) return JSON.stringify({ error: "no tldraw canvas" });
  const fk = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
  let f = el[fk], ed = null, n = 0;
  while (f && !ed && n++ < 2000) {
    for (const src of [f.memoizedProps, f.pendingProps]) {
      if (!src) continue;
      for (const v of Object.values(src)) {
        if (v && typeof v === "object" && typeof v.getCurrentPageShapes === "function") ed = v;
        else if (v && v.value && typeof v.value.getCurrentPageShapes === "function") ed = v.value;
      }
    }
    f = f.return;
  }
  if (!ed) return JSON.stringify({ error: "editor not found" });
  const text = (rt) => {
    if (!rt) return "";
    if (typeof rt === "string") return rt;
    const out = [];
    const walk = (node) => { if (node.text) out.push(node.text); (node.content ?? []).forEach(walk); if (node.type === "paragraph") out.push("\n"); };
    walk(rt);
    return out.join("").trim();
  };
  const shapes = ed.getCurrentPageShapes().map((s) => {
    const b = ed.getShapePageBounds(s);
    const out = { id: s.id, type: s.type, geo: s.props.geo ?? null, color: s.props.color ?? null, fill: s.props.fill ?? null, dash: s.props.dash ?? null,
      text: text(s.props.richText ?? s.props.text), x: b?.x, y: b?.y, w: b?.w, h: b?.h };
    if (s.type === "arrow") {
      const bs = ed.getBindingsFromShape(s, "arrow");
      out.start = bs.find((x) => x.props.terminal === "start")?.toId ?? null;
      out.end = bs.find((x) => x.props.terminal === "end")?.toId ?? null;
    }
    return out;
  });
  return JSON.stringify({ shapes });
})()`;

// Local date-time answers: accepts "1997-04-04 13:20", "1997-04-04T13:20", "4 April 1997 13:20"...
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function parseLocal(v) {
  const s = String(v ?? "").toLowerCase();
  let y, mo, d;
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})/))) [y, mo, d] = [+m[3], MONTHS.indexOf(m[2]) + 1, +m[1]];
  else if ((m = s.match(/([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/))) [y, mo, d] = [+m[3], MONTHS.indexOf(m[1]) + 1, +m[2]];
  else return null;
  const t = s.replace(/(\d{4})-(\d{1,2})-(\d{1,2})/, " ").match(/(?:^|[^\d])(\d{1,2}):(\d{2})/);
  if (!t || mo < 1) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} ${t[1].padStart(2, "0")}:${t[2]}`;
}
const sameLocal = (want) => (v) => parseLocal(v) === want;

const TODO_JS = String.raw`(async () => {
  const hash = location.hash;
  const read = () => [...document.querySelectorAll(".todo-list li")].map((li) => ({ title: li.querySelector("label")?.textContent ?? li.textContent, completed: li.classList.contains("completed") }));
  const visible = read();
  location.hash = "#/";
  await new Promise((r) => setTimeout(r, 400));
  const all = read();
  location.hash = hash;
  return JSON.stringify({ hash, visible, all });
})()`;

export const TASKS = [
  // 1 ---------------------------------------------------------------------------------------
  {
    id: "tax-2026",
    desc: "Two 2026 US federal returns from irs.gov's own pages: 2026 brackets and standard deduction (changed by the 2025 law), the new overtime deduction (premium only), tips deduction, and car-loan interest (US final assembly only)",
    kind: "answer",
    prompt: `Work out 2026 US federal taxable income and regular income tax for the two returns below, using the IRS's own pages on irs.gov for every amount and rule (a 2025 law changed several of them, so don't rely on memory). Compute the tax from the 2026 tax rate schedule (the brackets), not the tax table, before any credits. Both returns take the standard deduction. Ignore payroll and state taxes and credits; there is no other income, adjustment or deduction.

1) Single filer, age 45. Form W-2 wages of $91,400. Those wages include $7,500 of overtime pay, all of it paid at time-and-a-half as the Fair Labor Standards Act requires, and $3,200 of cash tips she received as a restaurant server (an occupation on the IRS list of tipped occupations), reported on her W-2. She also had $600 of bank interest. In 2026 she paid $1,900 of interest on a loan she took out in 2026 to buy a new car for personal use, secured by the car; the car's final assembly was in Mexico.

2) Married couple filing jointly, both age 40. Combined W-2 wages of $180,000. Their W-2s report $12,000 of qualified overtime compensation, which is already just the premium portion (the "half" of time-and-a-half). No tips. In 2026 they paid $3,100 of interest on a loan taken out in 2026 to buy a new pickup truck for personal use, secured by the truck, with final assembly in Michigan.

${answerRules('{"single": {"taxable_income": 0, "tax": 0}, "joint": {"taxable_income": 0, "tax": 0}}')}`,
    // Single: AGI 92,000 − standard 16,100 − overtime premium 2,500 (7,500 × 0.5/1.5) − tips 3,200
    // (car: not US-assembled) = 70,200; tax 12,400 × 10% + 38,000 × 12% + 19,800 × 22% = 10,156.
    // Joint: 180,000 − 32,200 − 12,000 − 3,100 = 132,700; tax 24,800 × 10% + 76,000 × 12% +
    // 31,900 × 22% = 18,618. No phase-outs apply (MAGI under $150k single / $200k joint for cars).
    key: { single: { taxable_income: 70200, tax: 10156 }, joint: { taxable_income: 132700, tax: 18618 } },
    check(a) {
      const s = get(a, "single") ?? {};
      const j = get(a, "joint") ?? {};
      return {
        single_taxable_income: num(70200, 1)(get(s, "taxable_income")),
        single_tax: num(10156, 1)(get(s, "tax")),
        joint_taxable_income: num(132700, 1)(get(j, "taxable_income")),
        joint_tax: num(18618, 1)(get(j, "tax")),
      };
    },
  },

  // 2 ---------------------------------------------------------------------------------------
  {
    id: "wc-tiebreak",
    desc: "2026 World Cup tie-breakers read from Wikipedia and applied to invented results through four levels (head-to-head goals, re-apply, fair play with one deduction per player per match, FIFA ranking), then placing a team in the real third-place table using a footnote",
    kind: "answer",
    prompt: `Wikipedia's article on the 2026 FIFA World Cup (https://en.wikipedia.org/wiki/2026_FIFA_World_Cup) gives the criteria for ranking teams in a group, and a table ranking the twelve third-placed teams with its own rules and notes. Read them there and apply them exactly as written (a win is 3 points, a draw 1).

Part 1. Invented Group X:
- Corwen 2–2 Arden
- Corwen 1–1 Bexley
- Arden 1–1 Bexley
- Corwen 1–0 Dunmore
- Arden 1–0 Dunmore
- Bexley 4–0 Dunmore
Disciplinary records over the three matches:
- Corwen: match 1, one player booked and later sent off for a second yellow card. Match 2, one player booked. Match 3, one player booked and later shown a straight red card.
- Arden: match 1, two different players booked. Match 2, one player shown a straight red card. Match 3, three different players booked.
- Bexley and Dunmore: no cards.
Latest FIFA Men's World Ranking: Corwen 11th, Arden 16th, Bexley 40th, Dunmore 70th.
Rank Group X from first to fourth, and give Corwen's and Arden's team conduct (fair play) scores.

Part 2. Pellham, from another invented group, finished third with 1 win, 1 draw and 1 loss, 2 goals for and 2 against. Its cards: in one match a player was booked twice and sent off; in another match a different player was booked. If Pellham had been one of the twelve third-placed teams in the real 2026 tournament, at what position (1-13) would it have ranked in the article's table of third-placed teams, and which real team would that have pushed out of the eight places that advanced?

${answerRules('{"group_x_order": ["", "", "", ""], "corwen_fair_play": 0, "arden_fair_play": 0, "pellham_position": 0, "pushed_out": ""}')}`,
    key: { group_x_order: ["Corwen", "Arden", "Bexley", "Dunmore"], corwen_fair_play: -9, arden_fair_play: -9, pellham_position: 4, pushed_out: "Senegal" },
    check(a) {
      const order = (get(a, "group_x_order") ?? []).map((x) => norm(x));
      const idx = (t) => order.indexOf(t);
      return {
        // All three of Corwen, Arden, Bexley have 5 points. Head-to-head among them: all 2 points
        // and goal difference 0, but Bexley scored 2 goals to their 3, so Bexley is third. Corwen
        // and Arden: re-applied to their 2-2 draw, still level; overall goal difference (+1) and
        // goals (4) level; fair play -9 each; FIFA ranking puts Corwen first.
        // 2022's rules (overall goal difference first) put Bexley (+4) first.
        group_order: sameList(order, ["corwen", "arden", "bexley", "dunmore"]),
        bexley_third: order[2] === "bexley",
        corwen_above_arden: idx("corwen") >= 0 && idx("arden") >= 0 && idx("corwen") < idx("arden"),
        // Corwen: -3 (second yellow is one deduction, not -1 and -3) + -1 + -5 (yellow and direct
        // red) = -9. Arden: -2 + -4 + -3 = -9.
        fair_play_scores: num(-9)(get(a, "corwen_fair_play")) && num(-9)(get(a, "arden_fair_play")),
        // 4 points, GD 0, 2 goals ties Ghana (3rd) and Ecuador (4th); the table's note gives their
        // conduct scores (-3, -5); Pellham's is -3 + -1 = -4, so it goes between them, 4th.
        pellham_position: num(4)(get(a, "pellham_position")),
        pushed_out: norm(get(a, "pushed_out")) === "senegal",
      };
    },
  },

  // 3 ---------------------------------------------------------------------------------------
  {
    id: "shuttle-timezones",
    desc: "UTC launch times from a long Wikipedia table (one row's UTC time is on the next day, per a footnote) converted to three clocks whose rules changed: Caracas (UTC-4:30 in 2007-2016), Lord Howe Island (30-minute DST) and Samoa (DST only from 2010)",
    kind: "answer",
    prompt: `Using Wikipedia's "List of Space Shuttle missions" (https://en.wikipedia.org/wiki/List_of_Space_Shuttle_missions), find the launch time in UTC of STS-83, STS-123, STS-128 and STS-133. Read the table and its notes carefully.
For each launch, give the local date and time (24-hour, to the minute) it was in Caracas (Venezuela), on Lord Howe Island (Australia) and in Apia (Samoa), using the clock rules each place actually had on that date, including its standard offset and any daylight saving time as it applied that year. Look up each place's time-zone history if you aren't sure of it.
Also give the time that elapsed between the launch of STS-128 and the launch of STS-133, in days, hours and minutes (drop the seconds).
Write each local time as "YYYY-MM-DD HH:MM".

${answerRules('{"STS-83": {"caracas": "", "lord_howe": "", "apia": ""}, "STS-123": {"caracas": "", "lord_howe": "", "apia": ""}, "STS-128": {"caracas": "", "lord_howe": "", "apia": ""}, "STS-133": {"caracas": "", "lord_howe": "", "apia": ""}, "sts128_to_sts133": {"days": 0, "hours": 0, "minutes": 0}}')}`,
    key: {
      // 1997-04-04 19:20:32 UTC: Caracas -4; Lord Howe +10:30 (summer time ended 30 March); Apia -11.
      "STS-83": { caracas: "1997-04-04 15:20", lord_howe: "1997-04-05 05:50", apia: "1997-04-04 08:20" },
      // 2008-03-11 06:28:14 UTC: Caracas -4:30 (since 9 Dec 2007); Lord Howe +11 (summer time to 6 April); Apia -11.
      "STS-123": { caracas: "2008-03-11 01:58", lord_howe: "2008-03-11 17:28", apia: "2008-03-10 19:28" },
      // Listed as 28 August 2009 03:59:37 UTC, but the UTC time is the next day (footnote):
      // 2009-08-29 03:59 UTC. Caracas -4:30; Lord Howe +10:30; Apia -11.
      "STS-128": { caracas: "2009-08-28 23:29", lord_howe: "2009-08-29 14:29", apia: "2009-08-28 16:59" },
      // 2011-02-24 21:53:24 UTC: Caracas -4:30; Lord Howe +11; Apia -10 (Samoa's first DST, from Sept 2010).
      "STS-133": { caracas: "2011-02-24 17:23", lord_howe: "2011-02-25 08:53", apia: "2011-02-24 11:53" },
      sts128_to_sts133: { days: 544, hours: 17, minutes: 53 },
    },
    check(a) {
      const places = (m) => {
        const want = this.key[m];
        const got = get(a, m) ?? {};
        return ["caracas", "lord_howe", "apia"].every((c) => sameLocal(want[c])(get(got, c) ?? get(got, c.replace("_", ""))));
      };
      const el = get(a, "sts128_to_sts133") ?? {};
      return {
        sts83: places("STS-83"),
        sts123: places("STS-123"),
        sts128: places("STS-128"),
        sts133: places("STS-133"),
        elapsed: num(544)(get(el, "days")) && num(17)(get(el, "hours")) && num(53)(get(el, "minutes")),
      };
    },
  },

  // 4 ---------------------------------------------------------------------------------------
  {
    id: "books-no-js",
    desc: "No JavaScript: star ratings exist only as icons, so 55 books over 4 pages must be read visually to rank three categories; then full titles (list pages truncate them) and prices go into TodoMVC; checked in the app's DOM",
    kind: "state",
    prompt: `Compare three categories of the practice bookstore https://books.toscrape.com: Poetry, Humor and Historical Fiction. For each category, work out the average star rating (1-5) over all of its books, on every page of the category. The winner is the category with the highest average.

Then, in the TodoMVC demo app at https://todomvc.com/examples/react/dist/, build a reading list from the winning category:
1. Add one todo for every book in the winning category priced under £22.00, cheapest first. Title each todo exactly "<full book title> (£<price>)", for example "Some Book (Series #2) (£12.34)". Use each book's full title; the category pages shorten long titles.
2. Mark as completed the todos for books that have a five-star rating.
3. Switch the list to the Active filter.
The app keeps its list only in the page, so do all of this in one tab and never reload it.
${NO_JS}

${stateRules("Leave the TodoMVC tab open when you're done.", '{"winner": "", "average_rating": {"Poetry": 0, "Humor": 0, "Historical Fiction": 0}}')}`,
    inspect: [{ name: "app", url: "todomvc\\.com/examples/react", js: TODO_JS }],
    // Poetry 67/19 = 3.526, Humor 34/10 = 3.400, Historical Fiction 84/26 = 3.231.
    key: {
      winner: "Poetry",
      todos: [
        ["Poems That Make Grown Women Cry", 14.19, 4],
        ["Untitled Collection: Sabbath Poems 2014", 14.27, 4],
        ["The Collected Poems of W.B. Yeats (The Collected Works of W.B. Yeats #1)", 15.42, 5],
        ["Booked", 17.49, 5],
        ["Shakespeare's Sonnets", 20.66, 4],
      ],
    },
    check: noJs(function (a, state) {
      const s = state?.app ?? {};
      const all = s.all ?? [];
      const titles = all.map((x) => x.title);
      const want = this.key.todos.map(([t, p]) => `${t} (£${p.toFixed(2)})`);
      const done = all.filter((x) => x.completed).map((x) => x.title);
      const avg = get(a, "average_rating") ?? {};
      const bare = (t) => norm(t).replace(/ \d+\.\d\d$/, "");
      return {
        winner: norm(get(a, "winner")) === "poetry",
        averages: num(3.526, 0.011)(get(avg, "Poetry")) && num(3.4, 0.011)(get(avg, "Humor")) && num(3.231, 0.011)(get(avg, "Historical Fiction")),
        right_books: sameBag(titles.map(bare), this.key.todos.map(([t]) => norm(t))),
        exact_titles_in_order: titles.length === want.length && titles.every((t, i) => t.trim().replace(/[‘’]/g, "'").replace(/\s+/g, " ") === want[i]),
        completed_five_star: titles.length > 0 && sameBag(done.map(bare), this.key.todos.filter((x) => x[2] === 5).map(([t]) => norm(t))),
        active_filter: /^#\/active$/.test(s.hash ?? "") && (s.visible ?? []).length > 0 && s.visible.every((x) => !x.completed),
      };
    }),
  },

  // 5 ---------------------------------------------------------------------------------------
  {
    id: "uitp-no-js",
    desc: "No JavaScript: UI Testing Playground widgets that resist naive input: a 15 s load, a button renamed only by real input, a link replaced on hover (exact click count), a field that clears itself while covered, scroll-and-hover targets, nine fields of different types to clear, single and multi selects (one with non-breaking spaces), and a table whose values change on reload",
    kind: "state",
    prompt: `Work through these pages of UI Testing Playground (a public test-automation practice site). Use a separate tab for each page and leave every one of those tabs open.
1. http://uitestingplayground.com/ajax: click the button and wait for the label that loads (about 15 seconds). Report its text.
2. http://uitestingplayground.com/textinput: make the blue button's name read exactly: Ship it 42
3. http://uitestingplayground.com/mouseover: click the "Click me" link exactly 3 times, so the page says it was clicked 3 times.
4. http://uitestingplayground.com/overlapped: enter Grace Hopper in the Name field so that it stays there.
5. http://uitestingplayground.com/scrolltoclick: click all four target buttons.
6. http://uitestingplayground.com/clearinput: clear every field, so the page reports that all fields are cleared.
7. http://uitestingplayground.com/select: Programming Language: Python. City: Salt Lake City. Product Version: Release 3.0 (the final release, not the beta). Colors: exactly Red, Blue and Purple. Fruits: keep Apple and Grape, remove Cherry, and add Date.
8. http://uitestingplayground.com/dynamictable: report the CPU value of the Chrome process from the table and the value in the yellow label. Don't reload this page (the values change on every load).
${NO_JS}

${stateRules("Leave the tabs from steps 1-8 open when you're done.", '{"ajax_label": "", "chrome_cpu_table": "", "chrome_cpu_label": ""}')}`,
    inspect: [
      { name: "ajax", url: "uitestingplayground\\.com/ajax", js: `JSON.stringify({ labels: [...document.querySelectorAll("#content .bg-success")].map((p) => p.textContent.trim()) })` },
      { name: "textinput", url: "uitestingplayground\\.com/textinput", js: `JSON.stringify({ button: document.querySelector("#updatingButton")?.textContent ?? null })` },
      { name: "mouseover", url: "uitestingplayground\\.com/mouseover", js: `JSON.stringify({ count: document.querySelector("#clickCount")?.textContent ?? null })` },
      { name: "overlapped", url: "uitestingplayground\\.com/overlapped", js: `JSON.stringify({ name: document.querySelector("#name")?.value ?? null })` },
      { name: "scroll", url: "uitestingplayground\\.com/scrolltoclick", js: `JSON.stringify({ clicked: [1, 2, 3, 4].map((i) => !!document.querySelector("#scrollTarget" + i)?.classList.contains("btn-success")), progress: document.querySelector("#progressText")?.textContent ?? null })` },
      { name: "clear", url: "uitestingplayground\\.com/clearinput", js: `JSON.stringify({ remaining: [...document.querySelectorAll(".clear-target")].filter((f) => (f.tagName === "DIV" ? f.textContent : f.value).trim().length > 0).length, fields: document.querySelectorAll(".clear-target").length, status: document.querySelector("#opstatus")?.textContent ?? null })` },
      { name: "select", url: "uitestingplayground\\.com/select", js: `JSON.stringify(Object.fromEntries([...document.querySelectorAll("select")].map((s) => [s.id, [...s.selectedOptions].map((o) => o.value)])))` },
      {
        name: "table",
        url: "uitestingplayground\\.com/dynamictable",
        js: String.raw`(() => {
  const rows = [...document.querySelectorAll("[role=rowgroup] [role=row]")].map((r) => [...r.querySelectorAll("[role=cell],[role=columnheader]")].map((c) => c.textContent.trim()));
  const head = rows.find((r) => r.includes("Name")) ?? [];
  const chrome = rows.find((r) => r[head.indexOf("Name")] === "Chrome") ?? [];
  return JSON.stringify({ cpu: chrome[head.indexOf("CPU")] ?? null, label: document.querySelector(".bg-warning")?.textContent.trim() ?? null });
})()`,
      },
    ],
    check: noJs(function (a, state) {
      const st = state ?? {};
      const sel = st.select ?? {};
      const pct = (v) => String(v ?? "").match(/-?\d+(\.\d+)?\s*%/)?.[0].replace(/\s/g, "");
      return {
        ajax: (st.ajax?.labels ?? []).some((l) => /loaded with ajax/i.test(l)) && /data loaded with ajax get request/i.test(get(a, "ajax_label") ?? ""),
        text_input: st.textinput?.button === "Ship it 42",
        mouseover_3: st.mouseover?.count === "3",
        overlapped_name: st.overlapped?.name === "Grace Hopper",
        scroll_all_4: (st.scroll?.clicked ?? []).length === 4 && st.scroll.clicked.every(Boolean),
        clear_all: st.clear?.fields > 0 && st.clear?.remaining === 0,
        single_selects: sameList(sel.selectLanguage, ["py"]) && sameList(sel.selectCity, ["slc"]) && sameList(sel.selectProduct, ["v3.0"]),
        multi_selects: sameBag(sel.selectColors, ["red", "blue", "purple"]) && sameBag(sel.selectFruits, ["apple", "date", "grape"]),
        table_cpu: st.table?.cpu != null && pct(get(a, "chrome_cpu_table")) === st.table.cpu && pct(get(a, "chrome_cpu_label")) === pct(st.table.label),
      };
    }),
  },

  // 6 ---------------------------------------------------------------------------------------
  {
    id: "tldraw-no-js",
    desc: "No JavaScript: a labeled three-box loop in tldraw drawn through its UI, with equal sizes, exact bottom alignment, fill and dash styles, three bound arrows, an arrow label and a sticky note; checked from the editor's shapes, props and bindings",
    kind: "state",
    prompt: `On the tldraw canvas at https://examples.tldraw.com/basic/full (an in-memory demo), draw a build-measure-learn loop:
- three rectangles whose own labels (text typed into the shape, not separate text shapes) read Build, Measure and Learn;
- Build at the top, Measure below it to the right, Learn below it to the left, so the three form a triangle;
- all three rectangles the same width and height (within 5 px), and Measure and Learn aligned along their bottom edges (within 2 px);
- Build with a solid fill, and Measure with a dashed outline (use the style panel);
- arrows whose ends are attached (bound) to the shapes: Build → Measure, Measure → Learn and Learn → Build, with the Learn → Build arrow labeled Ideas;
- a sticky note with the text v2, placed to the right of Measure.
Nothing else should be on the canvas. The canvas isn't saved, so work in one tab and never reload it.
${NO_JS}

${stateRules("Leave that tab open on the canvas when you're done.", '{"shapes": 0, "arrows": 0}')}`,
    inspect: [{ name: "canvas", url: "examples\\.tldraw\\.com", js: TLDRAW_JS }],
    check: noJs(function (a, state) {
      const shapes = state?.canvas?.shapes ?? [];
      const geo = shapes.filter((s) => s.type === "geo");
      const byText = (t) => geo.find((s) => norm(s.text) === t);
      const [b, m, l] = ["build", "measure", "learn"].map(byText);
      const rects = [b, m, l];
      const arrows = shapes.filter((s) => s.type === "arrow");
      const notes = shapes.filter((s) => s.type === "note");
      const cx = (s) => s.x + s.w / 2;
      const cy = (s) => s.y + s.h / 2;
      const arrow = (from, to) => (from && to ? arrows.find((x) => x.start === from.id && x.end === to.id) : null);
      const all = rects.every(Boolean);
      return {
        three_labeled_rectangles: all && rects.every((s) => s.geo === "rectangle"),
        triangle_layout: all && cy(b) < Math.min(cy(m), cy(l)) && cx(m) > cx(b) && cx(l) < cx(b),
        same_size: all && Math.max(...rects.map((s) => s.w)) - Math.min(...rects.map((s) => s.w)) <= 5 && Math.max(...rects.map((s) => s.h)) - Math.min(...rects.map((s) => s.h)) <= 5,
        bottoms_aligned: all && Math.abs(m.y + m.h - (l.y + l.h)) <= 2,
        styles: all && b.fill === "solid" && m.dash === "dashed",
        arrows_bound: !!(arrow(b, m) && arrow(m, l) && arrow(l, b)),
        arrow_label: norm(arrow(l, b)?.text) === "ideas",
        sticky_note: notes.length === 1 && norm(notes[0].text) === "v2" && !!m && notes[0].x >= m.x + m.w - 5,
        nothing_else: shapes.length === 7 && geo.length === 3 && arrows.length === 3 && notes.length === 1,
      };
    }),
  },
];

export const taskById = (id) => TASKS.find((t) => t.id === id);
