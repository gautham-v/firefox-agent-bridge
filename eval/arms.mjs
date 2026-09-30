// Arm guidance, appended to the system prompt with --append-system-prompt. Each arm is a
// "Wizard of Oz" version of a speed idea, built only from today's tools, so the extension and the
// MCP server are the same in every arm.

// Reader-view extraction. Firefox Reader View is Mozilla's Readability.js; tabs.update refuses
// about:reader URLs ("Illegal URL") and pages can't navigate to them either, so the arm runs the
// same library in the page instead. Strict-CSP pages (GitHub, MDN) block the import, so the
// snippet falls back to a DOM heuristic that keeps headings, paragraphs and list items inside
// <article>/<main> and drops nav, asides, footers, forms and banners.
export const READER_SNIPPET = String.raw`const blocks = (root) => [...root.querySelectorAll("h1, h2, h3, h4, h5, p, li, blockquote, pre, figcaption, td, th, dt, dd")]
  .filter((e) => !e.querySelector("p, li, blockquote, pre"))
  .map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
const out = await (async () => {
  try {
    const { Readability } = await import("https://cdn.jsdelivr.net/npm/@mozilla/readability@0.6.0/+esm");
    const a = new Readability(document.cloneNode(true)).parse();
    const text = a && blocks(new DOMParser().parseFromString(a.content, "text/html").body);
    if (text && text.length > 300) return { via: "readability", title: a.title, byline: a.byline, text };
  } catch {}
  const clean = (el) => {
    const root = el.cloneNode(true);
    root.querySelectorAll("nav, aside, footer, form, script, style, noscript, iframe, svg, button, [role=navigation], [role=complementary], [role=dialog], [class*=cookie i], [id*=cookie i], [class*=consent i], [class*=newsletter i], [class*=related i], [class*=promo i]").forEach((e) => e.remove());
    return blocks(root);
  };
  // The article, main or role=main container with the most text; the whole body if none has much.
  const texts = [...document.querySelectorAll("article, main, [role=main]")].map(clean).sort((a, b) => b.length - a.length);
  const text = texts[0]?.length >= 500 ? texts[0] : clean(document.body);
  return { via: "fallback", title: document.title, text };
})();
JSON.stringify(out)`;

export const ARM_PROMPTS = {
  baseline: null,

  strip: `# Reading articles
Before reading an article-like page (a news story, blog post, long read or docs page), don't read the whole raw page with get_page_text or read_page. Instead, once the page has loaded, extract the article the way Firefox Reader View does by running this code with javascript_tool (action "javascript_exec") on that tab, unchanged:

${READER_SNIPPET}

It returns JSON with the title, byline and the article's main text only. Answer from that text. Fall back to get_page_text only if the extracted text is clearly missing what you need. If a cookie or consent banner or another overlay blocks the page, dismiss it first (click its accept or close button) and then extract.`,

  data: `# Reading list and search pages
On list, search-results and job-board pages, read the data the page itself loaded before reading the DOM:
1. Once the page has loaded (and any filters are applied), run with javascript_tool:
   JSON.stringify(performance.getEntriesByType("resource").filter(e => ["fetch", "xmlhttprequest"].includes(e.initiatorType)).map(e => e.name))
2. Pick the endpoint(s) that returned the list's data (usually JSON). Re-fetch them in the page context with javascript_tool, e.g. await (await fetch(url, { credentials: "include" })).json(), changing page-size or offset query parameters if that gets everything you need in one call.
3. Return only the fields you need (trimmed JSON: map to the few fields you need and slice), never the whole response body.
4. If the endpoint is a POST (GraphQL and similar) whose body you can't reconstruct, or the JSON doesn't have what the task needs, fall back to the DOM (get_page_text, read_page, find).`,

  fanout: `# Comparing several pages
When a task collects or compares the same facts across several pages, use the Task tool to spawn one sub-agent per page, all in a single message so they run in parallel, instead of visiting the pages yourself. Give each sub-agent the exact URL and exactly what to extract, and tell it to: open its own tab with tabs_create_mcp, navigate that tab, read it with the Firefox tools (mcp__firefox__*), close its tab with tabs_close_mcp, and reply with only the extracted values. Then merge their answers into the final result.`,
};

// Built-in tools each arm may use (--tools). MCP tools are allowed separately.
export const ARM_TOOLS = {
  baseline: "",
  strip: "",
  data: "",
  fanout: "Task",
};
