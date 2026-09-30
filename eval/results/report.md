# Eval report

Generated 2026-09-30T08:59:39.423Z from `results/runs.jsonl` (48 runs).

Tokens are summed over every model in a run (sub-agents included). "Input tokens (incl. cache)" is input + cache writes + cache reads. Spread is [min–max]. Tool result chars is the text the tools returned into the context.

## Matrix

| task | kind | arm | runs | pass | errors |
| --- | --- | --- | --- | --- | --- |
| art-ars-dragon | article | baseline | 3/3 | 3 |  |
| art-ars-dragon | article | strip | 3/3 | 3 |  |
| art-ars-firefox | article | baseline | 3/3 | 3 |  |
| art-ars-firefox | article | strip | 3/3 | 3 |  |
| art-guardian-tang | article | baseline | 3/3 | 3 |  |
| art-guardian-tang | article | strip | 3/3 | 3 |  |
| data-hn-readability | list | baseline | 3/3 | 3 |  |
| data-hn-readability | list | data | 3/3 | 2 |  |
| data-crates-html | list | baseline | 3/3 | 3 |  |
| data-crates-html | list | data | 3/3 | 3 |  |
| data-ashby-ramp | list | baseline | 3/3 | 3 |  |
| data-ashby-ramp | list | data | 3/3 | 3 |  |
| cmp-pypi | compare | baseline | 3/3 | 3 |  |
| cmp-pypi | compare | fanout | 3/3 | 3 |  |
| cmp-npm | compare | baseline | 3/3 | 3 |  |
| cmp-npm | compare | fanout | 3/3 | 3 |  |

## strip vs baseline

Tasks: art-ars-dragon, art-ars-firefox, art-guardian-tang

| metric | baseline | strip | strip / baseline (medians) |
| --- | --- | --- | --- |
| runs | 9 | 9 | |
| success | 100% (9/9) | 100% (9/9) | |
| wall time (s) | 10.7 [8.8–11.4] | 11.6 [10.5–14.8] | 1.09 |
| tool calls | 4 [4–4] | 4 [4–4] | 1.00 |
| screenshots | 0 [0–0] | 0 [0–0] | – |
| turns | 5 [5–5] | 5 [5–5] | 1.00 |
| input tokens (incl. cache) | 54k [47k–58k] | 58k [52k–62k] | 1.08 |
| uncached input tokens | 12k [8.4k–14k] | 12k [9.3k–14k] | 1.07 |
| output tokens | 525 [507–620] | 1.2k [1.1k–1.2k] | 2.20 |
| tool result chars | 26k [14k–30k] | 24k [12k–28k] | 0.94 |
| cost (USD) | 0.060 [0.047–0.070] | 0.070 [0.057–0.079] | 1.17 |

Per task (median [min–max]; success):

| task | arm | runs | success | wall s | tool calls | input tok | output tok | tool result chars |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| art-ars-dragon | baseline | 3 | 100% (3/3) | 10.9 [10.4–11.1] | 4 [4–4] | 47k [47k–47k] | 584 [565–608] | 14k [14k–14k] |
| art-ars-dragon | strip | 3 | 100% (3/3) | 14.0 [10.9–14.0] | 4 [4–4] | 52k [52k–52k] | 1.2k [1.2k–1.2k] | 12k [12k–12k] |
| art-ars-firefox | baseline | 3 | 100% (3/3) | 10.7 [8.8–11.4] | 4 [4–4] | 54k [54k–54k] | 508 [507–525] | 26k [26k–26k] |
| art-ars-firefox | strip | 3 | 100% (3/3) | 10.7 [10.5–14.8] | 4 [4–4] | 58k [58k–58k] | 1.2k [1.1k–1.2k] | 24k [24k–24k] |
| art-guardian-tang | baseline | 3 | 100% (3/3) | 10.5 [9.7–11.1] | 4 [4–4] | 58k [58k–58k] | 525 [524–620] | 30k [30k–30k] |
| art-guardian-tang | strip | 3 | 100% (3/3) | 11.6 [10.7–13.5] | 4 [4–4] | 62k [62k–62k] | 1.1k [1.1k–1.1k] | 28k [28k–28k] |

Tool calls by tool, baseline: tabs_context_mcp 9, navigate 9, get_page_text 9, tabs_close_mcp 9

Tool calls by tool, strip: tabs_context_mcp 9, navigate 9, javascript_tool 9, tabs_close_mcp 9

## data vs baseline

Tasks: data-hn-readability, data-crates-html, data-ashby-ramp

| metric | baseline | data | data / baseline (medians) |
| --- | --- | --- | --- |
| runs | 9 | 9 | |
| success | 100% (9/9) | 89% (8/9) | |
| wall time (s) | 15.3 [10.3–63.7] | 16.7 [10.0–25.6] | 1.09 |
| tool calls | 6 [3–12] | 5 [4–10] | 0.83 |
| screenshots | 0 [0–0] | 0 [0–1] | – |
| turns | 7 [4–13] | 6 [5–11] | 0.86 |
| input tokens (incl. cache) | 58k [39k–199k] | 68k [40k–105k] | 1.19 |
| uncached input tokens | 9.4k [6.0k–23k] | 9.3k [4.6k–16k] | 0.99 |
| output tokens | 901 [740–4.0k] | 1.6k [787–2.6k] | 1.75 |
| tool result chars | 11k [5.1k–37k] | 7.6k [1.8k–23k] | 0.67 |
| cost (USD) | 0.068 [0.040–0.166] | 0.075 [0.034–0.105] | 1.10 |

Per task (median [min–max]; success):

| task | arm | runs | success | wall s | tool calls | input tok | output tok | tool result chars |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| data-hn-readability | baseline | 3 | 100% (3/3) | 20.1 [17.8–63.7] | 7 [6–12] | 78k [58k–199k] | 1.9k [1.3k–4.0k] | 11k [11k–37k] |
| data-hn-readability | data | 3 | 67% (2/3) | 20.9 [16.7–25.6] | 7 [5–10] | 90k [55k–100k] | 1.7k [1.6k–2.6k] | 12k [7.6k–23k] |
| data-crates-html | baseline | 3 | 100% (3/3) | 15.3 [12.5–19.3] | 6 [6–6] | 51k [51k–51k] | 859 [740–952] | 5.1k [5.1k–5.1k] |
| data-crates-html | data | 3 | 100% (3/3) | 11.3 [10.0–11.5] | 5 [4–5] | 40k [40k–49k] | 861 [787–881] | 1.9k [1.8k–2.0k] |
| data-ashby-ramp | baseline | 3 | 100% (3/3) | 10.4 [10.3–11.6] | 4 [3–4] | 58k [39k–58k] | 877 [833–901] | 23k [23k–23k] |
| data-ashby-ramp | data | 3 | 100% (3/3) | 22.4 [14.3–22.6] | 8 [5–8] | 92k [68k–105k] | 2.3k [1.2k–2.6k] | 10k [7.2k–23k] |

Tool calls by tool, baseline: navigate 17, get_page_text 13, tabs_context_mcp 9, tabs_close_mcp 8, javascript_tool 7

Tool calls by tool, data: javascript_tool 21, navigate 11, tabs_close_mcp 9, tabs_context_mcp 8, get_page_text 4, screenshot 2, computer 1, tabs_create_mcp 1

## fanout vs baseline

Tasks: cmp-pypi, cmp-npm

| metric | baseline | fanout | fanout / baseline (medians) |
| --- | --- | --- | --- |
| runs | 6 | 6 | |
| success | 100% (6/6) | 100% (6/6) | |
| wall time (s) | 28.3 [25.8–46.8] | 19.4 [17.8–26.6] | 0.69 |
| tool calls | 14 [12–15] | 31 [27–37] | 2.30 |
| screenshots | 0 [0–0] | 0 [0–1] | – |
| turns | 15 [13–16] | 1 [1–2] | 0.07 |
| input tokens (incl. cache) | 107k [97k–152k] | 326k [276k–365k] | 3.03 |
| uncached input tokens | 7.0k [5.5k–8.0k] | 31k [27k–36k] | 4.50 |
| output tokens | 2.2k [2.0k–2.5k] | 3.8k [3.5k–5.1k] | 1.73 |
| tool result chars | 3.9k [697–6.0k] | 31k [21k–34k] | 7.93 |
| cost (USD) | 0.068 [0.064–0.086] | 0.188 [0.164–0.205] | 2.75 |

