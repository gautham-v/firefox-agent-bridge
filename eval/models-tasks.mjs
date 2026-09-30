// Complex tasks for the model x effort benchmark (models.mjs). Each is 10+ steps on public
// practice or read-only sites, with no logins and nothing real submitted. Every task scores
// partial credit: check() returns named sub-goals, score = the share that passed, pass = all.
//
// Answer tasks are checked from the JSON the agent ends with. State tasks tell the agent to leave
// its tab(s) open; after the run the harness joins the run's tab-group session over MCP, runs
// each `inspect` snippet in the newest tab whose URL matches, and hands the results to check()
// as `state` (then closes the tabs). Keys were checked by hand in Firefox on 2026-09-29.

import { norm, num, toNumber } from "./lib/check.mjs";

export const answerRules = (shape) =>
  [
    "Use only the Firefox browser tools. Don't sign in, and don't submit, buy or post anything unless the task says to.",
    "Close every tab you opened (tabs_close_mcp) before you finish.",
    "End your reply with one line holding only a JSON object in exactly this shape:",
    shape,
  ].join("\n");

export const stateRules = (keep, shape) =>
  [
    "Use only the Firefox browser tools. Don't sign in, and don't submit, buy or post anything unless the task says to.",
    `${keep} The result is checked in the page after you finish, so don't close ${/tabs/.test(keep) ? "those tabs" : "that tab"} or reload ${/tabs/.test(keep) ? "them" : "it"}; close any other tabs you opened.`,
    "End your reply with one line holding only a JSON object in exactly this shape:",
    shape,
  ].join("\n");

export const get = (obj, key) => {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in obj) return obj[key];
  const k = Object.keys(obj).find((x) => norm(x) === norm(key));
  return k === undefined ? undefined : obj[k];
};
export const safe = (fn) => {
  try {
    return !!fn();
  } catch {
    return false;
  }
};
export const words = (s, n) => norm(s).replace(/\./g, "").split(" ").filter(Boolean).slice(0, n).join(" ");
export const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => norm(x) === norm(b[i]));
export const sameBag = (a, b) => Array.isArray(a) && sameList([...a].map(norm).sort(), [...b].map(norm).sort());

// Finds the tldraw Editor instance through React's fiber tree (the example doesn't expose it).
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
  const shapes = ed.getCurrentPageShapes().map((s) => {
    const b = ed.getShapePageBounds(s);
    const out = { id: s.id, type: s.type, geo: s.props.geo ?? null, color: s.props.color ?? null, x: b?.x, y: b?.y, w: b?.w, h: b?.h };
    if (s.type === "arrow") {
      const bs = ed.getBindingsFromShape(s, "arrow");
      out.start = bs.find((x) => x.props.terminal === "start")?.toId ?? null;
      out.end = bs.find((x) => x.props.terminal === "end")?.toId ?? null;
    }
    return out;
  });
  return JSON.stringify({ shapes });
})()`;

export const TASKS = [
  // 1 ---------------------------------------------------------------------------------------
  {
    id: "research-synth",
    desc: "Four facts from three practice sites (quotes, books, countries/hockey), combined into one computed number",
    kind: "answer",
    prompt: `Answer this four-part scavenger hunt on public practice sites, then combine the numbers.
a) On https://quotes.toscrape.com, how many quotes are tagged "inspirational"? Count across all pages of that tag.
b) On https://books.toscrape.com, what is the average price in GBP of all the books in the Poetry category?
c) On https://www.scrapethissite.com/pages/simple/ (Countries of the World), what is the population density, in people per km², of the country whose capital is Reykjavik? Use population ÷ area as listed on that page.
d) On https://www.scrapethissite.com/pages/forms/ (Hockey Teams), in which year did the Boston Bruins have the most wins, and how many wins was that?
Then compute final = a × b + (wins from d) × c, rounded to 2 decimals.

