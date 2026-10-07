// Worker entry: the MCP server (index.js) plus the every-minute WhatsApp watcher (watch.js).
import mcp from "./index.js";
import { watch, watchStatus } from "./watch.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/watch/status" && request.method === "GET") return watchStatus(request, env);
    return mcp.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      watch(env).catch(async (e) => {
        try {
          await env.STATE.put("watcher:last_crash", JSON.stringify({ at: Date.now(), error: String(e?.message || e) }));
        } catch {}
      })
    );
  },
};
