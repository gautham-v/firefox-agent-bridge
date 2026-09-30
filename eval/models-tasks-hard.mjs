// Hard tier for the model x effort benchmark (models.mjs --tier hard). Round 1's six tasks
// (models-tasks.mjs) were at ceiling for Sonnet, Opus and Fable at every effort, so these add what
// they lacked: traps where the obvious reading is wrong, rules that must be read from a page
// instead of remembered, exact aggregation over paginated data, precision timing, and precise
// canvas work. Same shape as round 1: partial credit over named sub-goals, answer tasks checked
// from the final JSON, state tasks checked in the tabs the agent leaves open.
//
// Answer keys and how they were checked (2026-09-29):
// - hockey-franchises: all 582 rows of scrapethissite.com/pages/forms fetched (per_page=100, 6
//   pages) and summed by script; spot-checked in Firefox.
// - shuttle-timezones: UTC launch times read from Wikipedia's List of Space Shuttle missions
//   (the STS-128 row's date is the local date; its footnote says the UTC time is the next day);
//   local times from Node's ICU tz database (tzdata 2026c) for America/Chicago, Europe/Moscow
//   and Australia/Sydney.
// - wc-tiebreak: the tie-breaking criteria in Wikipedia's 2026 FIFA World Cup article (head-to-head
//   first, then re-applied to teams still level; fair-play deductions, one per player per match),
//   applied by hand to invented results chosen so that the 2022 rules, or skipping the re-apply
//   step, or counting a second yellow as yellow + red, each give a different answer.
// - books-to-todo: every book of every category on books.toscrape.com fetched and averaged by
//   script; the winner is decided only by the later pages (page 1 alone ranks Fiction first).
// - uitp-timing: live state of the tabs left open (random values differ per load).
// - tldraw-loop: tldraw's editor state in the tab left open.

import { norm, num, toNumber } from "./lib/check.mjs";
import { answerRules, get, safe, sameBag, sameList, score, stateRules } from "./models-tasks.mjs";

export { score };

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