Per task (median [min–max]; success):

| task | arm | runs | success | wall s | tool calls | input tok | output tok | tool result chars |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cmp-pypi | baseline | 3 | 100% (3/3) | 27.8 [25.8–28.8] | 14 [13–14] | 103k [97k–110k] | 2.2k [2.1k–2.3k] | 1.1k [697–2.0k] |
| cmp-pypi | fanout | 3 | 100% (3/3) | 22.9 [20.2–26.6] | 34 [27–37] | 347k [276k–365k] | 4.0k [3.5k–5.1k] | 23k [21k–29k] |
| cmp-npm | baseline | 3 | 100% (3/3) | 31.6 [26.3–46.8] | 13 [12–15] | 126k [105k–152k] | 2.0k [2.0k–2.5k] | 5.9k [5.9k–6.0k] |
| cmp-npm | fanout | 3 | 100% (3/3) | 18.7 [17.8–18.7] | 30 [30–32] | 318k [309k–334k] | 3.6k [3.5k–4.0k] | 34k [33k–34k] |

Tool calls by tool, baseline: javascript_tool 35, navigate 31, tabs_context_mcp 6, tabs_close_mcp 6, get_page_text 3

Tool calls by tool, fanout: Agent 30, tabs_create_mcp 30, navigate 30, tabs_close_mcp 30, tabs_context_mcp 26, get_page_text 26, javascript_tool 16, find 1, computer 1

Sub-agent tool calls per run: 26 [22–32]

## Baseline, all tasks

| task | runs | success | wall s | tool calls | screenshots | input tok | output tok |
| --- | --- | --- | --- | --- | --- | --- | --- |
| art-ars-dragon | 3 | 100% (3/3) | 10.9 [10.4–11.1] | 4 [4–4] | 0 [0–0] | 47k [47k–47k] | 584 [565–608] |
| art-ars-firefox | 3 | 100% (3/3) | 10.7 [8.8–11.4] | 4 [4–4] | 0 [0–0] | 54k [54k–54k] | 508 [507–525] |
| art-guardian-tang | 3 | 100% (3/3) | 10.5 [9.7–11.1] | 4 [4–4] | 0 [0–0] | 58k [58k–58k] | 525 [524–620] |
| data-hn-readability | 3 | 100% (3/3) | 20.1 [17.8–63.7] | 7 [6–12] | 0 [0–0] | 78k [58k–199k] | 1.9k [1.3k–4.0k] |
| data-crates-html | 3 | 100% (3/3) | 15.3 [12.5–19.3] | 6 [6–6] | 0 [0–0] | 51k [51k–51k] | 859 [740–952] |
| data-ashby-ramp | 3 | 100% (3/3) | 10.4 [10.3–11.6] | 4 [3–4] | 0 [0–0] | 58k [39k–58k] | 877 [833–901] |
| cmp-pypi | 3 | 100% (3/3) | 27.8 [25.8–28.8] | 14 [13–14] | 0 [0–0] | 103k [97k–110k] | 2.2k [2.1k–2.3k] |
| cmp-npm | 3 | 100% (3/3) | 31.6 [26.3–46.8] | 13 [12–15] | 0 [0–0] | 126k [105k–152k] | 2.0k [2.0k–2.5k] |

## Failed runs

| task | arm | run | failed fields | errors |
| --- | --- | --- | --- | --- |
| data-hn-readability | data | 3 | stories_with_at_least_50_points, github_titles |  |

## Strip probe (get_page_text vs reader view)

22 URLs measured, 0 errors. Tokens = chars / 4. Reader = Readability.js (the library behind Firefox Reader View) injected into the page; arm = the snippet the strip arm's agents run (Readability via import, DOM fallback under strict CSP). Paragraph recall = share of the page's visible paragraphs of 120+ chars (inside article/main when present) whose first 100 chars appear in the text; number recall = share of multi-digit numbers from those paragraphs that appear.

| | page_text | reader | arm |
| --- | --- | --- | --- |
| tokens, median [min–max] | 2.2k [305–31k] | 1.1k [0–15k] | 1.1k [0–15k] |
| tokens / page_text, median [min–max] | 1 | 0.64 [0.00–0.95] | 0.67 [0.00–0.98] |
| URLs at ≤ 0.67 of page_text tokens | | 55% (12/22) | 50% (11/22) |
| paragraph recall, median [min–max] | 1.00 [0.91–1.00] | 0.99 [0.00–1.00] | 1.00 [0.00–1.00] |
| URLs with paragraph recall < 0.9 | 1 | 7 | 6 |
| number recall, median [min–max] | 1.00 [1.00–1.00] | 1.00 [0.00–1.00] | 1.00 [0.00–1.00] |
| answer-key facts found | 100% (14/14) | 100% (14/14) | 100% (14/14) |
| arm used Readability / fallback / error | | | 19 / 2 / 1 |

| URL | page_text tok | reader tok | ratio | reader para | reader num | arm via | arm tok | arm para | consent words |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arstechnica.com/space/2026/09/nasa-has-a-dragon-dilemma-and- | 3.4k | 3.0k | 0.88 | 1.00 | 1.00 | readability | 3.0k | 1.00 |  |
| arstechnica.com/gadgets/2026/09/mozillas-head-of-firefox-tal | 6.4k | 6.0k | 0.93 | 1.00 | 1.00 | readability | 6.0k | 1.00 |  |
| theguardian.com/news/2026/sep/29/why-am-i-obsessed-with-chin | 7.4k | 6.8k | 0.92 | 0.99 | 1.00 | readability | 6.8k | 0.99 |  |
| arstechnica.com/cars/2026/09/connected-car-data-privacy-is-s | 1.7k | 1.2k | 0.71 | 1.00 | 1.00 | readability | 1.2k | 1.00 | yes |
| bbc.com/news/articles/cqn8m342rgk9o | 1.2k | 301 | 0.26 | 0.33 | 0.67 | readability | 301 | 0.33 | yes |
| apnews.com/article/hurricane-polo-landfall-mexico-baja-calif | 2.9k | 1.6k | 0.54 | 0.72 | 0.80 | readability | 1.6k | 0.72 |  |
| npr.org/2026/09/28/nx-s1-5982739/what-to-know-about-the-810- | 1.4k | 891 | 0.64 | 0.92 | 1.00 | readability | 891 | 0.92 | yes |
| theverge.com/tech/1001797/nothings-headphone-1-pro-review | 1.0k | 402 | 0.40 | 1.00 | 1.00 | readability | 402 | 1.00 | yes |
| techcrunch.com/2026/09/29/tesla-secures-30b-in-new-credit-li | 992 | 244 | 0.25 | 1.00 | 1.00 | readability | 244 | 1.00 |  |
| wired.com/story/anthropic-says-it-discovered-a-crispr-like-s | 3.3k | 935 | 0.28 | 0.50 | 0.44 | readability | 935 | 0.50 |  |
| quantamagazine.org/mathematicians-harness-randomness-to-crac | 3.8k | 3.1k | 0.81 | 0.94 | 1.00 | readability | 3.1k | 0.94 |  |
| smithsonianmag.com/history/some-earliest-automobile-enthusia | 10k | 9.7k | 0.95 | 0.96 | 1.00 | readability | 9.7k | 0.96 |  |
| stackoverflow.blog/2026/09/29/your-phone-is-ai-s-newest-hard | 502 | 85 | 0.17 | 0.67 | – | readability | 85 | 0.67 | yes |
| cnn.com/2026/09/29/economy/trump-just-banned-canadian-booze- | 3.0k | 2.0k | 0.65 | 1.00 | 1.00 | readability | 2.0k | 1.00 |  |
| simonwillison.net/2026/Sep/29/anthropic-frontier-red-team/ | 305 | 130 | 0.43 | 1.00 | 1.00 | readability | 130 | 1.00 |  |
| nature.com/articles/d41586-026-03043-w | 2.1k | 992 | 0.47 | 0.92 | 1.00 | readability | 992 | 0.92 |  |
| hacks.mozilla.org/2026/08/intent-to-ship-jpeg-xl/ | 946 | 776 | 0.82 | 1.00 | 1.00 | readability | 776 | 1.00 |  |
| aljazeera.com/news/2025/11/11/how-many-times-has-israel-viol | 2.1k | 1.5k | 0.72 | 1.00 | 1.00 | readability | 1.5k | 1.00 | yes |
| en.wikipedia.org/wiki/Firefox | 31k | 0 | 0.00 | 0.00 | 0.00 | error | 0 | 0.00 |  |
| developer.mozilla.org/en-US/docs/Web/API/Fetch_API | 951 | 600 | 0.63 | 0.86 | – | fallback | 662 | 1.00 |  |
| github.com/mozilla/readability | 2.3k | 1.6k | 0.71 | 1.00 | – | fallback | 2.3k | 1.00 |  |
| paulgraham.com/greatwork.html | 17k | 15k | 0.88 | – | – | readability | 15k | – |  |

