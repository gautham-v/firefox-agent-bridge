# Eval report

Generated 2026-09-30T02:56:52.290Z from `results/runs.jsonl` (48 runs).

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
