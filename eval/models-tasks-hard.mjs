// Hard tier for the model x effort benchmark (models.mjs --tier hard). Round 1's six tasks
// (models-tasks.mjs) were at ceiling for Sonnet, Opus and Fable at every effort. So were two
// drafts of this tier in smoke runs (Sonnet 5.5 low and Fable 5.1 high, 12 of 12 each time):
// - v1: franchise totals with a name-collision trap, US/Moscow/Sydney DST, a simpler tie-break,
//   a books-to-TodoMVC compare and act, a UI Testing Playground timing gauntlet, a tldraw loop.
//   Sonnet low solved most by writing JavaScript against the page (fetching every page, stopping
//   the progress bar from a MutationObserver, building the diagram through tldraw's editor API).
// - v2: 2026 tax rules from irs.gov, Caracas/Lord Howe/Samoa time-zone history, a 4-level
//   tie-break, and no-JavaScript versions of the books, gauntlet and tldraw tasks. Sonnet low
//   read 55 star ratings off screenshots without a mistake and drew the tldraw loop through the
//   UI in 45 s.
// So this version keeps what separated behavior (no JavaScript, rules read from a page) and
// scales up what a careful agent has to get exactly right: a Hard sudoku solved without code,
// exact aggregation over 582 rows read as text, 167 star ratings read as icons, and a 13-shape
// diagram with grid alignment and a frame. Using javascript_tool on a no-JS task scores 0 (the
// harness passes the agent's tool calls to check()).
// Same shape as round 1 otherwise: partial credit over named sub-goals, answer tasks checked from
// the final JSON, state tasks checked in the tabs the agent leaves open.
//
// Answer keys and how they were checked (2026-09-29):
// - sudoku-no-js: websudoku.com Evil puzzle 1,234,567,890; its solution (embedded in the page's
//   script, which the no-JS tools don't expose) matches a brute-force solver, which finds exactly
//   one solution.
// - hockey-no-js: all 582 rows of scrapethissite.com/pages/forms fetched (per_page=100, 6 pages)
//   and counted by script; the Winnipeg rows spot-checked in Firefox with the site's search.
// - books-no-js: every book of every category on books.toscrape.com fetched and averaged by
//   script; the TodoMVC inspector and checker run against a list built through the MCP client.
// - wc-tiebreak: the tie-breaking criteria in Wikipedia's 2026 FIFA World Cup article (head-to-
//   head first, re-applied to teams still level, then goal difference, goals, fair play with one
//   deduction per player per match, FIFA ranking) and its third-place table (with the Ghana −3 /
//   Ecuador −5 conduct-score note), read in Firefox and applied by hand to invented results.
// - uitp-no-js, tldraw-no-js: inspectors and checkers run against pages driven to the goal
//   state through the MCP client.

import { norm, num, toNumber } from "./lib/check.mjs";
import { answerRules, get, sameBag, sameList, score, stateRules } from "./models-tasks.mjs";

export { score };

const NO_JS = "Don't use javascript_tool at all in this task (a run that uses it scores 0); read and operate the pages with the other tools, as a user would.";

// Wraps a check so that any javascript_tool call, also inside a batch (and, with noSource, a
// view-source: page, which only the sudoku prompt forbids), zeroes every sub-goal and adds a failed
// no_javascript field; a clean run's fields are the task's own.
const calls = (trace) => trace.flatMap((c) => (/batch$/.test(c.name) ? (c.input?.actions ?? []).map((x) => ({ name: String(x.tool ?? ""), input: x.args ?? {} })) : [c]));
const noJs = (check, { noSource = false } = {}) =>
  function (a, state, trace = []) {
    const used = calls(trace).some((c) => /javascript_tool$/.test(c.name) || (noSource && /^\s*view-source:/i.test(String(c.input?.url ?? ""))));
    const fields = check.call(this, a, state, trace);
    if (!used) return fields;
    return { ...Object.fromEntries(Object.keys(fields).map((k) => [k, false])), no_javascript: false };
  };

