// Shared by the runners: the env a nested `claude -p` must not inherit, and a fold of its
// stream-json events into per-run metrics.

import { screenshotActions } from "./trace.mjs";

// Nested `claude` refuses to start, or attaches to this session, with these set.
export const STRIP_ENV = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "CLAUDE_EFFORT", "AI_AGENT",
  "FIREFOX_AGENT_BRIDGE_SESSION", "FIREFOX_BRIDGE_EXPERIMENTS",
];

export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  return { ...env, ...extra };
}

// Folds stream-json events into the per-run metrics. Events may carry `_t` (ms since the run
// started, stamped by the reader) for timing fields.
export function summarize(events) {
  const m = {
    session_id: null, model: null, tools_available: null, per_turn_effort_active: null,
    tool_calls: 0, tool_calls_by_tool: {}, subagent_tool_calls: 0, screenshots: 0, screenshot_actions: 0,
    repeated_calls: 0, retries_after_error: 0, first_tool_ms: null, thinking_blocks: 0, thinking_signature_chars: 0, thinking_text_chars: 0,
    tool_errors: 0, error_samples: [], tool_result_chars: 0, tool_result_images: 0, turns: null, assistant_messages: 0,
    usage: null, model_usage: null, cost_usd: null, duration_ms: null, duration_api_ms: null,
    result_subtype: null, is_error: null, final_text: null,
  };
  let lastSig = null;
  let lastName = null;
  let lastErrored = false;
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") {
      m.session_id = e.session_id;
      m.model = e.model;
      m.tools_available = e.tools;
      m.per_turn_effort_active = e.per_turn_effort_active ?? null;
    } else if (e.type === "assistant") {
      m.assistant_messages++;
      for (const b of e.message?.content ?? []) {
        if (b.type === "thinking" || b.type === "redacted_thinking") {
          m.thinking_blocks++;
          m.thinking_signature_chars += (b.signature ?? b.data ?? "").length;
          m.thinking_text_chars += (b.thinking ?? "").length;
        }
        if (b.type !== "tool_use") continue;
        m.tool_calls++;
        if (m.first_tool_ms == null && e._t != null) m.first_tool_ms = e._t;
        m.tool_calls_by_tool[b.name] = (m.tool_calls_by_tool[b.name] ?? 0) + 1;
        if (e.parent_tool_use_id) m.subagent_tool_calls++;
        if (b.name === "mcp__firefox__computer" && ["screenshot", "zoom"].includes(b.input?.action)) m.screenshots++;
        // screenshots counts top-level calls (computer, and the screenshot tool when it's offered:
        // the screenshotAlias experiment); screenshot_actions also counts those inside a batch.
        if (b.name === "mcp__firefox__screenshot" && m.tools_available?.includes(b.name)) m.screenshots++;
        m.screenshot_actions += screenshotActions(b.name, b.input, m.tools_available);
        // The same call with the same input as the one just before it (a retry or a stuck loop).
        // Screenshots, waits, scrolls and key presses repeat legitimately, so they don't count.
        // retries_after_error: the call right after a failed call used the same tool.
        const benign = b.name === "mcp__firefox__computer" && ["screenshot", "wait", "scroll", "key", "zoom"].includes(b.input?.action);
        const sig = b.name + JSON.stringify(b.input ?? {});
        if (sig === lastSig && !benign) m.repeated_calls++;
        if (lastErrored && b.name === lastName) m.retries_after_error++;
        lastSig = sig;
        lastName = b.name;
        lastErrored = false;
      }
    } else if (e.type === "user") {
      const content = e.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== "tool_result") continue;
        // Size of what the tools fed back into the context (text chars, image count).
        for (const c of Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content ?? "") }]) {
          if (c.type === "image") m.tool_result_images++;
          else m.tool_result_chars += (c.text ?? "").length;
        }
        if (b.is_error) {
          m.tool_errors++;
          lastErrored = true;
          const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join(" ") : String(b.content ?? "");
          if (m.error_samples.length < 5) m.error_samples.push(text.slice(0, 300));
        }
      }
    } else if (e.type === "result") {
      m.turns = e.num_turns;
      m.usage = e.usage
        ? {
            input_tokens: e.usage.input_tokens ?? 0,
            output_tokens: e.usage.output_tokens ?? 0,
            cache_creation_input_tokens: e.usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: e.usage.cache_read_input_tokens ?? 0,
          }
        : null;
      m.model_usage = e.modelUsage ?? null;
      m.cost_usd = e.total_cost_usd ?? null;
      m.duration_ms = e.duration_ms ?? null;
      m.duration_api_ms = e.duration_api_ms ?? null;
      m.result_subtype = e.subtype;
      m.is_error = e.is_error;
      m.final_text = typeof e.result === "string" ? e.result : null;
    }
  }
  // Totals across all models (sub-agents included) from modelUsage.
  if (m.model_usage) {
    const t = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    for (const u of Object.values(m.model_usage)) {
      t.input_tokens += u.inputTokens ?? 0;
      t.output_tokens += u.outputTokens ?? 0;
      t.cache_creation_input_tokens += u.cacheCreationInputTokens ?? 0;
      t.cache_read_input_tokens += u.cacheReadInputTokens ?? 0;
    }
    m.tokens_all_models = t;
  }
  return m;
}