${answerRules('{"inspirational_quotes": 0, "poetry_avg_price_gbp": 0, "iceland_density_per_km2": 0, "bruins_best_year": 0, "bruins_best_wins": 0, "final": 0}')}`,
    key: { inspirational_quotes: 13, poetry_avg_price_gbp: 35.97, iceland_density_per_km2: 3.0, bruins_best_year: 2008, bruins_best_wins: 53, final: 626.62 },
    check(a) {
      return {
        inspirational_quotes: num(13)(get(a, "inspirational_quotes")),
        poetry_avg_price_gbp: num(35.974, 0.011)(get(a, "poetry_avg_price_gbp")),
        iceland_density: num(2.9991, 0.011)(get(a, "iceland_density_per_km2")),
        bruins_best: num(2008)(get(a, "bruins_best_year")) && num(53)(get(a, "bruins_best_wins")),
        // 13 × 35.9742 + 53 × 2.99913 = 626.618; ±0.5 allows rounding the parts first.
        final: num(626.62, 0.5)(get(a, "final")),
      };
    },
  },

  // 2 ---------------------------------------------------------------------------------------
  {
    id: "form-demoqa",
    desc: "Long practice form: see which fields the empty form flags, then fill text, radio, date picker, autocomplete, checkboxes, dependent dropdowns and submit",
    kind: "state",
    prompt: `Use the student registration practice form at https://demoqa.com/automation-practice-form (a public test site).
First, click Submit on the empty form and note which fields it flags as invalid.
Then fill it in for this student and submit it:
- Name: Priya Shah
- Email: priya.shah@example.org
- Gender: Other
- Mobile: (628) 555-0194
- Date of birth: 7 November 1988 (use the date picker)
- Subjects: Maths, Physics and English
- Hobbies: Sports and Music
- Current address: 42 Harbour Road, Apt 5
- State and City: Haryana, Panipat
Leave out the picture. If the form rejects a value, fix it and submit again.

${stateRules("Leave the tab open on the confirmation dialog that appears after submitting (don't close the dialog).", '{"flagged_on_empty_submit": [""], "submitted": true}')}`,
    inspect: [
      {
        name: "form",
        url: "demoqa\\.com/automation-practice-form",
        js: String.raw`(() => {
  const m = document.querySelector(".modal-content");
  const rows = m ? Object.fromEntries([...m.querySelectorAll("tbody tr")].map((tr) => [tr.cells[0]?.textContent.trim(), tr.cells[1]?.textContent.trim()])) : null;
  const v = (sel) => document.querySelector(sel)?.value ?? null;
  const t = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.trim());
  const form = {
    name: [v("#firstName"), v("#lastName")].join(" "),
    email: v("#userEmail"),
    gender: t("#genterWrapper input:checked + label, [id^=gender-radio]:checked + label")[0] ?? null,
    mobile: v("#userNumber"),
    dob: v("#dateOfBirthInput"),
    subjects: t("#subjectsContainer [class*=multiValue] > div:first-child, #subjectsContainer [class*=multi-value__label]"),
    hobbies: t("[id^=hobbies-checkbox]:checked + label"),
    address: v("#currentAddress"),
    state: t("#state [class*=singleValue], #state [class*=single-value]")[0] ?? null,
    city: t("#city [class*=singleValue], #city [class*=single-value]")[0] ?? null,
  };
  return JSON.stringify({ submitted: !!m, title: m?.querySelector(".modal-title")?.textContent ?? null, rows, form });
})()`,
      },
    ],
    check(a, state) {
      const s = state?.form ?? {};
      const r = s.rows ?? {};
      const f = s.form ?? {};
      // Graded from the confirmation table when the form was submitted, else from the fields.
      const val = (row, field) => (s.submitted ? r[row] : field);
      const split = (x) => (Array.isArray(x) ? x : String(x ?? "").split(",")).map((y) => y.trim()).filter(Boolean);
      const flagged = get(a, "flagged_on_empty_submit");
      const want = [/first/, /last/, /gender/, /mobile|phone/];
      return {
        flagged_fields: safe(
          () => Array.isArray(flagged) && want.every((re) => flagged.some((x) => re.test(norm(x)))) && flagged.every((x) => want.some((re) => re.test(norm(x))) || /^name$/.test(norm(x))),
        ),
        submitted: !!s.submitted && /thanks for submitting/i.test(s.title ?? ""),
        name: norm(val("Student Name", f.name)) === "priya shah",
        email: norm(val("Student Email", f.email)) === norm("priya.shah@example.org"),
        gender: norm(val("Gender", f.gender)) === "other",
        mobile: String(val("Mobile", f.mobile) ?? "") === "6285550194",
        dob: /^0?7 nov(ember)?\s*,?\s*1988$/i.test(String(val("Date of Birth", f.dob) ?? "").trim()),
        subjects: sameBag(split(val("Subjects", f.subjects)), ["Maths", "Physics", "English"]),
        hobbies: sameBag(split(val("Hobbies", f.hobbies)), ["Sports", "Music"]),
        address: norm(val("Address", f.address)) === norm("42 Harbour Road, Apt 5"),
        state_city: norm(val("State and City", [f.state, f.city].join(" "))) === "haryana panipat",
      };
    },
  },

  // 3 ---------------------------------------------------------------------------------------
  {
    id: "todomvc-flow",
    desc: "TodoMVC (React): add 7 items, rename one, complete three, delete one, add one, switch to the Active filter; checked in the app's DOM",
    kind: "state",
    prompt: `Use the TodoMVC demo app at https://todomvc.com/examples/react/dist/ to set up a packing list.