## Accessibility probe (JS inventory vs read_page)

23 pages measured, 0 errors. Inventory = visible links, buttons, inputs, selects, textareas, role=<interactive>, contenteditable, tabindex≥0 and onclick elements in the top document, open shadow roots and same-origin frames (closed shadow roots are invisible to page script; read_page sees them). Cross-origin frames are counted with their size; the larger visible ones (≤4 per page) were opened on their own URL and inventoried, as an estimate of what's inside. read_page = filter "interactive". Empty name = entry without a quoted name; bare tag = entry shown as a tag (div, span...) because it has onclick/tabindex/contenteditable but no role. Heuristic name (inventory) = name only from title/placeholder or from text of an element whose role doesn't take its name from content.

| | total over pages |
| --- | --- |
| inventory elements (top document) | 4880 |
| inventory elements in same-origin frames | 2 |
| read_page entries | 5015 |
| read_page entries with empty name | 289 (5.8%) |
| read_page bare-tag entries | 137 |
| inventory names: proper / heuristic / empty | 4703 / 53 / 126 |
| cross-origin frames (visible) | 51 (32) |
| interactive elements inside opened cross-origin frames | 61 |
| pages where read_page hit the default 50k cap | 1 |
| missed estimate (top-doc gap + same-origin frames + inside cross-origin frames) | 91 |

By page type:

| type | pages | inventory | read_page | empty names | xo frames visible | inside xo frames | same-origin frame els | missed est. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| payment | 4 | 201 | 303 | 118 | 2 | 0 | 1 | 2 |
| editor | 6 | 882 | 871 | 59 | 24 | 48 | 0 | 73 |
| video | 2 | 167 | 167 | 4 | 4 | 13 | 0 | 13 |
| login | 3 | 14 | 12 | 0 | 1 | 0 | 1 | 2 |
| plain | 7 | 3593 | 3637 | 106 | 1 | 0 | 0 | 1 |
| app | 1 | 25 | 25 | 2 | 0 | 0 | 0 | 0 |

Output sizes (read_page):

- interactive, uncapped: 1.7k [38–58k] tokens per page
- all (default cap): 3.4k [138–13k] tokens per page

| page | type | inventory (frames) | read_page | empty | bare | xo frames (vis) | xo hosts | inside | read_page int. tok | read_page all tok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stripe-payments-demo.appspot.com/ | payment | 13 (0) | 12 | 0 | 0 | 8 (1) | js.stripe.com | 0 | 215 | 732 |
| developer.squareup.com/reference/sdks/web/payments | payment | 79 (1) | 182 | 112 | 106 | 2 (1) | sandbox.web.squarecdn.com | 0 | 1.7k | 3.4k |
| paypal.com/buttons/ | payment | 13 (0) | 13 | 0 | 0 | 0 (0) |  | 0 | 378 | 543 |
| docs.stripe.com/payments/checkout | payment | 96 (0) | 96 | 6 | 1 | 4 (0) | b.stripecdn.com js.stripe.com | 0 | 1.7k | 3.5k |
| css-tricks.com/snippets/css/a-guide-to-flexbox/ | editor | 135 (0) | 110 | 8 | 0 | 23 (18) | codepen.io css-tricks.com www.youtube.com | 44 | 2.1k | 12k |
| developer.mozilla.org/en-US/docs/Web/HTML/Referenc | editor | 625 (0) | 638 | 37 | 13 | 5 (5) | 219bd006-93b7-4e0f-afda-d81c9587ae7a.mdnplay.dev d63e094ebe677da0b825b31631113bcf46c02aa5.mdnplay.dev b5fb4eb9de42165c128bc2f8461933e2f7ec5e4a.mdnplay.dev | 0 | 12k | 13k |
| jsfiddle.net/ | editor | 39 (0) | 39 | 10 | 0 | 0 (0) |  | 0 | 458 | 816 |
| codepen.io/pen/ | editor | 20 (0) | 20 | 0 | 0 | 1 (1) | cdpn.io | 4 | 193 | 298 |
| typescriptlang.org/play | editor | 54 (0) | 55 | 2 | 1 | 0 (0) |  | 0 | 793 | 1.8k |
| w3schools.com/tryit/tryit.asp?filename=tryhtml_def | editor | 9 (0) | 9 | 2 | 0 | 0 (0) |  | 0 | 119 | 200 |
| developers.google.com/youtube/iframe_api_reference | video | 158 (0) | 158 | 2 | 0 | 4 (3) | www.youtube.com developers.google.com accounts.google.com | 9 | 2.5k | 13k |
| w3schools.com/html/tryit.asp?filename=tryhtml_yout | video | 9 (0) | 9 | 2 | 0 | 1 (1) | www.youtube.com | 4 | 120 | 196 |
| accounts.hcaptcha.com/demo | login | 2 (0) | 1 | 0 | 0 | 2 (1) | newassets.hcaptcha.com | 0 | 38 | 138 |
| google.com/recaptcha/api2/demo | login | 7 (1) | 6 | 0 | 0 | 0 (0) |  | 0 | 101 | 215 |
| demo.turnstile.workers.dev/ | login | 5 (0) | 5 | 0 | 0 | 0 (0) |  | 0 | 98 | 212 |
| news.ycombinator.com/ | plain | 229 (0) | 229 | 32 | 0 | 0 (0) |  | 0 | 3.6k | 6.9k |
| en.wikipedia.org/wiki/Firefox | plain | 2483 (0) | 2524 | 26 | 0 | 0 (0) |  | 0 | 58k | 13k |
| github.com/mozilla/readability | plain | 184 (0) | 184 | 16 | 2 | 0 (0) |  | 0 | 3.5k | 8.3k |
| jobs.ashbyhq.com/ramp | plain | 165 (0) | 165 | 1 | 0 | 0 (0) |  | 0 | 7.7k | 12k |
| theguardian.com/international | plain | 271 (0) | 270 | 4 | 2 | 0 (0) |  | 0 | 9.2k | 13k |
| bbc.com/news | plain | 115 (0) | 119 | 4 | 0 | 1 (1) | edigitalsurvey.com | 0 | 3.1k | 6.1k |
| npmjs.com/package/express | plain | 146 (0) | 146 | 23 | 11 | 0 (0) |  | 0 | 2.1k | 5.0k |
| excalidraw.com/ | app | 25 (0) | 25 | 2 | 1 | 0 (0) |  | 0 | 270 | 380 |

## Browser comparison: Firefox tools vs Claude in Chrome (baseline arm)

Source: `results/browsers.jsonl`. Same tasks, model and prompt (the prompt names "the Firefox browser tools" or "the Chrome browser tools"); Firefox runs get only the mcp__firefox__* tools, Chrome runs only mcp__claude-in-chrome__* (`claude -p --chrome` with an empty strict MCP config). Tools are compared by name without the server prefix. Tasks in the tables: those with runs in both browsers (16).

**Known confounds.** Claude in Chrome's `find` calls a model server-side to match elements; those tokens and that cost don't appear in these counts, so Chrome's token and cost numbers are a lower bound whenever it uses `find` (its time is included in wall time and in `find`'s per-call time). Claude in Chrome also offers tools the Firefox server doesn't have (browser_batch, gif_creator, console/network readers, shortcuts, resize_window, upload_image, browser selection), and its `scroll` returns a screenshot, so compare "images returned" as well as screenshot actions. Chrome needs its window visible for screenshots; Firefox tabs run in the background.