// tldraw Editor via React's fiber tree; shapes with label text, fill, dash, parent, bindings.
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
    const out = { id: s.id, type: s.type, parent: s.parentId, geo: s.props.geo ?? null, color: s.props.color ?? null, fill: s.props.fill ?? null, dash: s.props.dash ?? null,
      name: s.props.name ?? null, text: text(s.props.richText ?? s.props.text), x: b?.x, y: b?.y, w: b?.w, h: b?.h };
    if (s.type === "arrow") {
      const bs = ed.getBindingsFromShape(s, "arrow");
      out.start = bs.find((x) => x.props.terminal === "start")?.toId ?? null;
      out.end = bs.find((x) => x.props.terminal === "end")?.toId ?? null;
    }
    return out;
  });
  return JSON.stringify({ shapes });
})()`;

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

const SUDOKU_SOLUTION = "576429381493817562812536947231784695749653218685192734968245173157368429324971856";

export const TASKS = [
  // 1 ---------------------------------------------------------------------------------------
  {
    id: "sudoku-no-js",
    desc: "No JavaScript: solve an Evil websudoku puzzle (26 givens, one solution) by reasoning and enter all 55 digits through the page; checked from the grid's inputs, row by row",
    kind: "state",
    prompt: `Solve the Sudoku puzzle at https://nine.websudoku.com/?level=4&set_id=1234567890 (Web Sudoku, "Evil" puzzle 1,234,567,890) and fill in every empty cell on that page. Work out the solution yourself; don't look for it in the page's source or on other sites. Don't press the page's buttons once every cell is filled: on a full grid "How am I doing?" submits the puzzle and loads a different page, and the grid is checked in this tab.
${NO_JS}

${stateRules("Leave that tab open with the filled-in grid when you're done (don't press Clear or load another puzzle).", '{"solved": true}')}`,
    inspect: [
      {
        name: "grid",
        url: "websudoku\\.com",
        js: `JSON.stringify({ cells: Array.from({ length: 81 }, (_, i) => document.getElementById("f" + (i % 9) + Math.floor(i / 9))?.value ?? "").join(",") })`,
      },
    ],
    check: noJs(function (a, state) {
      const cells = String(state?.grid?.cells ?? "").split(",");
      const row = (r) => cells.length === 81 && Array.from({ length: 9 }, (_, c) => cells[r * 9 + c].trim() === SUDOKU_SOLUTION[r * 9 + c]).every(Boolean);
      return Object.fromEntries(Array.from({ length: 9 }, (_, r) => [`row_${r + 1}`, row(r)]));
    }, { noSource: true }),
  },

  // 2 ---------------------------------------------------------------------------------------
  {
    id: "hockey-no-js",
    desc: "No JavaScript: exact counts over 582 rows read as text (6 pages at 100 rows, sorted by team, so per-year maxima span every page), with ties, a franchise whose 2011 name was used by a different club in the 1990s, and a 63-number signed sum",
    kind: "answer",
    prompt: `Answer from the table at https://www.scrapethissite.com/pages/forms/ (Hockey Teams: 582 NHL team-seasons from 1990 to 2011; Year is the year the season started; +/- is the goal differential). Every number must come from that table.
a) How many team-seasons have 50 or more wins?
b) How many of those also have a +/- of +60 or more?
c) For each Year, take the team(s) with the most wins that year and the team(s) with the best +/- that year (ties count as all of them). List the years in which none of the teams with the most wins also has the best +/-.
d) Total wins on the page of the franchise that played the 2011 season as the Winnipeg Jets (it played its earlier seasons under another name).
e) The sum of the +/- column over every row of the teams whose names start with "New" (all of their seasons).
${NO_JS}