1. Add these todos, in this order: Book flights, Renew passport, Buy adapter, Pack bags, Water plants, Cancel newspaper, Charge camera.
2. Rename "Buy adapter" to "Buy travel adapter".
3. Mark "Book flights", "Renew passport" and "Water plants" as completed.
4. Delete "Cancel newspaper".
5. Add "Print boarding pass" at the end.
6. Switch the list to the Active filter.
The app keeps its list only in the page (it doesn't save), so do everything in one tab and never reload it.

${stateRules("Leave that tab open on the app when you're done.", '{"items_left": 0}')}`,
    inspect: [
      {
        name: "app",
        url: "todomvc\\.com/examples/react",
        js: String.raw`(async () => {
  const hash = location.hash;
  const left = document.querySelector(".todo-count")?.textContent ?? null;
  const read = () => [...document.querySelectorAll(".todo-list li")].map((li) => ({ title: li.querySelector("label")?.textContent ?? li.textContent, completed: li.classList.contains("completed") }));
  const visible = read();
  location.hash = "#/";
  await new Promise((r) => setTimeout(r, 400));
  const all = read();
  location.hash = hash;
  return JSON.stringify({ hash, left, visible, all });
})()`,
      },
    ],
    check(a, state) {
      const s = state?.app ?? {};
      const all = s.all ?? [];
      const titles = all.map((x) => x.title);
      const done = all.filter((x) => x.completed).map((x) => x.title);
      const expected = ["Book flights", "Renew passport", "Buy travel adapter", "Pack bags", "Water plants", "Charge camera", "Print boarding pass"];
      return {
        items_in_order: sameList(titles, expected),
        renamed: titles.some((t) => norm(t) === "buy travel adapter") && !titles.some((t) => norm(t) === "buy adapter"),
        completed_set: sameBag(done, ["Book flights", "Renew passport", "Water plants"]),
        deleted: titles.length > 0 && !titles.some((t) => /newspaper/i.test(t)),
        added_last: norm(titles.at(-1)) === "print boarding pass",
        active_filter: /^#\/active$/.test(s.hash ?? "") && (s.visible ?? []).every((x) => !x.completed),
        items_left_answer: num(4)(get(a, "items_left")),
      };
    },
  },

  // 4 ---------------------------------------------------------------------------------------
  {
    id: "books-paginated",
    desc: "books.toscrape.com: walk every page of two categories; star ratings exist only as CSS classes/icons; counts, sums and extremes",
    kind: "answer",
    prompt: `On https://books.toscrape.com (a practice bookstore), go through every page of the Fantasy category and find: how many books it has; how many have a five-star rating and the total of their prices in GBP; how many have a one-star rating; and the full title of the most expensive Fantasy book. Then, in the Mystery category (also every page), find the full title of the cheapest book.

${answerRules('{"fantasy_total": 0, "fantasy_five_star_count": 0, "fantasy_five_star_total_gbp": 0, "fantasy_one_star_count": 0, "fantasy_most_expensive_title": "", "mystery_cheapest_title": ""}')}`,
    key: {
      fantasy_total: 48,
      fantasy_five_star_count: 10,
      fantasy_five_star_total_gbp: 381.22,
      fantasy_one_star_count: 9,
      fantasy_most_expensive_title: "Myriad (Prentor #1)",
      mystery_cheapest_title: "Tastes Like Fear (DI Marnie Rome #3)",
    },
    check(a) {
      const title = (want) => (v) => norm(v) === norm(want) || (norm(v).length > 6 && norm(want).startsWith(norm(v).replace(/\.\.\.$/, "")));
      return {
        fantasy_total: num(48)(get(a, "fantasy_total")),
        five_star_count: num(10)(get(a, "fantasy_five_star_count")),
        five_star_total: num(381.22, 0.011)(get(a, "fantasy_five_star_total_gbp")),
        one_star_count: num(9)(get(a, "fantasy_one_star_count")),
        most_expensive: title("Myriad (Prentor #1)")(get(a, "fantasy_most_expensive_title")),
        mystery_cheapest: title("Tastes Like Fear (DI Marnie Rome #3)")(get(a, "mystery_cheapest_title")),
      };
    },
  },

  // 5 ---------------------------------------------------------------------------------------
  {
    id: "tldraw-diagram",
    desc: "tldraw canvas: draw 3 colored rectangles and an ellipse, connect them with 3 bound arrows; checked from the editor's shapes and bindings",
    kind: "state",
    prompt: `On the tldraw canvas at https://examples.tldraw.com/basic/full (an in-memory demo), draw a small flow diagram:
- three rectangles side by side, left to right, colored red, green and blue in that order (set each shape's color with the style panel);
- an ellipse, any color, below the green rectangle;
- arrows whose ends are attached (bound) to the shapes: red → green, green → blue, and green → ellipse.
Nothing else should be on the canvas. The canvas isn't saved, so work in one tab and never reload it.

${stateRules("Leave that tab open on the canvas when you're done.", '{"shapes": 0, "arrows": 0}')}`,
    inspect: [{ name: "canvas", url: "examples\\.tldraw\\.com", js: TLDRAW_JS }],
    check(a, state) {
      const shapes = state?.canvas?.shapes ?? [];
      const rects = shapes.filter((s) => s.type === "geo" && s.geo === "rectangle").sort((p, q) => p.x + p.w / 2 - (q.x + q.w / 2));
      const ellipses = shapes.filter((s) => s.type === "geo" && (s.geo === "ellipse" || s.geo === "oval"));
      const arrows = shapes.filter((s) => s.type === "arrow");
      const [red, green, blue] = rects;
      const ell = ellipses[0];
      const hasArrow = (from, to) => !!from && !!to && arrows.some((x) => x.start === from.id && x.end === to.id);
      return {
        three_rectangles: rects.length === 3,
        colors_left_to_right: rects.length === 3 && red.color === "red" && /^(light-)?green$/.test(green.color) && /^(light-)?blue$/.test(blue.color),
        ellipse_below_green: ellipses.length === 1 && !!green && ell.y + ell.h / 2 > green.y + green.h && ell.x < green.x + green.w + green.w / 2 && ell.x + ell.w > green.x - green.w / 2,
        arrow_red_green: hasArrow(red, green),
        arrow_green_blue: hasArrow(green, blue),
        arrow_green_ellipse: hasArrow(green, ell),
        nothing_else: shapes.length === 7 && arrows.length === 3,
      };
    },
  },

  // 6 ---------------------------------------------------------------------------------------
  {
    id: "internet-gauntlet",
    desc: "Tricky pages: dynamic controls, delayed render, infinite scroll, a number drawn on a canvas, a form inside an iframe, and a shadow-root slot",
    kind: "state",
    prompt: `Work through these practice pages. Use a separate tab for each of steps 1-5.
1. https://the-internet.herokuapp.com/dynamic_controls: remove the checkbox with the Remove button, then enable the text field with the Enable button and type exactly: ready for review
2. https://the-internet.herokuapp.com/dynamic_loading/2: click Start and wait for the text that loads.
3. https://the-internet.herokuapp.com/infinite_scroll: keep scrolling until at least 10 paragraphs have loaded, and note the first four words of the 10th paragraph.
4. https://the-internet.herokuapp.com/challenging_dom: read the number after "Answer:" that is drawn in the canvas. Don't click anything on this page (its buttons reload it with a new number).
5. https://www.w3schools.com/html/tryit.asp?filename=tryhtml_form_submit: in the result frame on the right, change First name to Ada and Last name to Lovelace. Don't click Submit or Run.
6. https://the-internet.herokuapp.com/shadowdom: what is the fallback text of the slot inside the custom element's shadow root (the text shown when nothing is slotted in)? You may close this tab.

${stateRules("Leave the tabs from steps 1-5 open when you're done.", '{"loaded_text": "", "paragraph_10_first_four_words": "", "canvas_answer": 0, "shadow_slot_default_text": ""}')}`,
    inspect: [
      {
        name: "controls",
        url: "the-internet\\.herokuapp\\.com/dynamic_controls",
        js: `JSON.stringify({ checkbox: !!document.querySelector("#checkbox, #checkbox-example input[type=checkbox]"), input_enabled: !document.querySelector("#input-example input[type=text]")?.disabled, value: document.querySelector("#input-example input[type=text]")?.value ?? null })`,
      },
      {
        name: "loading",
        url: "the-internet\\.herokuapp\\.com/dynamic_loading/2",
        js: `JSON.stringify({ finish: document.querySelector("#finish")?.textContent.trim() ?? null })`,
      },
      {
        name: "scroll",
        url: "the-internet\\.herokuapp\\.com/infinite_scroll",
        js: `JSON.stringify({ paragraphs: [...document.querySelectorAll(".jscroll-added")].map((p) => p.textContent.trim().slice(0, 120)) })`,
      },
      {
        name: "canvas",
        url: "the-internet\\.herokuapp\\.com/challenging_dom",
        js: `JSON.stringify({ answer: ([...document.scripts].map((s) => s.textContent).join("\\n").match(/Answer: (\\d+)/) ?? [])[1] ?? null })`,
      },
      {
        name: "iframe",
        url: "w3schools\\.com/html/tryit\\.asp",
        js: `(() => { const d = document.querySelector("#iframeResult")?.contentDocument; return JSON.stringify({ fname: d?.querySelector("#fname")?.value ?? null, lname: d?.querySelector("#lname")?.value ?? null }); })()`,
      },
    ],
    check(a, state) {
      const st = state ?? {};
      const paras = st.scroll?.paragraphs ?? [];
      return {
        controls_checkbox_removed: st.controls?.checkbox === false,
        controls_text_typed: st.controls?.input_enabled === true && norm(st.controls?.value) === "ready for review",
        loading_rendered: /hello world/i.test(st.loading?.finish ?? ""),
        loading_text_answer: /^hello world!?$/i.test(String(get(a, "loaded_text") ?? "").trim()),
        scrolled_10: paras.length >= 10,
        paragraph_10_words: paras.length >= 10 && words(get(a, "paragraph_10_first_four_words"), 4) === words(paras[9], 4),
        canvas_answer: st.canvas?.answer != null && toNumber(get(a, "canvas_answer")) === Number(st.canvas.answer),
        iframe_form: st.iframe?.fname === "Ada" && st.iframe?.lname === "Lovelace",
        shadow_slot_default: norm(get(a, "shadow_slot_default_text")) === "my default text",
      };
    },
  },
];

export const taskById = (id) => TASKS.find((t) => t.id === id);

// Partial credit: the share of sub-goals met.
export function score(fields) {
  const v = Object.values(fields);
  const s = v.length ? v.filter(Boolean).length / v.length : 0;
  return { score: Math.round(s * 1000) / 1000, pass: v.length > 0 && v.every(Boolean) };
}