### Overall

| metric | firefox | chrome | chrome / firefox (medians) |
| --- | --- | --- | --- |
| runs | 48 | 48 | |
| success | 100% (48/48) | 98% (47/48) | |
| wall time (s) | 19.1 [7.9–252.1] | 25.5 [10.2–211.0] | 1.34 |
| tool calls | 7 [3–107] | 7 [3–67] | 1.00 |
| screenshot/zoom actions | 0 [0–34] | 0 [0–25] | – |
| images returned to the model | 0 [0–34] | 0 [0–29] | – |
| turns | 8 [4–108] | 8 [4–68] | 1.00 |
| input tokens (incl. cache) | 60k [38k–2507k] | 119k [48k–1146k] | 1.97 |
| uncached input tokens | 8.4k [3.7k–65k] | 11k [5.9k–47k] | 1.30 |
| output tokens | 1.2k [493–19k] | 1.5k [548–11k] | 1.26 |
| tool result KB (text + images) | 13.7 [0.4–1415.0] | 22.0 [1.3–1275.0] | 1.60 |
| cost (USD) | 0.062 [0.028–0.935] | 0.080 [0.041–0.514] | 1.29 |

Median [min–max] per run.

### Per task

| task | browser | runs | success | wall s | tool calls | shots | images | input tok | output tok | tool result KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| art-ars-dragon | firefox | 3 | 100% (3/3) | 12.3 [10.1–13.8] | 4 [4–4] | 0 [0–0] | 0 [0–0] | 48k [40k–48k] | 594 [579–600] | 13.6 [13.6–13.6] |
| art-ars-dragon | chrome | 3 | 100% (3/3) | 12.2 [11.0–13.2] | 4 [4–4] | 0 [0–0] | 0 [0–0] | 72k [72k–72k] | 597 [590–627] | 13.3 [13.3–13.3] |
| art-ars-firefox | firefox | 3 | 100% (3/3) | 12.1 [7.9–12.7] | 4 [4–4] | 0 [0–0] | 0 [0–0] | 54k [46k–54k] | 524 [493–546] | 25.9 [25.9–25.9] |
| art-ars-firefox | chrome | 3 | 100% (3/3) | 12.3 [10.5–13.4] | 4 [3–4] | 0 [0–0] | 0 [0–0] | 79k [55k–79k] | 617 [581–662] | 25.7 [25.6–25.7] |
| art-guardian-tang | firefox | 3 | 100% (3/3) | 10.2 [9.8–15.5] | 4 [3–4] | 0 [0–0] | 0 [0–0] | 58k [40k–58k] | 654 [609–690] | 29.5 [29.5–29.5] |
| art-guardian-tang | chrome | 3 | 100% (3/3) | 12.9 [10.6–13.9] | 4 [4–4] | 0 [0–0] | 0 [0–0] | 83k [83k–83k] | 573 [548–672] | 29.6 [29.6–29.6] |
| data-hn-readability | firefox | 3 | 100% (3/3) | 19.2 [17.1–19.4] | 7 [6–7] | 0 [0–0] | 0 [0–0] | 58k [57k–58k] | 1.2k [1.2k–1.5k] | 11.3 [11.1–11.3] |
| data-hn-readability | chrome | 3 | 100% (3/3) | 36.7 [36.6–99.1] | 11 [10–13] | 0 [0–2] | 0 [0–2] | 203k [195k–210k] | 3.1k [2.6k–3.3k] | 9.4 [8.6–261.5] |
| data-crates-html | firefox | 3 | 100% (3/3) | 16.1 [14.9–16.5] | 6 [6–6] | 0 [0–0] | 0 [0–0] | 59k [51k–60k] | 819 [779–1.0k] | 5.0 [5.0–5.0] |
| data-crates-html | chrome | 3 | 100% (3/3) | 20.5 [19.7–25.9] | 8 [6–8] | 0 [0–0] | 0 [0–0] | 87k [85k–104k] | 1.1k [735–1.2k] | 6.8 [5.9–6.8] |
| data-ashby-ramp | firefox | 3 | 100% (3/3) | 13.0 [12.9–13.3] | 4 [4–4] | 0 [0–0] | 0 [0–0] | 58k [58k–58k] | 848 [831–881] | 23.7 [23.7–23.7] |
| data-ashby-ramp | chrome | 3 | 100% (3/3) | 15.9 [14.9–17.0] | 4 [4–4] | 0 [0–0] | 0 [0–0] | 100k [85k–100k] | 916 [897–964] | 25.2 [25.2–25.2] |
| cmp-pypi | firefox | 3 | 100% (3/3) | 38.7 [35.9–40.3] | 13 [13–14] | 0 [0–0] | 0 [0–0] | 93k [92k–114k] | 2.2k [2.0k–2.2k] | 4.6 [0.8–4.8] |
| cmp-pypi | chrome | 3 | 100% (3/3) | 29.4 [25.6–87.0] | 6 [4–7] | 0 [0–0] | 0 [0–0] | 121k [84k–123k] | 2.4k [1.8k–2.6k] | 2.3 [1.9–4.7] |
| cmp-npm | firefox | 3 | 100% (3/3) | 29.7 [27.3–32.8] | 12 [12–13] | 0 [0–0] | 0 [0–0] | 114k [106k–116k] | 1.8k [1.8k–2.1k] | 5.6 [5.6–5.7] |
| cmp-npm | chrome | 3 | 100% (3/3) | 48.2 [35.9–211.0] | 8 [5–14] | 0 [0–1] | 0 [0–1] | 191k [129k–242k] | 3.1k [2.1k–4.4k] | 25.3 [21.1–38.2] |
| gen-wiki-chain | firefox | 3 | 100% (3/3) | 23.1 [19.3–24.5] | 11 [11–12] | 0 [0–1] | 0 [0–1] | 123k [95k–176k] | 1.4k [1.3k–1.5k] | 27.8 [24.6–80.1] |
| gen-wiki-chain | chrome | 3 | 100% (3/3) | 35.7 [31.8–38.1] | 13 [12–13] | 0 [0–0] | 0 [0–0] | 176k [156k–182k] | 2.3k [2.0k–2.5k] | 5.1 [4.2–7.0] |
| gen-pydocs-search | firefox | 3 | 100% (3/3) | 18.0 [16.9–19.8] | 11 [11–11] | 0 [0–0] | 0 [0–0] | 94k [87k–94k] | 1.1k [1.1k–1.2k] | 13.8 [13.8–13.8] |
| gen-pydocs-search | chrome | 3 | 100% (3/3) | 30.0 [16.4–34.2] | 18 [6–20] | 3 [0–3] | 3 [0–3] | 198k [103k–225k] | 2.0k [722–2.2k] | 103.0 [11.0–112.9] |
| gen-elements-table | firefox | 3 | 100% (3/3) | 12.4 [10.6–13.2] | 4 [4–4] | 0 [0–0] | 0 [0–0] | 41k [41k–43k] | 764 [752–782] | 3.7 [3.1–3.7] |
| gen-elements-table | chrome | 3 | 100% (3/3) | 12.7 [10.2–20.5] | 4 [3–5] | 0 [0–0] | 0 [0–0] | 65k [48k–84k] | 857 [708–1.2k] | 2.1 [2.1–2.6] |
| gen-quotes-scroll | firefox | 3 | 100% (3/3) | 25.6 [24.1–29.3] | 4 [4–5] | 0 [0–0] | 0 [0–0] | 38k [38k–46k] | 673 [673–1.0k] | 0.4 [0.4–0.5] |
| gen-quotes-scroll | chrome | 3 | 100% (3/3) | 55.7 [48.4–122.6] | 8 [5–15] | 0 [0–1] | 1 [0–19] | 135k [81k–347k] | 1.6k [1.2k–5.1k] | 22.9 [1.3–1275.0] |
| gen-httpbin-form | firefox | 3 | 100% (3/3) | 19.0 [17.9–22.3] | 15 [14–15] | 1 [0–1] | 1 [0–1] | 73k [69k–73k] | 1.6k [1.5k–1.7k] | 15.1 [2.0–15.1] |
| gen-httpbin-form | chrome | 3 | 100% (3/3) | 23.1 [20.2–24.0] | 8 [7–8] | 2 [1–2] | 1 [1–1] | 122k [103k–122k] | 1.8k [1.2k–1.8k] | 15.6 [15.5–16.2] |
| gen-mdn-iframe | firefox | 3 | 100% (3/3) | 114.5 [82.3–252.1] | 71 [44–107] | 21 [10–34] | 20 [10–34] | 1315k [782k–2507k] | 12k [7.3k–19k] | 848.1 [506.5–1415.0] |
| gen-mdn-iframe | chrome | 3 | 67% (2/3) | 99.3 [95.1–138.2] | 41 [39–67] | 15 [14–25] | 16 [15–29] | 675k [527k–1146k] | 6.4k [6.3k–11k] | 833.5 [823.9–1123.9] |
| gen-apg-datepicker | firefox | 3 | 100% (3/3) | 23.3 [22.4–31.9] | 15 [15–16] | 2 [2–3] | 2 [2–3] | 81k [76k–89k] | 1.9k [1.8k–1.9k] | 167.1 [166.9–212.9] |
| gen-apg-datepicker | chrome | 3 | 100% (3/3) | 31.2 [26.1–40.8] | 17 [12–17] | 4 [3–4] | 4 [3–4] | 153k [134k–182k] | 2.2k [1.7k–2.4k] | 297.7 [251.7–307.7] |
| gen-datatables-scroll | firefox | 3 | 100% (3/3) | 22.2 [18.6–25.6] | 8 [7–11] | 0 [0–2] | 0 [0–2] | 64k [61k–79k] | 1.3k [1.1k–1.6k] | 5.0 [0.8–180.4] |
| gen-datatables-scroll | chrome | 3 | 100% (3/3) | 25.1 [17.0–25.5] | 7 [6–7] | 1 [0–1] | 1 [0–1] | 116k [98k–132k] | 1.2k [1.0k–1.3k] | 45.9 [1.7–46.7] |