${answerRules('{"a_50_win_seasons": 0, "b_also_plus_60": 0, "c_years": [0], "d_wins": 0, "e_new_plus_minus_sum": 0}')}`,
    key: { a_50_win_seasons: 34, b_also_plus_60: 20, c_years: [1990, 1993, 2000, 2003, 2005, 2011], d_wins: 379, e_new_plus_minus_sum: 224 },
    check: noJs(function (a) {
      const years = get(a, "c_years");
      return {
        a_50_wins: num(34)(get(a, "a_50_win_seasons")),
        b_plus_60: num(20)(get(a, "b_also_plus_60")),
        // 2006 (Buffalo and Ottawa both +66), 2008 (Boston and San Jose both 53 wins) and 2011
        // (three teams on 51 wins; Boston best at +67) are the tie cases.
        c_years: Array.isArray(years) && sameList(years.map((y) => String(toNumber(y))).sort(), ["1990", "1993", "2000", "2003", "2005", "2011"]),
        // Atlanta Thrashers 1999-2010 (342) + Winnipeg Jets 2011 (37); not the 1990-95 Jets.
        d_franchise_wins: num(379)(get(a, "d_wins")),
        // 63 signed numbers: New Jersey Devils, New York Islanders, New York Rangers.
        e_new_sum: num(224)(get(a, "e_new_plus_minus_sum")),
      };
    }),
  },

  // 3 ---------------------------------------------------------------------------------------
  {
    id: "books-no-js",
    desc: "No JavaScript: star ratings exist only as icons, so 167 books over 10 pages must be read visually to rank three categories (page 1 alone ranks them differently); then 8 full titles (list pages truncate them) and prices go into TodoMVC; checked in the app's DOM",
    kind: "state",
    prompt: `Compare three categories of the practice bookstore https://books.toscrape.com: Young Adult, Fiction and Fantasy. For each category, work out the average star rating (1-5) over all of its books, on every page of the category. The winner is the category with the highest average.

Then, in the TodoMVC demo app at https://todomvc.com/examples/react/dist/, build a reading list from the winning category:
1. Add one todo for every book in the winning category priced under £15.00, cheapest first. Title each todo exactly "<full book title> (£<price>)", with the price to two decimals, for example "Some Book (Series #2) (£12.30)". Use each book's full title; the category pages shorten long titles.
2. Mark as completed the todos for books that have a five-star rating.
3. Switch the list to the Active filter.
The app keeps its list only in the page, so do all of this in one tab and never reload it.
${NO_JS}

${stateRules("Leave the TodoMVC tab open when you're done.", '{"winner": "", "average_rating": {"Young Adult": 0, "Fiction": 0, "Fantasy": 0}}')}`,
    inspect: [{ name: "app", url: "todomvc\\.com/examples/react", js: TODO_JS }],
    // Young Adult 178/54 = 3.296, Fiction 207/65 = 3.185, Fantasy 148/48 = 3.083.
    // Page 1 alone: Fiction 3.45, Young Adult 3.05, Fantasy 2.95.
    key: {
      winner: "Young Adult",
      todos: [
        ["An Abundance of Katherines", 10.0, 5],
        ["The Darkest Corners", 11.33, 5],
        ["New Moon (Twilight #2)", 12.86, 4],
        ["Wild Swans", 14.36, 2],
        ["The Epidemic (The Program 0.6)", 14.44, 5],
        ["Scarlet (The Lunar Chronicles #2)", 14.57, 4],
        ["Two Summers", 14.64, 1],
        ["Obsidian (Lux #1)", 14.86, 2],
      ],
    },
    check: noJs(function (a, state) {
      const s = state?.app ?? {};
      const all = s.all ?? [];
      const titles = all.map((x) => x.title);
      const want = this.key.todos.map(([t, p]) => `${t} (£${p.toFixed(2)})`);
      const done = all.filter((x) => x.completed).map((x) => x.title);
      const avg = get(a, "average_rating") ?? {};
      const bare = (t) => norm(t).replace(/ \d+(\.\d+)?$/, "");
      return {
        winner: norm(get(a, "winner")) === "young adult",
        averages: num(3.296, 0.011)(get(avg, "Young Adult")) && num(3.185, 0.011)(get(avg, "Fiction")) && num(3.083, 0.011)(get(avg, "Fantasy")),
        right_books: sameBag(titles.map(bare), this.key.todos.map(([t]) => norm(t))),
        exact_titles_in_order: titles.length === want.length && titles.every((t, i) => t.trim().replace(/[‘’]/g, "'").replace(/\s+/g, " ") === want[i]),
        completed_five_star: titles.length > 0 && sameBag(done.map(bare), this.key.todos.filter((x) => x[2] === 5).map(([t]) => norm(t))),
        active_filter: /^#\/active$/.test(s.hash ?? "") && (s.visible ?? []).length > 0 && s.visible.every((x) => !x.completed),
      };
    }),
  },

  // 4 ---------------------------------------------------------------------------------------
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
    desc: "No JavaScript: a 13-shape tldraw diagram drawn through its UI: six labeled rectangles on a 2x3 grid with equal sizes and aligned rows and columns, row colors, a cycle of six bound arrows with two labels, all inside a named frame; checked from the editor's shapes, props, parents and bindings",
    kind: "state",
    prompt: `On the tldraw canvas at https://examples.tldraw.com/basic/full (an in-memory demo), draw a six-step loop:
