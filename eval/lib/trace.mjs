// Per-tool-call traces from a `claude -p --output-format stream-json` event stream, so a gap
// between browsers can be traced to specific tools. Each event carries the time the runner read
// it from stdout (`t`); a call's duration is the time from the assistant event that holds its
// tool_use to the user event that holds its tool_result. That includes MCP and extension overhead
// but not model time, and is approximate when several calls are issued in one message.

// Tool names without the MCP server prefix, so Firefox and Chrome tools line up.
export const shortTool = (name) => String(name ?? "").replace(/^mcp__(firefox|claude-in-chrome)__/, "");

// Image dimensions from a base64 PNG/JPEG/GIF/WebP header; null when unknown.
export function imageSize(b64) {
  let buf;
  try {
    buf = Buffer.from(String(b64 ?? "").slice(0, 200_000), "base64");
  } catch {
    return null;
  }
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
    }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Rough token estimates: text at 4 bytes per token; images at w*h/750 (Anthropic's rule of thumb).
export const textTokens = (bytes) => Math.ceil(bytes / 4);
export const imageTokens = (d) => (d ? Math.ceil((d.w * d.h) / 750) : 0);

// Short, JSON-ish summary of a tool's input: long strings cut, batch actions listed.
export function summarizeArgs(input) {
  const cut = (v) => {
    if (typeof v === "string") return v.length > 100 ? `${v.slice(0, 100)}…(${v.length} chars)` : v;
    if (Array.isArray(v)) return v.map(cut);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
    return v;
  };
  let s;
  if (Array.isArray(input?.actions)) {
    // browser_batch: one line per inner action.
    s = `batch[${input.actions.length}]: ` + input.actions.map((a) => `${shortTool(a.name)}${a.input?.action ? ":" + a.input.action : ""}${a.input?.url ? " " + a.input.url : ""}`).join(", ");
  } else s = JSON.stringify(cut(input ?? {}));
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

// Screenshot-like actions a call asked for (computer screenshot/zoom, including inside a batch).
export function screenshotActions(name, input) {
  const tool = shortTool(name);
  if (tool === "computer") return ["screenshot", "zoom"].includes(input?.action) ? 1 : 0;
  if (tool === "browser_batch") return (input?.actions ?? []).filter((a) => shortTool(a.name) === "computer" && ["screenshot", "zoom"].includes(a.input?.action)).length;
  return 0;
}

// Folds timed events ([{t, e}]) into one record per tool call.
export function toolTrace(timed) {
  const calls = new Map();
  const order = [];
  for (const { t, e } of timed) {
    if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        const c = {
          seq: order.length + 1,
          id: b.id,
          tool: b.name,
          short: shortTool(b.name),
          action: b.input?.action ?? null,
          args: summarizeArgs(b.input),
          batch_actions: Array.isArray(b.input?.actions) ? b.input.actions.length : null,
          screenshot_actions: screenshotActions(b.name, b.input),
          subagent: !!e.parent_tool_use_id,
          t_use: t,
          t_result: null,
          ms: null,
          is_error: null,
          text_bytes: 0,
          images: [],
          image_bytes: 0,
        };
        calls.set(b.id, c);
        order.push(c);
      }
    } else if (e.type === "user") {
      const content = e.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== "tool_result") continue;
        const c = calls.get(b.tool_use_id);
        if (!c) continue;
        c.t_result = t;
        c.ms = t - c.t_use;
        c.is_error = !!b.is_error;
        for (const x of Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content ?? "") }]) {
          if (x.type === "image") {
            const data = x.source?.data ?? x.data ?? "";
            const d = imageSize(data);
            c.images.push(d ? `${d.w}x${d.h}` : "?");
            c.image_bytes += Math.floor((String(data).length * 3) / 4);
            c.image_tokens_est = (c.image_tokens_est ?? 0) + imageTokens(d);
          } else c.text_bytes += Buffer.byteLength(x.text ?? "", "utf8");
        }
        c.result_bytes = c.text_bytes + c.image_bytes;
        c.tokens_est = textTokens(c.text_bytes) + (c.image_tokens_est ?? 0);
      }
    }
  }
  return order.map(({ t_use, t_result, ...c }) => c);
}

// Per-tool totals for the results row.
export function traceTotals(trace) {
  const by = {};
  let images = 0;
  let screenshotActs = 0;
  for (const c of trace) {
    const b = (by[c.short] ??= { calls: 0, ms: 0, result_bytes: 0, text_bytes: 0, image_bytes: 0, images: 0, tokens_est: 0, errors: 0 });
    b.calls++;
    b.ms += c.ms ?? 0;
    b.result_bytes += c.result_bytes ?? 0;
    b.text_bytes += c.text_bytes;
    b.image_bytes += c.image_bytes;
    b.images += c.images.length;
    b.tokens_est += c.tokens_est ?? 0;
    if (c.is_error) b.errors++;
    images += c.images.length;
    screenshotActs += c.screenshot_actions;
  }
  return { by_tool: by, images, screenshot_actions: screenshotActs };
}