### By tool (all tasks above)

Calls, KB and images are per run (total / runs of that browser); ms is the mean per call, from the tool_use event to its tool_result on the stream.

| tool | ff calls | chrome calls | ff KB | chrome KB | ff images | chrome images | ff ms/call | chrome ms/call | ff errors | chrome errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| computer | 4.5 | 4.1 | 72.7 | 89.0 | 1.6 | 1.8 | 402 | 1411 | 10 | 3 |
| javascript_tool | 1.6 | 1.7 | 0.5 | 0.8 | 0.0 | 0.0 | 710 | 3707 | 8 | 6 |
| navigate | 1.8 | 1.1 | 0.2 | 0.6 | 0.0 | 0.0 | 1904 | 2986 | 0 | 1 |
| tabs_context_mcp | 1.0 | 1.0 | 0.1 | 0.4 | 0.0 | 0.0 | 55 | 1937 | 0 | 0 |
| tabs_close_mcp | 1.0 | 0.9 | 0.0 | 0.1 | 0.0 | 0.0 | 29 | 141 | 0 | 0 |
| get_page_text | 1.0 | 0.7 | 9.1 | 6.8 | 0.0 | 0.0 | 335 | 3661 | 0 | 0 |
| find | 0.7 | 0.3 | 0.8 | 0.1 | 0.0 | 0.0 | 264 | 3135 | 0 | 5 |
| form_input | 0.5 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 12 | – | 0 | – |
| browser_batch | 0.0 | 0.5 | 0.0 | 26.6 | 0.0 | 0.4 | – | 11233 | – | 5 |
| read_page | 0.1 | 0.1 | 1.3 | 0.6 | 0.0 | 0.0 | 457 | 1423 | 0 | 0 |
| screenshot | 0.1 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 308 | – | 4 | – |
| tabs_create_mcp | 0.1 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 38 | – | 0 | – |
| scroll_to | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0 | – | 1 | – |
| read_network_requests | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | – | 400 | – | 0 |

### Tool mix per task

| task | firefox (calls over all runs) | chrome (calls over all runs) |
| --- | --- | --- |
| art-ars-dragon | tabs_context_mcp 3, navigate 3, get_page_text 3, tabs_close_mcp 3 | tabs_context_mcp 3, navigate 3, get_page_text 3, tabs_close_mcp 3 |
| art-ars-firefox | tabs_context_mcp 3, navigate 3, get_page_text 3, tabs_close_mcp 3 | tabs_context_mcp 3, navigate 3, get_page_text 3, tabs_close_mcp 2 |
| art-guardian-tang | tabs_context_mcp 3, navigate 3, get_page_text 3, tabs_close_mcp 2 | tabs_context_mcp 3, navigate 3, get_page_text 3, tabs_close_mcp 3 |
| data-hn-readability | navigate 8, get_page_text 6, tabs_context_mcp 3, tabs_close_mcp 3 | javascript_tool 15, navigate 7, tabs_context_mcp 3, get_page_text 3, tabs_close_mcp 3, computer 2, read_page 1 |
| data-crates-html | navigate 6, get_page_text 6, tabs_context_mcp 3, tabs_close_mcp 3 | get_page_text 7, navigate 6, tabs_context_mcp 3, tabs_close_mcp 3, computer 3 |
| data-ashby-ramp | tabs_context_mcp 3, navigate 3, get_page_text 3, tabs_close_mcp 3 | tabs_context_mcp 3, navigate 3, get_page_text 3, tabs_close_mcp 3 |
| cmp-pypi | javascript_tool 17, navigate 15, tabs_context_mcp 3, tabs_close_mcp 3, get_page_text 2 | browser_batch 6, tabs_context_mcp 3, javascript_tool 3, tabs_close_mcp 3, get_page_text 1, navigate 1 |
| cmp-npm | navigate 15, javascript_tool 13, tabs_context_mcp 3, get_page_text 3, tabs_close_mcp 3 | browser_batch 8, javascript_tool 7, tabs_context_mcp 3, computer 3, navigate 3, tabs_close_mcp 3 |
| gen-wiki-chain | computer 10, find 9, tabs_context_mcp 3, navigate 3, get_page_text 3, tabs_close_mcp 3, javascript_tool 3 | javascript_tool 26, tabs_context_mcp 3, navigate 3, find 3, tabs_close_mcp 3 |
| gen-pydocs-search | computer 12, find 6, get_page_text 6, tabs_context_mcp 3, navigate 3, tabs_close_mcp 3 | computer 23, get_page_text 7, navigate 4, find 4, tabs_context_mcp 3, tabs_close_mcp 3 |
| gen-elements-table | tabs_context_mcp 3, navigate 3, javascript_tool 3, tabs_close_mcp 3 | javascript_tool 4, tabs_context_mcp 3, navigate 3, tabs_close_mcp 2 |
| gen-quotes-scroll | javascript_tool 4, tabs_context_mcp 3, navigate 3, tabs_close_mcp 3 | javascript_tool 10, computer 5, tabs_context_mcp 3, navigate 3, tabs_close_mcp 3, browser_batch 3, read_network_requests 1 |
| gen-httpbin-form | form_input 24, computer 5, tabs_context_mcp 3, navigate 3, read_page 3, get_page_text 3, tabs_close_mcp 3 | browser_batch 5, tabs_context_mcp 3, navigate 3, read_page 3, computer 3, get_page_text 3, tabs_close_mcp 3 |
| gen-mdn-iframe | computer 155, javascript_tool 22, find 15, navigate 7, read_page 4, get_page_text 4, tabs_close_mcp 4, tabs_context_mcp 3, tabs_create_mcp 3, form_input 2, screenshot 2, scroll_to 1 | computer 124, javascript_tool 6, find 5, tabs_context_mcp 4, navigate 3, read_page 3, get_page_text 1, tabs_close_mcp 1 |
| gen-apg-datepicker | computer 30, tabs_context_mcp 3, navigate 3, find 3, javascript_tool 3, tabs_close_mcp 3, screenshot 1 | computer 31, tabs_context_mcp 3, navigate 3, find 3, javascript_tool 3, tabs_close_mcp 2, browser_batch 1 |
| gen-datatables-scroll | javascript_tool 10, computer 4, tabs_context_mcp 3, navigate 3, tabs_close_mcp 3, find 1, get_page_text 1, screenshot 1 | javascript_tool 9, tabs_context_mcp 3, navigate 3, tabs_close_mcp 3, computer 2 |

