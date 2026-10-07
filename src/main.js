// Worker entry: the MCP server (index.js) plus the every-minute WhatsApp watcher (watch.js).
import mcp from "./index.js";
import { watch, watchStatus } from "./watch.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/watch/status" && request.method === "GET") return watchStatus(request, env);
    if (url.pathname === "/watch/run" && request.method === "POST") {
      // Manual tick (same logic as the cron). Throttled to once per 20s; output has no secrets.
      const last = Number((await env.STATE.get("watcher:manual_at")) || 0);
      if (Date.now() - last < 20000) return new Response("slow down", { status: 429 });
      await env.STATE.put("watcher:manual_at", String(Date.now()));
      let r;
      try { r = await watch(env); } catch (e) { r = { error: String(e?.message || e) }; }
      return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
    }
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