- six rectangles whose own labels (text typed into the shape, not separate text shapes) read Plan, Build, Test, Ship, Measure and Learn;
- laid out as a grid of two rows and three columns: Plan, Build, Test left to right in the top row, and Ship, Measure, Learn left to right in the bottom row;
- all six the same width and height (within 5 px), the tops of each row aligned (within 2 px), the left edges of each column aligned (within 2 px), and the two gaps between neighboring rectangles in each row equal (within 2 px);
- the top-row rectangles colored blue and the bottom-row rectangles colored green (use the style panel);
- arrows whose ends are attached (bound) to the rectangles, forming a cycle: Plan → Build, Build → Test, Test → Learn, Learn → Measure, Measure → Ship, Ship → Plan;
- the Test → Learn arrow labeled deploy, and the Ship → Plan arrow labeled next cycle;
- everything above inside one frame named Loop.
Nothing else should be on the canvas. The canvas isn't saved, so work in one tab and never reload it.
${NO_JS}

${stateRules("Leave that tab open on the canvas when you're done.", '{"shapes": 0, "arrows": 0}')}`,
    inspect: [{ name: "canvas", url: "examples\\.tldraw\\.com", js: TLDRAW_JS }],
    check: noJs(function (a, state) {
      const shapes = state?.canvas?.shapes ?? [];
      const geo = shapes.filter((s) => s.type === "geo");
      const arrows = shapes.filter((s) => s.type === "arrow");
      const frames = shapes.filter((s) => s.type === "frame");
      const names = ["plan", "build", "test", "ship", "measure", "learn"];
      const r = Object.fromEntries(names.map((t) => [t, geo.find((s) => norm(s.text) === t)]));
      const rects = names.map((t) => r[t]);
      const all = rects.every(Boolean);
      const top = [r.plan, r.build, r.test];
      const bottom = [r.ship, r.measure, r.learn];
      const spread = (xs) => Math.max(...xs) - Math.min(...xs);
      const arrow = (from, to) => (from && to ? arrows.find((x) => x.start === from.id && x.end === to.id) : null);
      const cycle = [["plan", "build"], ["build", "test"], ["test", "learn"], ["learn", "measure"], ["measure", "ship"], ["ship", "plan"]];
      const frame = frames.length === 1 ? frames[0] : null;
      return {
        six_labeled_rectangles: all && rects.every((s) => s.geo === "rectangle"),
        grid_order: all && top.every((s, i) => i === 0 || s.x > top[i - 1].x) && bottom.every((s, i) => i === 0 || s.x > bottom[i - 1].x) && Math.min(...bottom.map((s) => s.y)) > Math.max(...top.map((s) => s.y + s.h / 2)),
        same_size: all && spread(rects.map((s) => s.w)) <= 5 && spread(rects.map((s) => s.h)) <= 5,
        rows_aligned: all && spread(top.map((s) => s.y)) <= 2 && spread(bottom.map((s) => s.y)) <= 2,
        columns_aligned: all && [0, 1, 2].every((i) => Math.abs(top[i].x - bottom[i].x) <= 2),
        even_gaps: all && [top, bottom].every((row) => Math.abs(row[1].x - (row[0].x + row[0].w) - (row[2].x - (row[1].x + row[1].w))) <= 2),
        // tldraw's style panel has both blue and light-blue (and green and light-green); either
        // counts, as in round 1.
        row_colors: all && top.every((s) => /^(light-)?blue$/.test(s.color)) && bottom.every((s) => /^(light-)?green$/.test(s.color)),
        arrows_bound: cycle.every(([f, t]) => arrow(r[f], r[t])),
        arrow_labels: norm(arrow(r.test, r.learn)?.text) === "deploy" && norm(arrow(r.ship, r.plan)?.text) === "next cycle",
        frame_loop: !!frame && norm(frame.name) === "loop" && [...geo, ...arrows].length > 0 && [...geo, ...arrows].every((s) => s.parent === frame.id),
        nothing_else: shapes.length === 13 && geo.length === 6 && arrows.length === 6 && frames.length === 1,
      };
    }),
  },
];

export const taskById = (id) => TASKS.find((t) => t.id === id);