### Failed runs

| task | browser | run | failed fields | errors | trace |
| --- | --- | --- | --- | --- | --- |
| gen-mdn-iframe | chrome | 3 | displayed_text, option_count |  | results/traces/gen-mdn-iframe.baseline.chrome.3.2026-09-30T03-23-42-164Z.jsonl |

## Re-measure after restart: Firefox before, Firefox after, Chrome (baseline arm)

Sources: Firefox before and Chrome are the rows in `results/browsers.jsonl`; Firefox after is `results/browsers-after.jsonl`, the same 16 tasks, model and prompt, run again once Firefox had loaded main's extension (frames in find/read_page, keys follow the clicked frame, input fallback, click floor, trimmed find, occluded-window fix). The after runs also have everything else that landed on the MCP server since the first run: the batch tool, multi-field form_input, the tabId fill-in and the fetch hint in javascript_tool. Chrome's extension didn't change, so it wasn't run again.

| metric | firefox before | firefox after | chrome | firefox after / firefox before (medians) |
| --- | --- | --- | --- | --- |
| runs | 48 | 48 | 48 | |
| success | 100% (48/48) | 100% (48/48) | 98% (47/48) | |
| wall time (s) | 19.1 [7.9–252.1] | 16.6 [7.6–47.7] | 25.5 [10.2–211.0] | 0.87 |
| tool calls | 7 [3–107] | 6 [3–17] | 7 [3–67] | 0.86 |
| screenshot/zoom actions | 0 [0–34] | 0 [0–3] | 0 [0–25] | – |
| turns | 8 [4–108] | 7 [4–18] | 8 [4–68] | 0.88 |
| input tokens (incl. cache) | 60k [38k–2507k] | 55k [27k–197k] | 119k [48k–1146k] | 0.91 |
| uncached input tokens | 8.4k [3.7k–65k] | 8.5k [3.8k–20k] | 11k [5.9k–47k] | 1.01 |
| output tokens | 1.2k [493–19k] | 1.1k [510–4.0k] | 1.5k [548–11k] | 0.91 |
| tool result KB (text + images) | 13.7 [0.4–1415.0] | 13.6 [0.3–212.6] | 22.0 [1.3–1275.0] | 0.99 |
| cost (USD) | 0.062 [0.028–0.935] | 0.060 [0.030–0.150] | 0.080 [0.041–0.514] | 0.96 |
| total wall time, all runs (min) | 22.3 | 14.3 | 30.9 | |
| total tool calls, all runs | 592 | 351 | 505 | |
| total cost, all runs (USD) | 4.52 | 2.88 | 5.02 | |

Median [min–max] per run.

Per task: median wall s / tool calls / input tokens, and success.

| task | firefox before | firefox after | chrome |
| --- | --- | --- | --- |
| art-ars-dragon | 12.3s / 4 / 48k (3/3) | 10.4s / 4 / 45k (3/3) | 12.2s / 4 / 72k (3/3) |
| art-ars-firefox | 12.1s / 4 / 54k (3/3) | 9.1s / 4 / 51k (3/3) | 12.3s / 4 / 79k (3/3) |
| art-guardian-tang | 10.2s / 4 / 58k (3/3) | 10.9s / 4 / 55k (3/3) | 12.9s / 4 / 83k (3/3) |
| data-hn-readability | 19.2s / 7 / 58k (3/3) | 23.8s / 6 / 111k (3/3) | 36.7s / 11 / 203k (3/3) |
| data-crates-html | 16.1s / 6 / 59k (3/3) | 13.8s / 6 / 49k (3/3) | 20.5s / 8 / 87k (3/3) |
| data-ashby-ramp | 13.0s / 4 / 58k (3/3) | 11.4s / 4 / 55k (3/3) | 15.9s / 4 / 100k (3/3) |
| cmp-pypi | 38.7s / 13 / 93k (3/3) | 26.7s / 5 / 59k (3/3) | 29.4s / 6 / 121k (3/3) |
| cmp-npm | 29.7s / 12 / 114k (3/3) | 23.9s / 6 / 58k (3/3) | 48.2s / 8 / 191k (3/3) |
| gen-wiki-chain | 23.1s / 11 / 123k (3/3) | 20.3s / 13 / 152k (3/3) | 35.7s / 13 / 176k (3/3) |
| gen-pydocs-search | 18.0s / 11 / 94k (3/3) | 17.8s / 13 / 85k (3/3) | 30.0s / 18 / 198k (3/3) |
| gen-elements-table | 12.4s / 4 / 41k (3/3) | 10.3s / 4 / 45k (3/3) | 12.7s / 4 / 65k (3/3) |
| gen-quotes-scroll | 25.6s / 4 / 38k (3/3) | 25.9s / 4 / 43k (3/3) | 55.7s / 8 / 135k (3/3) |
| gen-httpbin-form | 19.0s / 15 / 73k (3/3) | 13.8s / 9 / 69k (3/3) | 23.1s / 8 / 122k (3/3) |
| gen-mdn-iframe | 114.5s / 71 / 1315k (3/3) | 18.0s / 9 / 72k (3/3) | 99.3s / 41 / 675k (2/3) |
| gen-apg-datepicker | 23.3s / 15 / 81k (3/3) | 23.6s / 16 / 99k (3/3) | 31.2s / 17 / 153k (3/3) |
| gen-datatables-scroll | 22.2s / 8 / 64k (3/3) | 17.6s / 6 / 54k (3/3) | 25.1s / 7 / 116k (3/3) |

### Per call

| per call | firefox before | firefox after | chrome |
| --- | --- | --- | --- |
| computer left_click ms, median [min–max] | 697 [289–1479] (70 clicks) | 123 [108–235] (38 clicks) | 161 [135–477] (57 clicks) |
| find result bytes, median [min–max] | 802 [209–4226] (34 calls) | 438 [195–778] (20 calls) | 438 [192–627] (15 calls) |
| computer scroll actions (errors) | 7 (5) | 0 (0) | 9 (0) |
| get_page_text mean ms, issued alone | not recorded | 15 (11 of 37) | not recorded |
| find mean ms, issued alone | not recorded | 54 (7 of 20) | not recorded |
| NS_ERROR_UNEXPECTED results | ≥6 | 0 | ≥0 |
| tool errors, all calls | 23 | 13 | 20 |
| calls to tools not offered | screenshot 4, scroll_to 1 | left_click 5, screenshot 2 | computer 1 |

NS_ERROR_UNEXPECTED: a count from the traces' result text where the trace has it; "≥n" counts the error samples a row keeps (at most 5 per run), so it's a lower bound.

By tool: calls per run, and mean ms per call. A call issued in the same message as a navigate waits for it, so its ms includes the page load; the after runs did that more often (navigate then get_page_text or find in one turn), which is why those two look slower per call here and not in the issued-alone rows above.

| tool | firefox before calls | firefox after calls | chrome calls | firefox before ms | firefox after ms | chrome ms |
| --- | --- | --- | --- | --- | --- | --- |
| computer | 4.50 | 1.50 | 4.08 | 402 | 153 | 1411 |
| javascript_tool | 1.56 | 0.96 | 1.73 | 710 | 1408 | 3707 |
| navigate | 1.75 | 1.17 | 1.13 | 1904 | 2108 | 2986 |
| tabs_context_mcp | 1.00 | 1.00 | 1.02 | 55 | 62 | 1937 |
| tabs_close_mcp | 1.00 | 0.90 | 0.90 | 29 | 102 | 141 |
| get_page_text | 0.96 | 0.77 | 0.71 | 335 | 1184 | 3661 |
| find | 0.71 | 0.42 | 0.31 | 264 | 1100 | 3135 |
| form_input | 0.54 | 0.13 | 0.00 | 12 | 24 | – |
| read_page | 0.15 | 0.19 | 0.15 | 457 | 487 | 1423 |
| browser_batch | 0.00 | 0.00 | 0.48 | – | – | 11233 |
| batch | 0.00 | 0.15 | 0.00 | – | 6984 | – |
| screenshot | 0.08 | 0.04 | 0.00 | 308 | 63 | – |
| left_click | 0.00 | 0.10 | 0.00 | – | 0 | – |
| tabs_create_mcp | 0.06 | 0.00 | 0.00 | 38 | – | – |
| scroll_to | 0.02 | 0.00 | 0.00 | 0 | – | – |
| read_network_requests | 0.00 | 0.00 | 0.02 | – | – | 400 |

