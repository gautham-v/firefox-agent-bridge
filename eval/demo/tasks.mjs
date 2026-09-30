// Tasks for race videos only (eval/demo/race.mjs), not part of the benchmark: everyday errands a
// person would give an agent, on live sites whose answers change, so the checker only asks for a
// complete, plausible answer. The benchmark's own tasks (eval/tasks.mjs) can be raced too.
//
// Prompts name "the Firefox browser tools"; promptFor() in eval/tasks.mjs swaps in "Chrome".

import { checkFields, toNumber } from "../lib/check.mjs";

const RULES = [
  "Use only the Firefox browser tools. Don't sign in, book, buy or post anything, and don't click through to a booking or checkout page.",
  "Close every tab you opened (tabs_close_mcp) before you finish.",
  "End your reply with one line holding only a JSON object in exactly this shape:",
].join("\n");
const prompt = (body, shape) => `${body}\n\n${RULES}\n${shape}`;
const filled = (v) => String(v ?? "").trim().length > 1;

export const DEMO_TASKS = [
  {
    id: "demo-google-flights",
    kind: "demo",
    arms: [],
    prompt: prompt(
      "On Google Flights (https://www.google.com/travel/flights), find the cheapest nonstop round-trip economy flight for 1 adult from San Francisco (SFO) to New York (JFK), leaving Thursday, November 12, 2026 and returning Monday, November 16, 2026. Fill in the search form on the page and use its Stops filter. Report the airline, the outbound departure time and the round-trip price shown for the cheapest nonstop option.",
      '{"airline": "", "outbound_departure": "", "round_trip_price_usd": 0}',
    ),
    check: (a) =>
      checkFields(a, {
        airline: filled,
        outbound_departure: (v) => /\d{1,2}:\d{2}\s*(am|pm)?/i.test(String(v ?? "")),
        round_trip_price_usd: (v) => toNumber(v) > 50 && toNumber(v) < 5000,
      }),
  },
  {
    id: "demo-excalidraw-flow",
    kind: "demo",
    arms: [],
    prompt: prompt(
      `Open this empty Excalidraw whiteboard: {EXCALIDRAW_ROOM} (a fresh collaboration room; if it asks for a name, dismiss it). Using the toolbar and the mouse, draw a small flowchart:
- four rectangles in one row, left to right, labeled Plan, Build, Test and Ship (double-click a rectangle to type its label);
- an arrow from each rectangle to the next (Plan → Build → Test → Ship), with both ends attached to the rectangles;
- the text "measure twice" under Test.
Don't use keyboard shortcuts to pick tools, and don't use javascript_tool.`,
      '{"rectangles": 0, "arrows": 0, "text_under_test": ""}',
    ),
    check: (a) =>
      checkFields(a, {
        rectangles: (v) => toNumber(v) === 4,
        arrows: (v) => toNumber(v) === 3,
        text_under_test: (v) => /measure twice/i.test(String(v ?? "")),
      }),
  },
];

export const demoTaskById = (id) => DEMO_TASKS.find((t) => t.id === id);
