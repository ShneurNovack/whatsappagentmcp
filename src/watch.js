// WhatsApp -> Rory wake-up watcher (runs every minute from the Cron Trigger).
//
// Looks at the WhatsApp agent's update stream starting from the read position the
// MCP server saved for Rory (KV "agent:<hash>".offset). If Zami sent something Rory
// hasn't read yet, it fires the "Rory hourly run" routine through the Claude Code
// routine fire API so the Rory session wakes up and handles it right away.
//
// It never advances Rory's read position and never marks anything read, so Rory
// still gets every message through whatsapp_get_messages as usual.
//
// Config (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   WA_AGENT_TOKEN   secret  the WhatsApp agent API key (same one in the connector URL)
//   RORY_FIRE_TOKEN  secret  the API trigger token for the Rory routine (sk-ant-oat01-...)
//   RORY_ROUTINE_ID  secret  trig_... id of the Claude Code relay routine to fire. That routine
//                            calls fire_trigger on the Rory scheduled task so the ping lands in
//                            the Rory chat (Claude Code routines and Claude scheduled tasks are separate).
// Until all three exist the watcher does nothing.

const WA_API = "https://api.whatsapp.com/agent/v1";
const FIRE_API = "https://api.anthropic.com/v1/claude_code/routines/";
const WATCH_KEY = "watcher:v1";
const MIN_AGE_SEC = 40; // give an already-listening Rory a chance to read it first
const MIN_GAP_SEC = 120; // never fire more often than this
const MAX_FIRES_PER_HOUR = 20; // routine limit is 30/hour including the hourly schedule

async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function etParts(date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), minute: Number(p.minute) };
}

async function pollFrom(token, offset) {
  // Read (without consuming) everything after `offset`. Returns user messages + head offset.
  const msgs = [];
  let next = offset;
  for (let page = 0; page < 5; page++) {
    const res = await fetch(`${WA_API}/updates?offset=${next}&limit=100&timeout=0`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`updates HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const v = body?.entry?.[0]?.changes?.[0]?.value || {};
    const batch = v.messages || [];
    for (const m of batch) {
      if (!m.from?.startsWith("user:")) continue;
      msgs.push({ id: m.id, ts: Number(m.timestamp) || 0, type: m.type, text: m.type === "text" ? m.text?.body : undefined });
    }
    const n = body?.next_offset;
    if (n === undefined || n === next) break;
    next = n;
    if (batch.length + (v.statuses || []).length < 100) break;
  }
  return { msgs, head: next };
}

export async function watch(env) {
  const token = env.WA_AGENT_TOKEN;
  const fireToken = env.RORY_FIRE_TOKEN;
  // Claude Code relay routine "Rory WhatsApp relay" (it calls fire_trigger on the Rory scheduled task).
  const routine = env.RORY_RELAY_ROUTINE_ID || "trig_01RjGX1D2qZaNh7nBNGM9Gfn";
  if (!env.STATE) return { skipped: "no KV" };
  const diag = (reason) => env.STATE.put("watcher:diag", JSON.stringify({ at: Math.floor(Date.now() / 1000), reason, has_token: !!token, has_fire: !!fireToken }));
  if (!token || !fireToken || !routine) {
    await diag("not configured");
    return { skipped: "not configured" };
  }

  const now = Math.floor(Date.now() / 1000);
  const w = (await env.STATE.get(WATCH_KEY, "json")) || {};
  const agent = (await env.STATE.get("agent:" + (await sha(token)), "json")) || {};
  const saveW = (patch) => env.STATE.put(WATCH_KEY, JSON.stringify({ ...w, ...patch, last_tick: now }));

  if (agent.offset === undefined || agent.offset === null) {
    await diag("no saved read position for this WA_AGENT_TOKEN (key agent:" + (await sha(token)) + ")");
    return { skipped: "no saved read position yet" };
  }

  const { msgs, head } = await pollFrom(token, agent.offset);
  if (!msgs.length) {
    await saveW({ unread: 0 });
    return { unread: 0 };
  }

  const newest = msgs[msgs.length - 1];
  const oldest = msgs[0];
  const { hour, minute } = etParts(new Date());
  const quiet = hour >= 1 && hour < 8; // matches Rory's quiet hours
  const hourlySoon = minute >= 54; // the hourly run (:57) will pick it up anyway

  const firesLastHour = (w.fires || []).filter((t) => now - t < 3600);
  let reason = null;
  if (quiet) reason = "quiet hours";
  else if (hourlySoon) reason = "hourly run is about to start";
  else if (w.fired_for === newest.id) reason = "already fired for this message";
  else if (now - oldest.ts < MIN_AGE_SEC && now - newest.ts < MIN_AGE_SEC) reason = "too fresh, Rory may already be listening";
  else if (w.last_fire && now - w.last_fire < MIN_GAP_SEC) reason = "fired recently";
  else if (firesLastHour.length >= MAX_FIRES_PER_HOUR) reason = "hourly fire cap reached";

  if (reason) {
    await saveW({ unread: msgs.length, last_skip: reason, fires: firesLastHour });
    return { unread: msgs.length, skipped: reason };
  }

  const preview = msgs
    .slice(-3)
    .map((m) => (m.type === "text" ? `"${(m.text || "").slice(0, 200)}"` : `[${m.type}]`))
    .join(" / ");
  const text =
    `WHATSAPP PING (not a scheduled hourly run): Zami sent ${msgs.length} new WhatsApp message(s) that Rory hasn't read yet. ` +
    `Latest: ${preview}. Skip the full hourly checklist: read WhatsApp now (whatsapp_get_messages, mode new), act on what he asked ` +
    `and reply on WhatsApp, then keep the usual 10-minute listen window. Only do the full run if the scheduled one is due.`;

  const res = await fetch(FIRE_API + encodeURIComponent(routine) + "/fire", {
    method: "POST",
    headers: { Authorization: `Bearer ${fireToken}`, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const out = await res.text();
  if (!res.ok) {
    await saveW({ unread: msgs.length, last_error: `fire HTTP ${res.status}: ${out.slice(0, 300)}`, last_error_at: now, fires: firesLastHour });
    return { error: res.status };
  }
  await saveW({ unread: msgs.length, fired_for: newest.id, last_fire: now, last_fire_result: out.slice(0, 300), fires: [...firesLastHour, now], last_error: null });
  return { fired: true, head };
}

// Small status page: GET /watch/status?key=<first 8 chars of the agent token> (no secrets in the output).
export async function watchStatus(request, env) {
  const url = new URL(request.url);
  const token = env.WA_AGENT_TOKEN || "";
  if (!token || url.searchParams.get("key") !== token.slice(0, 8)) return new Response("forbidden", { status: 403 });
  const w = (await env.STATE.get(WATCH_KEY, "json")) || {};
  return new Response(
    JSON.stringify({ configured: !!(env.WA_AGENT_TOKEN && env.RORY_FIRE_TOKEN), routine: env.RORY_RELAY_ROUTINE_ID || "trig_01RjGX1D2qZaNh7nBNGM9Gfn", ...w }, null, 2),
    { headers: { "Content-Type": "application/json" } }
  );
}