### gen-mdn-iframe

| | firefox before | firefox after |
| --- | --- | --- |
| wall s | 114.5 [82.3–252.1] | 18.0 [13.6–20.9] |
| tool calls | 71 [44–107] | 9 [9–11] |
| input tokens | 1315k [782k–2507k] | 72k [70k–74k] |
| runs that set the select through a frame ref (form_input ref_N@fM) | 0/3 | 3/3 |
| runs that used javascript_tool | 3/3 | 0/3 |
| tools, all runs | computer 155, javascript_tool 22, find 15, navigate 7, read_page 4, get_page_text 4, tabs_close_mcp 4, tabs_context_mcp 3, tabs_create_mcp 3, form_input 2, screenshot 2, scroll_to 1 | computer 10, read_page 6, tabs_context_mcp 3, navigate 3, find 3, form_input 3, tabs_close_mcp 1 |

## devtools on vs off (Firefox, baseline arm)

Sources: off is `results/browsers-after.jsonl`; on is `results/browsers-devtools.jsonl`, the same tasks with the MCP server started with FIREFOX_BRIDGE_DEVTOOLS=1 (`run.mjs --devtools`), run right after. With it on, the model is offered one more tool (devtools) and the extension keeps each session tab's console and network log from page load. The model called devtools 0 time(s) in 48 runs.

| metric | devtools off | devtools on | devtools on / devtools off (medians) |
| --- | --- | --- | --- |
| runs | 48 | 48 | |
| success | 100% (48/48) | 100% (48/48) | |
| wall time (s) | 16.6 [7.6–47.7] | 16.0 [8.3–30.3] | 0.97 |
| tool calls | 6 [3–17] | 6 [3–16] | 1.00 |
| screenshot/zoom actions | 0 [0–3] | 0 [0–3] | – |
| turns | 7 [4–18] | 7 [4–17] | 1.00 |
| input tokens (incl. cache) | 55k [27k–197k] | 56k [36k–194k] | 1.02 |
| uncached input tokens | 8.5k [3.8k–20k] | 7.9k [3.7k–15k] | 0.93 |
| output tokens | 1.1k [510–4.0k] | 1.0k [500–2.2k] | 0.99 |
| tool result KB (text + images) | 13.6 [0.3–212.6] | 13.6 [0.3–212.8] | 1.00 |
| cost (USD) | 0.060 [0.030–0.150] | 0.056 [0.029–0.114] | 0.94 |
| total wall time, all runs (min) | 14.3 | 13.5 | |
| total tool calls, all runs | 351 | 333 | |
| total cost, all runs (USD) | 2.88 | 2.69 | |

Median [min–max] per run.

Per task: median wall s / tool calls / input tokens, and success.

| task | devtools off | devtools on |
| --- | --- | --- |
| art-ars-dragon | 10.4s / 4 / 45k (3/3) | 10.1s / 4 / 46k (3/3) |
| art-ars-firefox | 9.1s / 4 / 51k (3/3) | 9.8s / 4 / 52k (3/3) |
| art-guardian-tang | 10.9s / 4 / 55k (3/3) | 9.5s / 4 / 56k (3/3) |
| data-hn-readability | 23.8s / 6 / 111k (3/3) | 21.4s / 7 / 67k (3/3) |
| data-crates-html | 13.8s / 6 / 49k (3/3) | 12.2s / 6 / 50k (3/3) |
| data-ashby-ramp | 11.4s / 4 / 55k (3/3) | 10.3s / 4 / 56k (3/3) |
| cmp-pypi | 26.7s / 5 / 59k (3/3) | 25.0s / 5 / 57k (3/3) |
| cmp-npm | 23.9s / 6 / 58k (3/3) | 27.3s / 4 / 53k (3/3) |
| gen-wiki-chain | 20.3s / 13 / 152k (3/3) | 23.5s / 11 / 109k (3/3) |
| gen-pydocs-search | 17.8s / 13 / 85k (3/3) | 15.1s / 13 / 87k (3/3) |
| gen-elements-table | 10.3s / 4 / 45k (3/3) | 11.1s / 4 / 48k (3/3) |
| gen-quotes-scroll | 25.9s / 4 / 43k (3/3) | 22.8s / 4 / 45k (3/3) |
| gen-httpbin-form | 13.8s / 9 / 69k (3/3) | 14.2s / 8 / 60k (3/3) |
| gen-mdn-iframe | 18.0s / 9 / 72k (3/3) | 21.3s / 9 / 72k (3/3) |
| gen-apg-datepicker | 23.6s / 16 / 99k (3/3) | 21.3s / 16 / 92k (3/3) |
| gen-datatables-scroll | 17.6s / 6 / 54k (3/3) | 17.5s / 7 / 70k (3/3) |

### Per call

| per call | devtools off | devtools on |
| --- | --- | --- |
| computer left_click ms, median [min–max] | 123 [108–235] (38 clicks) | 128 [118–156] (39 clicks) |
| find result bytes, median [min–max] | 438 [195–778] (20 calls) | 595 [195–862] (19 calls) |
| computer scroll actions (errors) | 0 (0) | 0 (0) |
| get_page_text mean ms, issued alone | 15 (11 of 37) | 16 (4 of 34) |
| find mean ms, issued alone | 54 (7 of 20) | 57 (5 of 19) |
| NS_ERROR_UNEXPECTED results | 0 | 0 |
| tool errors, all calls | 13 | 6 |
| calls to tools not offered | left_click 5, screenshot 2 | left_click 3 |

NS_ERROR_UNEXPECTED: a count from the traces' result text where the trace has it; "≥n" counts the error samples a row keeps (at most 5 per run), so it's a lower bound.

By tool: calls per run, and mean ms per call. A call issued in the same message as a navigate waits for it, so its ms includes the page load; the after runs did that more often (navigate then get_page_text or find in one turn), which is why those two look slower per call here and not in the issued-alone rows above.

| tool | devtools off calls | devtools on calls | devtools off ms | devtools on ms |
| --- | --- | --- | --- | --- |
| computer | 1.50 | 1.58 | 153 | 88 |
| navigate | 1.17 | 1.13 | 2108 | 1921 |
| tabs_context_mcp | 1.00 | 1.00 | 62 | 59 |
| tabs_close_mcp | 0.90 | 0.92 | 102 | 31 |
| javascript_tool | 0.96 | 0.69 | 1408 | 1458 |
| get_page_text | 0.77 | 0.71 | 1184 | 1400 |
| find | 0.42 | 0.40 | 1100 | 1198 |
| read_page | 0.19 | 0.17 | 487 | 540 |
| batch | 0.15 | 0.17 | 6984 | 6665 |
| form_input | 0.13 | 0.13 | 24 | 34 |
| left_click | 0.10 | 0.06 | 0 | 1 |
| screenshot | 0.04 | 0.00 | 63 | – |

## Re-measure 2: the re-measure's fixes, after another restart (baseline arm)

Sources: Firefox after is `results/browsers-after.jsonl` (the first re-measure); Firefox after-2 is `results/browsers-after-2.jsonl`, the same 16 tasks, model and prompt, once Firefox had restarted with main at c1ad4bb. It loads what the first re-measure's traces led to: find's header names `computer left_click`, scroll_to on a frame ref reports screenshot coordinates, tabs_context_mcp and navigate say "Created tab N ... close it", javascript_tool says to fetch pages rather than the site's API, computer's description says it has no separate screenshot or click tools, and typing fires change on Tab or a click away in background tabs. Chrome is the rows in `results/browsers.jsonl`, not run again.

