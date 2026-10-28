# firefox-agent-bridge

Firefox extension, native host and MCP server that let coding agents drive Firefox. `README.md` is the reference; `docs/manual-tests.md` is the by-hand checklist for the extension and sidebar, which have no automated UI tests; `eval/README.md` covers the benchmarks.

## Working here

- Extension changes only load after a Firefox restart (`scripts/restart-firefox.sh`). Don't restart Firefox, or Chrome in the comparison evals, while an eval is running.
- Evals and fixtures must not contain personal data. Never mine local Claude Code transcripts for fixtures without scanning the result; real job-search pages, forms and mail have ended up in a fixture before. Scan anything an agent adds under `eval/` or `host/test/fixtures/` before merging, since this repo is public.
- Measure before building speed features. The evals decide: wording changes to tool descriptions did not change Sonnet's habits, so only changes that showed a win were kept.

## UI style

The toolbar button, popover and tab-group icons follow macOS menu-bar-app style: monochrome, simple line glyphs, state drawn into the icon rather than text badges. The popover is a dense menu-style list with system fonts and hairline separators (13/17px text, secondary `#6e6e73`, a 6% hover wash, radius 10).

- No pulsing, glow, gradients or emoji; states are static shapes.
- No accent color unless it carries meaning. Purple is reserved for "the agent is working" (the agent cursor's color); tab groups are grey otherwise.
- The tab-group state icons are listed in the README's tab-group table; change them there and in `extension/experiment/group-state.css` together.