export const TASKS = [
  // 1 ---------------------------------------------------------------------------------------
  {
    id: "hockey-franchises",
    desc: "582 rows over 24 pages; group seasons by franchise across moves and renames. Traps: two different franchises played as the Winnipeg Jets; the Dallas franchise's 3 North Stars seasons decide the most-wins question; a lockout season is missing",
    kind: "answer",
    prompt: `On https://www.scrapethissite.com/pages/forms/ (Hockey Teams: NHL regular seasons from 1990 to 2011; the Year column is the year the season started), count by franchise: a club that moved to another city or changed its name is the same franchise before and after. Use what you know about NHL history only to decide which team names belong to the same franchise; take every number from the page.
a) Total wins on this page for the franchise that played the 2011 season as the Winnipeg Jets.
b) Total wins on this page for the franchise that played the 2011 season as the Phoenix Coyotes.
c) Of the franchises that appear on this page under more than one team name, which one won the most games in total on the page? Name it by its 2011 team name, and give the total.
d) The single season in which franchise (a) won the most games: the Year, and the team name it played under that season.
e) Which years from 1990 to 2011 have no rows at all on the page?

${answerRules('{"a_wins": 0, "b_wins": 0, "c_franchise": "", "c_wins": 0, "d_year": 0, "d_team": "", "e_missing_years": [0]}')}`,
    key: { a_wins: 379, b_wins: 732, c_franchise: "Dallas Stars", c_wins: 847, d_year: 2006, d_team: "Atlanta Thrashers", e_missing_years: [2004] },
    check(a) {
      const missing = get(a, "e_missing_years");
      return {
        // Atlanta Thrashers 1999-2010 (342) + Winnipeg Jets 2011 (37); not the 1990-95 Jets.
        a_jets_2011_franchise: num(379)(get(a, "a_wins")),
        // Winnipeg Jets 1990-95 (175) + Phoenix Coyotes 1996-2011 (557).
        b_coyotes_franchise: num(732)(get(a, "b_wins")),
        // Minnesota North Stars (95) + Dallas Stars (752) = 847 beats Quebec + Colorado (824).
        c_most_wins: /dallas/.test(norm(get(a, "c_franchise"))) && num(847)(get(a, "c_wins")),
        d_best_season: num(2006)(get(a, "d_year")) && /atlanta|thrashers/.test(norm(get(a, "d_team"))),
        e_missing: Array.isArray(missing) && missing.length === 1 && toNumber(missing[0]) === 2004,
      };
    },
  },

  // 2 ---------------------------------------------------------------------------------------
  {
    id: "shuttle-timezones",
    desc: "UTC launch times from a long Wikipedia table converted to three cities' clocks with the DST rules of each year (US pre-2007, Moscow's old DST, Sydney's changing dates); one row's UTC time is on the next day (footnote)",
    kind: "answer",
    prompt: `Using Wikipedia's "List of Space Shuttle missions" (https://en.wikipedia.org/wiki/List_of_Space_Shuttle_missions), find the launch time in UTC of STS-83, STS-95, STS-123 and STS-128. For each launch, give the local date and time (24-hour, to the minute) it was in Houston (Mission Control), Moscow and Sydney, using the clock rules each city actually had on that date, including daylight saving time as it applied that year. Read the table and its notes carefully.
Also give the time that elapsed between the launch of STS-83 and the launch of its reflight, STS-94, in days, hours and minutes (drop the seconds).
Write each local time as "YYYY-MM-DD HH:MM".

${answerRules('{"STS-83": {"houston": "", "moscow": "", "sydney": ""}, "STS-95": {"houston": "", "moscow": "", "sydney": ""}, "STS-123": {"houston": "", "moscow": "", "sydney": ""}, "STS-128": {"houston": "", "moscow": "", "sydney": ""}, "sts83_to_sts94": {"days": 0, "hours": 0, "minutes": 0}}')}`,
    key: {
      "STS-83": { houston: "1997-04-04 13:20", moscow: "1997-04-04 23:20", sydney: "1997-04-05 05:20" },
      "STS-95": { houston: "1998-10-29 13:19", moscow: "1998-10-29 22:19", sydney: "1998-10-30 06:19" },
      "STS-123": { houston: "2008-03-11 01:28", moscow: "2008-03-11 09:28", sydney: "2008-03-11 17:28" },
      "STS-128": { houston: "2009-08-28 22:59", moscow: "2009-08-29 07:59", sydney: "2009-08-29 13:59" },
      sts83_to_sts94: { days: 87, hours: 22, minutes: 41 },
    },
    check(a) {
      const cities = (m) => {
        const want = this.key[m];
        const got = get(a, m) ?? {};
        return ["houston", "moscow", "sydney"].every((c) => sameLocal(want[c])(get(got, c)));
      };
      const el = get(a, "sts83_to_sts94") ?? {};
      return {
        // 1997-04-04: US DST started 6 April (CST); Moscow on summer time since 30 March (+4);
        // Sydney off summer time since 30 March (+10), so it is already 5 April there.
        sts83: cities("STS-83"),
        // 1998-10-29: US and Moscow back on standard time (25 October); Sydney on summer time (+11).
        sts95: cities("STS-95"),
        // 2008-03-11: US on DST since 9 March (2007 rule); Moscow standard (+3); Sydney DST until 6 April.
        sts123: cities("STS-123"),
        // Listed as 28 August 2009, 03:59 UTC, but a footnote says the UTC time is the next day.
        sts128: cities("STS-128"),
        elapsed: num(87)(get(el, "days")) && num(22)(get(el, "hours")) && num(41)(get(el, "minutes")),
      };
    },
  },

  // 3 ---------------------------------------------------------------------------------------
  {
    id: "wc-tiebreak",
    desc: "Apply the 2026 World Cup tie-breaking rules, read from Wikipedia, to invented results: head-to-head first and re-applied to the teams still level (not 2022's goal difference first); fair-play points with one deduction per player per match",
    kind: "answer",
    prompt: `Wikipedia's article on the 2026 FIFA World Cup (https://en.wikipedia.org/wiki/2026_FIFA_World_Cup) lists the tie-breaking criteria used to rank teams in a group. Read them there and apply them exactly as written to these invented results (a win is 3 points, a draw 1).

Group X:
- Arden 2–1 Bexley
- Bexley 3–0 Corwen
- Corwen 2–0 Arden
- Arden 5–0 Dunmore
- Bexley 1–0 Dunmore
- Corwen 1–0 Dunmore

1) Rank Group X from first to fourth.

2) In another group, Pellham and Quarry finished level on points. They drew 1–1 with each other, and they have the same goal difference and the same number of goals scored in all their group matches. Their disciplinary records over the group:
- Pellham: match 1, one player booked (yellow card). Match 2, one player booked twice and sent off (second yellow card). Match 3, two different players each booked once.
- Quarry: match 1, one player sent off with a straight red card. Match 2, one player booked. Match 3, one player booked.
Pellham is 14th in the most recent FIFA Men's World Ranking and Quarry is 20th.
Give each team's fair play (team conduct) score as defined on the page, and which of the two ranks higher.

${answerRules('{"group_x_order": ["", "", "", ""], "pellham_fair_play": 0, "quarry_fair_play": 0, "higher_ranked": ""}')}`,
    key: { group_x_order: ["Bexley", "Corwen", "Arden", "Dunmore"], pellham_fair_play: -6, quarry_fair_play: -6, higher_ranked: "Pellham" },
    check(a) {
      const order = (get(a, "group_x_order") ?? []).map((x) => norm(x));
      const idx = (t) => order.indexOf(t);
      return {
        // Head-to-head among the three on 6 points: Bexley +2; Arden and Corwen both -1 with 2
        // goals, so criteria a-c are re-applied to Arden v Corwen alone (Corwen won 2-0).
        // The 2022 rules (overall goal difference first) give Arden, Bexley, Corwen.
        group_order: sameList(order, ["bexley", "corwen", "arden", "dunmore"]),
        bexley_first: order[0] === "bexley",
        corwen_above_arden: idx("corwen") >= 0 && idx("arden") >= 0 && idx("corwen") < idx("arden"),
        // -1 + -3 (second yellow is one deduction, not -1 and -3) + -2 = -6.
        pellham_fair_play: num(-6)(get(a, "pellham_fair_play")),
        quarry_fair_play: num(-6)(get(a, "quarry_fair_play")),
        // Level on fair play too, so the FIFA ranking decides.
        higher_ranked: norm(get(a, "higher_ranked")) === "pellham",
      };
    },
  },

  // 4 ---------------------------------------------------------------------------------------
  {
    id: "books-to-todo",
    desc: "Compare three paginated categories in separate tabs (page 1 alone picks the wrong winner), then act on the winner in TodoMVC with full titles (list pages truncate them) and formatted prices; checked in the app's DOM",
    kind: "state",
    prompt: `Compare three categories of the practice bookstore https://books.toscrape.com, each in its own tab: Historical Fiction, Fiction and Fantasy. For each category, work out the average star rating over all of its books (every page of the category). The winner is the category with the highest average.

Then, in the TodoMVC demo app at https://todomvc.com/examples/react/dist/, build a reading list from the winning category:
1. Add one todo for every book in the winning category priced under £22.00, cheapest first. Title each todo exactly "<full book title> (£<price>)", for example "Some Book (Series #2) (£12.34)". Use each book's full title; the category pages shorten long titles.
2. Mark as completed the todos for books that have a five-star rating.
3. Switch the list to the Active filter.
The app keeps its list only in the page, so do all of this in one tab and never reload it.

${stateRules("Leave the TodoMVC tab open when you're done.", '{"winner": "", "average_rating": {"Historical Fiction": 0, "Fiction": 0, "Fantasy": 0}}')}`,
    inspect: [
      {
        name: "app",
        url: "todomvc\\.com/examples/react",
        js: String.raw`(async () => {
  const hash = location.hash;
  const read = () => [...document.querySelectorAll(".todo-list li")].map((li) => ({ title: li.querySelector("label")?.textContent ?? li.textContent, completed: li.classList.contains("completed") }));
  const visible = read();
  location.hash = "#/";
  await new Promise((r) => setTimeout(r, 400));
  const all = read();
  location.hash = hash;
  return JSON.stringify({ hash, visible, all });
})()`,
      },
    ],
    // Historical Fiction 84/26 = 3.231, Fiction 207/65 = 3.185, Fantasy 148/48 = 3.083.
    // Page 1 alone: Fiction 3.45, Historical Fiction 2.95, Fantasy 2.95.
    key: {
      winner: "Historical Fiction",
      todos: [
        ["The Constant Princess (The Tudor Court #1)", 16.62, 3],
        ["A Spy's Devotion (The Regency Spies of London #1)", 16.97, 5],
        ["Lilac Girls", 17.28, 2],
        ["Love, Lies and Spies", 20.55, 2],
        ["Between Shades of Gray", 20.79, 5],
        ["Voyager (Outlander #3)", 21.07, 5],
      ],
    },
    check(a, state) {
      const s = state?.app ?? {};
      const all = s.all ?? [];
      const titles = all.map((x) => x.title);
      const want = this.key.todos.map(([t, p]) => `${t} (£${p.toFixed(2)})`);
      const done = all.filter((x) => x.completed).map((x) => x.title);
      const avg = get(a, "average_rating") ?? {};
      return {
        winner: norm(get(a, "winner")) === "historical fiction",
        averages: num(3.231, 0.011)(get(avg, "Historical Fiction")) && num(3.185, 0.011)(get(avg, "Fiction")) && num(3.083, 0.011)(get(avg, "Fantasy")),
        right_books: sameBag(titles.map((t) => norm(t).replace(/ \d+\.\d\d$/, "")), this.key.todos.map(([t]) => norm(t))),
        exact_titles_in_order: titles.length === want.length && titles.every((t, i) => t.trim().replace(/[‘’]/g, "'").replace(/\s+/g, " ") === want[i]),
        completed_five_star: sameBag(done.map((t) => norm(t).replace(/ \d+\.\d\d$/, "")), this.key.todos.filter((x) => x[2] === 5).map(([t]) => norm(t))),
        active_filter: /^#\/active$/.test(s.hash ?? "") && (s.visible ?? []).length > 0 && s.visible.every((x) => !x.completed),
      };
    },
  },

  // 5 ---------------------------------------------------------------------------------------
  {
    id: "uitp-timing",
    desc: "UI Testing Playground: stop a randomly-paced progress bar at exactly 75%, wait out two 15 s loads, a button that renames only on real input+change, a link replaced on hover (exact click count), a field that clears itself while covered, and a table whose values change on reload",
    kind: "state",
    prompt: `Work through these pages of UI Testing Playground (a public test-automation practice site). Use a separate tab for each page and leave every one of those tabs open.
1. http://uitestingplayground.com/progressbar: click Start, then click Stop when the bar is at exactly 75%. Each Start picks a random speed, and at some speeds the bar moves a percent every few milliseconds. If you miss, you may Start again; only the final result counts. Use the page's buttons: don't change its variables or call its Start()/Stop() functions yourself.
2. http://uitestingplayground.com/ajax: click the button and wait for the label that loads (it takes about 15 seconds). Report its text.
3. http://uitestingplayground.com/clientdelay: the same, and report that label's text.
4. http://uitestingplayground.com/textinput: make the blue button's name read exactly: Ship it 42
5. http://uitestingplayground.com/mouseover: click the "Click me" link exactly 3 times, so the page says it was clicked 3 times.
6. http://uitestingplayground.com/overlapped: enter Grace Hopper in the Name field so that it stays there.
7. http://uitestingplayground.com/dynamictable: report the CPU value of the Chrome process from the table and the value in the yellow label. Don't reload this page (the values change on every load).

${stateRules("Leave the tabs from steps 1-7 open when you're done.", '{"ajax_label": "", "client_label": "", "chrome_cpu_table": "", "chrome_cpu_label": ""}')}`,
    inspect: [
      {
        name: "progress",
        url: "uitestingplayground\\.com/progressbar",
        js: `JSON.stringify({ ratio: typeof ratio === "number" ? ratio : null, started: typeof started === "boolean" ? started : null, result: document.querySelector("#result")?.textContent ?? null, bar: document.querySelector("#progressBar")?.getAttribute("aria-valuenow") ?? null })`,
      },
      { name: "ajax", url: "uitestingplayground\\.com/ajax", js: `JSON.stringify({ labels: [...document.querySelectorAll("#content .bg-success")].map((p) => p.textContent.trim()) })` },
      { name: "client", url: "uitestingplayground\\.com/clientdelay", js: `JSON.stringify({ labels: [...document.querySelectorAll("#content .bg-success")].map((p) => p.textContent.trim()) })` },
      { name: "textinput", url: "uitestingplayground\\.com/textinput", js: `JSON.stringify({ button: document.querySelector("#updatingButton")?.textContent ?? null })` },
      { name: "mouseover", url: "uitestingplayground\\.com/mouseover", js: `JSON.stringify({ count: document.querySelector("#clickCount")?.textContent ?? null })` },
      { name: "overlapped", url: "uitestingplayground\\.com/overlapped", js: `JSON.stringify({ name: document.querySelector("#name")?.value ?? null })` },
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
    check(a, state) {
      const st = state ?? {};
      const p = st.progress ?? {};
      const stopped = p.started === false && /Result: -?\d+/.test(p.result ?? "");
      const pct = (v) => String(v ?? "").match(/-?\d+(\.\d+)?\s*%/)?.[0].replace(/\s/g, "");
      return {
        progress_within_1: stopped && Math.abs(p.ratio - 75) <= 1,
        progress_exact_75: stopped && p.ratio === 75,
        ajax: (st.ajax?.labels ?? []).some((l) => /loaded with ajax/i.test(l)) && /data loaded with ajax get request/i.test(get(a, "ajax_label") ?? ""),
        client_delay: (st.client?.labels ?? []).some((l) => /calculated on the client/i.test(l)) && /data calculated on the client side/i.test(get(a, "client_label") ?? ""),
        text_input: st.textinput?.button === "Ship it 42",
        mouseover_3: st.mouseover?.count === "3",
        overlapped_name: st.overlapped?.name === "Grace Hopper",
        table_cpu: st.table?.cpu != null && pct(get(a, "chrome_cpu_table")) === st.table.cpu && pct(get(a, "chrome_cpu_label")) === pct(st.table.label),
      };
    },
  },

  // 6 ---------------------------------------------------------------------------------------
  {
    id: "tldraw-loop",
    desc: "tldraw: a labeled three-box loop with equal sizes, exact bottom alignment, fill and dash styles, three bound arrows, an arrow label and a sticky note; checked from the editor's shapes, props and bindings",
    kind: "state",
    prompt: `On the tldraw canvas at https://examples.tldraw.com/basic/full (an in-memory demo), draw a build-measure-learn loop:
- three rectangles whose own labels (text typed into the shape, not separate text shapes) read Build, Measure and Learn;
- Build at the top, Measure below it to the right, Learn below it to the left, so the three form a triangle;
- all three rectangles the same width and height (within 5 px), and Measure and Learn aligned along their bottom edges (within 2 px);
- Build with a solid fill, and Measure with a dashed outline (use the style panel);
- arrows whose ends are attached (bound) to the shapes: Build → Measure, Measure → Learn and Learn → Build, with the Learn → Build arrow labeled Ideas;
- a sticky note with the text v2, placed to the right of Measure.
Nothing else should be on the canvas. The canvas isn't saved, so work in one tab and never reload it.

${stateRules("Leave that tab open on the canvas when you're done.", '{"shapes": 0, "arrows": 0}')}`,
    inspect: [{ name: "canvas", url: "examples\\.tldraw\\.com", js: TLDRAW_JS }],
    check(a, state) {
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
    },
  },
];

export const taskById = (id) => TASKS.find((t) => t.id === id);