| metric | firefox after | firefox after-2 | chrome | firefox after-2 / firefox after (medians) |
| --- | --- | --- | --- | --- |
| runs | 48 | 48 | 48 | |
| success | 100% (48/48) | 100% (48/48) | 98% (47/48) | |
| wall time (s) | 16.6 [7.6–47.7] | 14.9 [7.3–30.8] | 25.5 [10.2–211.0] | 0.90 |
| tool calls | 6 [3–17] | 6 [4–16] | 7 [3–67] | 1.00 |
| screenshot/zoom actions | 0 [0–3] | 0 [0–4] | 0 [0–25] | – |
| turns | 7 [4–18] | 7 [5–17] | 8 [4–68] | 1.00 |
| input tokens (incl. cache) | 55k [27k–197k] | 56k [44k–106k] | 119k [48k–1146k] | 1.02 |
| uncached input tokens | 8.5k [3.8k–20k] | 8.0k [3.8k–14k] | 11k [5.9k–47k] | 0.94 |
| output tokens | 1.1k [510–4.0k] | 1.1k [484–2.3k] | 1.5k [548–11k] | 1.00 |
| tool result KB (text + images) | 13.6 [0.3–212.6] | 13.1 [0.5–262.4] | 22.0 [1.3–1275.0] | 0.96 |
| cost (USD) | 0.060 [0.030–0.150] | 0.058 [0.030–0.076] | 0.080 [0.041–0.514] | 0.97 |
| total wall time, all runs (min) | 14.3 | 12.2 | 30.9 | |
| total tool calls, all runs | 351 | 361 | 505 | |
| total cost, all runs (USD) | 2.88 | 2.63 | 5.02 | |

Median [min–max] per run.

Per task: median wall s / tool calls / input tokens, and success.

| task | firefox after | firefox after-2 | chrome |
| --- | --- | --- | --- |
| art-ars-dragon | 10.4s / 4 / 45k (3/3) | 8.6s / 4 / 45k (3/3) | 12.2s / 4 / 72k (3/3) |
| art-ars-firefox | 9.1s / 4 / 51k (3/3) | 7.4s / 4 / 51k (3/3) | 12.3s / 4 / 79k (3/3) |
| art-guardian-tang | 10.9s / 4 / 55k (3/3) | 9.8s / 4 / 55k (3/3) | 12.9s / 4 / 83k (3/3) |
| data-hn-readability | 23.8s / 6 / 111k (3/3) | 14.7s / 6 / 56k (3/3) | 36.7s / 11 / 203k (3/3) |
| data-crates-html | 13.8s / 6 / 49k (3/3) | 14.1s / 6 / 49k (3/3) | 20.5s / 8 / 87k (3/3) |
| data-ashby-ramp | 11.4s / 4 / 55k (3/3) | 10.8s / 4 / 55k (3/3) | 15.9s / 4 / 100k (3/3) |
| cmp-pypi | 26.7s / 5 / 59k (3/3) | 17.3s / 6 / 64k (3/3) | 29.4s / 6 / 121k (3/3) |
| cmp-npm | 23.9s / 6 / 58k (3/3) | 23.5s / 13 / 86k (3/3) | 48.2s / 8 / 191k (3/3) |
| gen-wiki-chain | 20.3s / 13 / 152k (3/3) | 15.2s / 11 / 88k (3/3) | 35.7s / 13 / 176k (3/3) |
| gen-pydocs-search | 17.8s / 13 / 85k (3/3) | 15.4s / 11 / 86k (3/3) | 30.0s / 18 / 198k (3/3) |
| gen-elements-table | 10.3s / 4 / 45k (3/3) | 11.0s / 4 / 47k (3/3) | 12.7s / 4 / 65k (3/3) |
| gen-quotes-scroll | 25.9s / 4 / 43k (3/3) | 23.3s / 4 / 44k (3/3) | 55.7s / 8 / 135k (3/3) |
| gen-httpbin-form | 13.8s / 9 / 69k (3/3) | 12.5s / 8 / 59k (3/3) | 23.1s / 8 / 122k (3/3) |
| gen-mdn-iframe | 18.0s / 9 / 72k (3/3) | 16.1s / 12 / 89k (3/3) | 99.3s / 41 / 675k (2/3) |
| gen-apg-datepicker | 23.6s / 16 / 99k (3/3) | 20.1s / 16 / 90k (3/3) | 31.2s / 17 / 153k (3/3) |
| gen-datatables-scroll | 17.6s / 6 / 54k (3/3) | 16.4s / 6 / 63k (3/3) | 25.1s / 7 / 116k (3/3) |

### What each fix was meant to change

| check | firefox after | firefox after-2 |
| --- | --- | --- |
| calls to a tool not offered, right after a find (find calls) | 5 (20) | 2 (21) |
| calls to tools not offered, all | left_click 5, screenshot 2 | left_click 2, javascript_tool_placeholder 1, screenshot 2 |
| computer scroll_to on a frame ref: the center it reported | (227, 10) x3 | (227, -63) x3 |
| runs that never closed their tab | 5 of 48 | 0 of 48 |
| results that start "Created tab N" | 0 | 48 |
| javascript_tool fetches of an API or JSON in data tasks | 7 | 0 |
| data-hn-readability input tokens, median [min–max] | 111k [56k–197k] | 56k [56k–65k] |

### Per call

| per call | firefox after | firefox after-2 | chrome |
| --- | --- | --- | --- |
| computer left_click ms, median [min–max] | 123 [108–235] (38 clicks) | 122 [112–142] (39 clicks) | 161 [135–477] (57 clicks) |
| find result bytes, median [min–max] | 438 [195–778] (20 calls) | 611 [211–878] (21 calls) | 438 [192–627] (15 calls) |
| computer scroll actions (errors) | 0 (0) | 0 (0) | 9 (0) |
| get_page_text mean ms, issued alone | 15 (11 of 37) | 11 (7 of 39) | not recorded |
| find mean ms, issued alone | 54 (7 of 20) | 47 (6 of 21) | not recorded |
| NS_ERROR_UNEXPECTED results | 0 | 0 | ≥0 |
| tool errors, all calls | 13 | 11 | 20 |
| calls to tools not offered | left_click 5, screenshot 2 | left_click 2, javascript_tool_placeholder 1, screenshot 2 | computer 1 |

NS_ERROR_UNEXPECTED: a count from the traces' result text where the trace has it; "≥n" counts the error samples a row keeps (at most 5 per run), so it's a lower bound.

By tool: calls per run, and mean ms per call. A call issued in the same message as a navigate waits for it, so its ms includes the page load; the after runs did that more often (navigate then get_page_text or find in one turn), which is why those two look slower per call here and not in the issued-alone rows above.

| tool | firefox after calls | firefox after-2 calls | chrome calls | firefox after ms | firefox after-2 ms | chrome ms |
| --- | --- | --- | --- | --- | --- | --- |
| computer | 1.50 | 1.50 | 4.08 | 153 | 84 | 1411 |
| navigate | 1.17 | 1.44 | 1.13 | 2108 | 2026 | 2986 |
| javascript_tool | 0.96 | 0.90 | 1.73 | 1408 | 1556 | 3707 |
| tabs_context_mcp | 1.00 | 1.00 | 1.02 | 62 | 45 | 1937 |
| tabs_close_mcp | 0.90 | 1.00 | 0.90 | 102 | 21 | 141 |
| get_page_text | 0.77 | 0.81 | 0.71 | 1184 | 1278 | 3661 |
| find | 0.42 | 0.44 | 0.31 | 1100 | 968 | 3135 |
| read_page | 0.19 | 0.19 | 0.15 | 487 | 457 | 1423 |
| browser_batch | 0.00 | 0.00 | 0.48 | – | – | 11233 |
| form_input | 0.13 | 0.13 | 0.00 | 24 | 27 | – |
| batch | 0.15 | 0.02 | 0.00 | 6984 | 7023 | – |
| left_click | 0.10 | 0.04 | 0.00 | 0 | 1 | – |
| screenshot | 0.04 | 0.04 | 0.00 | 63 | 28 | – |
| javascript_tool_placeholder | 0.00 | 0.02 | 0.00 | – | 1869 | – |
| read_network_requests | 0.00 | 0.00 | 0.02 | – | – | 400 |
