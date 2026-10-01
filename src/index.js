// WhatsApp Agent Platform MCP server for Cloudflare Workers.
// Dependency-free MCP over Streamable HTTP (stateless, JSON responses).
// Wraps every endpoint of https://api.whatsapp.com/agent/v1 (developer manual v1, Aug 25 2026):
//   POST /messages, GET /updates, POST /statuses, POST /media, GET /media/<id>,
//   media download, DELETE /media/<id>
// plus convenience tools (send from URL, inbox since last check, batch send).
// The agent API token goes in the MCP URL as ?bearer_token=... and is forwarded
// upstream as Authorization: Bearer. Small per-agent state (poll offset, the
// creator's user id, profile name) lives in KV, keyed by a hash of the token.

const API = "https://api.whatsapp.com/agent/v1";
const SERVER_INFO = { name: "whatsappagentmcp", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const NO_TOKEN_MESSAGE =
  "No WhatsApp agent API token configured. Add ?bearer_token=<your agent API key> to this MCP server URL (WhatsApp > Settings > Agents > your agent > Chat info > API key).";

const LIMITS = {
  text: 4096,
  caption: 1024,
  bytes: { image: 5 * 1024 * 1024, sticker: 500 * 1024, video: 16 * 1024 * 1024, audio: 16 * 1024 * 1024, document: 16 * 1024 * 1024 },
};
const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"];
const ACCEPTED_MIME = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4", "video/3gpp"],
  audio: ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg", "audio/opus"],
  document: [
    "application/pdf",
    "text/plain",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/octet-stream",
  ],
  sticker: ["image/webp"],
};
const EXT_MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp4: "video/mp4", "3gp": "video/3gpp",
  aac: "audio/aac", m4a: "audio/mp4", mp3: "audio/mpeg", amr: "audio/amr", ogg: "audio/ogg", opus: "audio/opus",
  pdf: "application/pdf", txt: "text/plain", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// ---------- tool definitions ----------

const mediaSourceProps = {
  url: { type: "string", description: "Public http(s) URL of the file. The server downloads it and uploads it to WhatsApp for you." },
  base64: { type: "string", description: "File contents as base64 (alternative to url). Data URLs (data:<mime>;base64,...) are accepted." },
  media_id: { type: "string", description: "An existing media id (from whatsapp_upload_media, or one you received). Skips uploading." },
  mime_type: { type: "string", description: "MIME type of the file. Optional with url (taken from the response or file extension); required-ish with base64 unless a data URL." },
};
const replyProp = {
  reply_to_message_id: { type: "string", description: "Optional wamid of a message in this chat to quote/reply to (from whatsapp_get_messages)." },
};
const toProp = {
  to: { type: "string", description: "Optional recipient as user:<id>. Defaults to the agent's creator (the only allowed recipient), discovered automatically." },
};

const TOOLS = [
  {
    name: "whatsapp_send_text",
    description: `Send a text message to the user on WhatsApp. Supports WhatsApp formatting (*bold*, _italic_, ~strike~, \`\`\`mono\`\`\`, > quote, - lists). Max ${LIMITS.text} chars; longer text is split into several messages automatically. Set preview_url to render a link preview for the first URL.`,
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Message text." },
        preview_url: { type: "boolean", description: "Render a preview card for the first http(s) URL in the body. Default false." },
        ...replyProp,
        ...toProp,
      },
      required: ["body"],
    },
  },
  {
    name: "whatsapp_send_media",
    description:
      "Send an image, video, audio file, document or sticker to the user on WhatsApp, from a URL, base64 data, or an existing media id. Limits: image JPEG/PNG 5 MB; sticker WebP 500 KB (512x512); video MP4/3GP H.264+AAC 16 MB; audio AAC/M4A/MP3/AMR/OGG-Opus 16 MB; document PDF/TXT/DOC(X)/XLS(X)/PPT(X) 16 MB. Captions (max 1024) on image, video, document; filename on document.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: MEDIA_TYPES, description: "Media type to send." },
        ...mediaSourceProps,
        caption: { type: "string", description: "Caption (image, video, document only). Max 1024 chars." },
        filename: { type: "string", description: "File name including extension (document only). Defaults to the name in the URL." },
        ...replyProp,
        ...toProp,
      },
      required: ["type"],
    },
  },
  {
    name: "whatsapp_send_batch",
    description:
      "Send several messages in order (text and/or media), one after another, never concurrently. Each item is {kind:'text', body, preview_url?} or {kind:'media', type, url|base64|media_id, mime_type?, caption?, filename?}, plus optional reply_to_message_id. Stops at the first failure and reports what was sent. Mind the 12 sends/minute limit.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object" },
          description: "Messages to send in order.",
        },
        ...toProp,
      },
      required: ["items"],
    },
  },
  {
    name: "whatsapp_get_messages",
    description:
      "Read what the user sent the agent (text, images, voice notes, video, documents, stickers, reactions, replies) plus delivery/read receipts for messages you sent. By default returns everything new since the last call and remembers the position (mode 'new'). Use mode 'recent' to re-read up to 30 days of history without moving the saved position, or pass an explicit offset. Use whatsapp_get_media to view/download any attachment.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["new", "recent", "offset"],
          description: "'new' (default): since the last 'new' call, advances the saved position. 'recent': read retained history (last 30 days) from the beginning, newest last, does not advance. 'offset': read from the given offset, does not advance unless advance=true.",
        },
        offset: { type: "integer", description: "Offset to read from (mode 'offset')." },
        advance: { type: "boolean", description: "With mode 'offset', save next_offset as the new position. Default false." },
        limit: { type: "integer", description: "Max entries per poll (1-100, default 100)." },
        wait_seconds: { type: "integer", description: "Long-poll: hold up to this many seconds (0-25) for new messages if none are waiting. Default 0 (return immediately)." },
        max_pages: { type: "integer", description: "Keep polling until caught up, up to this many pages (default 5)." },
        mark_read: { type: "boolean", description: "Send blue ticks for the user's messages returned. Default false." },
        include_statuses: { type: "boolean", description: "Include delivered/read receipts for your sent messages. Default true." },
        include_raw: { type: "boolean", description: "Also include the raw API response(s). Default false." },
      },
    },
  },
  {
    name: "whatsapp_mark_read",
    description: "Mark one of the user's messages as read (blue ticks), optionally also showing the 'typing…' indicator. Marking a message read may delete it from the history buffer.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "wamid of a message the user sent." },
        typing: { type: "boolean", description: "Also show the typing indicator. Default false." },
      },
      required: ["message_id"],
    },
  },
  {
    name: "whatsapp_typing",
    description: "Show the 'typing…' indicator in the chat (it also marks the given message read). Lasts until you reply or 25 seconds; call again to refresh. Only use when you are about to reply. If message_id is omitted, the user's most recent message is used.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "wamid of a message the user sent. Optional." },
      },
    },
  },
  {
    name: "whatsapp_upload_media",
    description: "Upload a file to WhatsApp (from a URL or base64) and get a media id to send later with whatsapp_send_media. Media expires after 30 days.",
    inputSchema: {
      type: "object",
      properties: {
        url: mediaSourceProps.url,
        base64: mediaSourceProps.base64,
        mime_type: mediaSourceProps.mime_type,
        type: { type: "string", enum: MEDIA_TYPES, description: "Optional intended type, used to validate size/format." },
        filename: { type: "string", description: "Optional file name for the upload." },
      },
    },
  },
  {
    name: "whatsapp_get_media",
    description:
      "Get metadata for a media id (one the user sent or one you uploaded) and, by default, its content: images and stickers are returned as viewable images, audio/voice notes as audio, text files as text, and other files as base64 (up to max_bytes).",
    inputSchema: {
      type: "object",
      properties: {
        media_id: { type: "string", description: "Media id from a received message or an upload." },
        download: { type: "boolean", description: "Include the file content. Default true." },
        max_bytes: { type: "integer", description: "Max bytes of content to return inline. Default 8000000." },
      },
      required: ["media_id"],
    },
  },
  {
    name: "whatsapp_delete_media",
    description: "Delete a media object you uploaded or one that was sent to the agent.",
    inputSchema: {
      type: "object",
      properties: { media_id: { type: "string", description: "Media id to delete." } },
      required: ["media_id"],
    },
  },
  {
    name: "whatsapp_get_state",
    description: "Show the saved state for this agent: creator user id, profile name, saved read position (offset), last check time, last message ids. Also discovers the creator id if unknown.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whatsapp_set_state",
    description: "Manually set saved state: the read position (offset) and/or the creator user id (user:<id>). Use reset_offset to start fresh from 'now'.",
    inputSchema: {
      type: "object",
      properties: {
        offset: { type: "integer", description: "New saved offset." },
        reset_offset: { type: "boolean", description: "Set the saved position to the current head (skip everything waiting)." },
        creator_id: { type: "string", description: "Creator id as user:<id>." },
      },
    },
  },
  {
    name: "whatsapp_stage_media",
    description: "Copy a WhatsApp media item (e.g. a video the user sent) to a temporary public download link (Cloudflare R2, auto-deleted after ~24h). Use it to hand files to other tools or web pages (e.g. YouTube uploads) without pulling the bytes into chat.",
    inputSchema: {
      type: "object",
      properties: {
        media_id: { type: "string", description: "Media id from whatsapp_get_messages." },
        filename: { type: "string", description: "Optional file name for the link (e.g. clip1.mp4)." },
      },
      required: ["media_id"],
    },
  },
  {
    name: "whatsapp_api_request",
    description: "Low-level escape hatch: call any WhatsApp agent API path directly (e.g. GET /updates?offset=0, POST /messages with a custom JSON body). Path is relative to https://api.whatsapp.com/agent/v1.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "DELETE"] },
        path: { type: "string", description: "e.g. /messages, /updates?limit=10&timeout=0, /media/<id>" },
        body: { type: "object", description: "JSON body for POST." },
      },
      required: ["method", "path"],
    },
  },
];

// ---------- helpers ----------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const jsonText = (o, isError = false) => text(JSON.stringify(o, null, 2), isError);

class ApiError extends Error {
  constructor(status, body) {
    const e = body && body.error;
    super(`WhatsApp API ${status}${e ? ` (code ${e.code}): ${e.message}${e.error_data?.details ? " | " + e.error_data.details : ""}` : `: ${typeof body === "string" ? body : JSON.stringify(body)}`}`);
    this.status = status;
    this.code = e?.code;
    this.body = body;
  }
}

async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function etTime(unixSec) {
  try {
    return new Date(Number(unixSec) * 1000).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
  } catch {
    return undefined;
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

function splitText(body, max = LIMITS.text) {
  if (body.length <= max) return [body];
  const parts = [];
  let rest = body;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

// ---------- client ----------

class Agent {
  constructor(token, env) {
    this.token = token;
    this.env = env;
    this.kv = env.STATE;
    this.key = null;
    this.state = null;
    this.api = env.API_BASE || API;
  }

  async loadState() {
    if (this.state) return this.state;
    this.key = "agent:" + (await sha(this.token));
    let s = null;
    if (this.kv) {
      try {
        s = await this.kv.get(this.key, "json");
      } catch {}
    }
    this.state = s || {};
    return this.state;
  }
  async saveState(patch) {
    await this.loadState();
    Object.assign(this.state, patch);
    if (this.kv) await this.kv.put(this.key, JSON.stringify(this.state));
    return this.state;
  }

  async request(method, path, { json, form, query, retries = 2, retryOn = [429] } = {}) {
    let url = this.api + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.append(k, String(v));
      const q = qs.toString();
      if (q) url += (url.includes("?") ? "&" : "?") + q;
    }
    for (let attempt = 0; ; attempt++) {
      const init = { method, headers: { Authorization: `Bearer ${this.token}` } };
      if (json !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(json);
      } else if (form) {
        init.body = form;
      }
      const res = await fetch(url, init);
      if (res.status === 204) return { status: 204, body: null };
      const raw = await res.text();
      let body;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      if (res.ok) return { status: res.status, body };
      const code = body?.error?.code;
      const retryable = retryOn.includes(res.status) || (res.status === 503 && retryOn.includes(503));
      if (retryable && attempt < retries) {
        await sleep(1000 * Math.pow(3, attempt));
        continue;
      }
      throw new ApiError(res.status, body);
    }
  }

  // Poll once. Returns {status, body}
  poll({ offset, limit = 100, timeout = 0 } = {}) {
    return this.request("GET", "/updates", { query: { offset, limit, timeout }, retryOn: [429, 500] });
  }

  async ingest(body) {
    // Learn creator id/name from inbound messages.
    const v = body?.entry?.[0]?.changes?.[0]?.value;
    if (!v) return;
    const patch = {};
    for (const c of v.contacts || []) {
      if (c.wa_id?.startsWith("user:")) {
        patch.creator_id = c.wa_id;
        if (c.profile?.name) patch.creator_name = c.profile.name;
      }
    }
    const msgs = v.messages || [];
    for (const m of msgs) if (m.from?.startsWith("user:")) patch.creator_id = m.from;
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      patch.last_user_message_id = last.id;
      patch.last_user_message_at = last.timestamp;
    }
    if (body?.entry?.[0]?.id) patch.agent_id = body.entry[0].id;
    if (Object.keys(patch).length) await this.saveState(patch);
  }

  async creator(explicit) {
    if (explicit) return explicit;
    const s = await this.loadState();
    if (s.creator_id) return s.creator_id;
    // Discover from retained history.
    let offset = 0;
    for (let i = 0; i < 10; i++) {
      const r = await this.poll({ offset, limit: 100, timeout: 0 });
      if (r.status === 204 || !r.body) break;
      await this.ingest(r.body);
      if (this.state.creator_id) return this.state.creator_id;
      if (r.body.next_offset === undefined || r.body.next_offset === offset) break;
      offset = r.body.next_offset;
    }
    throw new Error(
      "Don't know the creator's user id yet. Send any message to the agent's chat in WhatsApp once (e.g. 'hi'), then try again. (Or set it with whatsapp_set_state.)"
    );
  }

  async sendRaw(to, type, payload, replyTo) {
    const msg = { messaging_product: "whatsapp", to, type, [type]: payload };
    if (replyTo) msg.context = { message_id: replyTo };
    // 429 and 503/131016 are safe to retry (not sent). 500 is ambiguous: do not retry.
    const r = await this.request("POST", "/messages", { json: msg, retryOn: [429, 503] });
    const id = r.body?.messages?.[0]?.id;
    await this.saveState({ last_sent_message_id: id, last_sent_at: Math.floor(Date.now() / 1000) });
    return { id, to: r.body?.contacts?.[0]?.wa_id || to };
  }

  async sendText({ body, preview_url, reply_to_message_id, to }) {
    if (!body) throw new Error("body is required");
    const rcpt = await this.creator(to);
    const parts = splitText(String(body));
    const sent = [];
    for (let i = 0; i < parts.length; i++) {
      const payload = { body: parts[i] };
      if (preview_url && i === 0) payload.preview_url = true;
      sent.push(await this.sendRaw(rcpt, "text", payload, i === 0 ? reply_to_message_id : undefined));
    }
    return { sent: sent.length, message_ids: sent.map((s) => s.id), to: rcpt };
  }

  async resolveFile({ url, base64, mime_type, filename, type }) {
    let bytes, mime = mime_type, name = filename;
    if (url) {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (whatsappagentmcp)" }, redirect: "follow" });
      if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
      const pathName = new URL(res.url || url).pathname;
      const base = decodeURIComponent(pathName.split("/").pop() || "");
      if (!name && base) name = base;
      if (!mime) {
        const h = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const ext = (base.split(".").pop() || "").toLowerCase();
        mime = h && h !== "application/octet-stream" && h !== "binary/octet-stream" ? h : EXT_MIME[ext] || h || undefined;
      }
    } else if (base64) {
      let b = String(base64);
      const m = b.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
      if (m) {
        if (!mime) mime = m[1];
        b = m[3];
      }
      bytes = b64ToBytes(b);
    } else {
      throw new Error("Provide url, base64 or media_id");
    }
    if (!mime && name) mime = EXT_MIME[(name.split(".").pop() || "").toLowerCase()];
    if (mime === "image/jpg") mime = "image/jpeg";
    if (!mime) throw new Error("Could not determine the MIME type; pass mime_type.");
    if (type && LIMITS.bytes[type] && bytes.length > LIMITS.bytes[type]) {
      throw new Error(`File is ${(bytes.length / 1048576).toFixed(2)} MB, over the ${type} limit of ${(LIMITS.bytes[type] / 1048576).toFixed(2)} MB.`);
    }
    if (type && ACCEPTED_MIME[type] && !ACCEPTED_MIME[type].includes(mime)) {
      // Not fatal for documents (generic binary allowed); warn others.
      if (type !== "document") {
        throw new Error(`MIME type ${mime} is not accepted for ${type}. Accepted: ${ACCEPTED_MIME[type].join(", ")}.`);
      }
    }
    return { bytes, mime, name: name || "file" };
  }

  async upload(file) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", file.mime);
    form.append("file", new Blob([file.bytes], { type: file.mime }), file.name);
    const r = await this.request("POST", "/media", { form, retryOn: [429] });
    return r.body?.id;
  }

  async sendMedia({ type, url, base64, media_id, mime_type, caption, filename, reply_to_message_id, to }) {
    if (!MEDIA_TYPES.includes(type)) throw new Error(`type must be one of ${MEDIA_TYPES.join(", ")}`);
    const rcpt = await this.creator(to);
    let id = media_id, name = filename, mime = mime_type, size;
    if (!id) {
      const file = await this.resolveFile({ url, base64, mime_type, filename, type });
      id = await this.upload(file);
      name = name || file.name;
      mime = file.mime;
      size = file.bytes.length;
    }
    const payload = { id };
    const extra = [];
    if (caption) {
      if (["image", "video", "document"].includes(type)) payload.caption = String(caption).slice(0, LIMITS.caption);
      else extra.push(caption);
    }
    if (type === "document" && name) payload.filename = name;
    const sent = await this.sendRaw(rcpt, type, payload, reply_to_message_id);
    const out = { message_id: sent.id, media_id: id, type, mime_type: mime, bytes: size, to: rcpt };
    if (caption && String(caption).length > LIMITS.caption && payload.caption) out.note = "Caption was truncated to 1024 chars.";
    if (extra.length) {
      // audio/sticker can't carry captions: send the caption as a follow-up text.
      const t = await this.sendText({ body: extra.join("\n"), to: rcpt });
      out.caption_sent_as_text = t.message_ids;
    }
    return out;
  }

  simplify(body) {
    const v = body?.entry?.[0]?.changes?.[0]?.value || {};
    const names = {};
    for (const c of v.contacts || []) if (c.profile?.name) names[c.wa_id] = c.profile.name;
    const messages = (v.messages || []).map((m) => {
      const o = { id: m.id, from: m.from, name: names[m.from], time: etTime(m.timestamp), timestamp: m.timestamp, type: m.type };
      if (m.context) o.reply_to = { id: m.context.id, from: m.context.from, by_agent: m.context.from?.startsWith("agent:") };
      if (m.type === "text") o.text = m.text?.body;
      else if (m.type === "reaction") o.reaction = { message_id: m.reaction?.message_id, emoji: m.reaction?.emoji, removed: m.reaction?.emoji === "" };
      else if (m[m.type]) {
        const p = m[m.type];
        o.media = { id: p.id, mime_type: p.mime_type, caption: p.caption, filename: p.filename, voice_note: p.voice === true || undefined, animated: p.animated, sha256: p.sha256 };
      }
      return o;
    });
    const statuses = (v.statuses || []).map((s) => ({ message_id: s.id, status: s.status, time: etTime(s.timestamp), timestamp: s.timestamp }));
    return { messages, statuses, next_offset: body?.next_offset };
  }

  async getMessages(args = {}) {
    const s = await this.loadState();
    const prevCheck = s.last_check_at;
    const prevOffset = s.offset;
    const mode = args.mode || "new";
    const limit = Math.min(Math.max(args.limit || 100, 1), 100);
    const wait = Math.min(Math.max(args.wait_seconds || 0, 0), 25);
    const maxPages = Math.min(Math.max(args.max_pages || 5, 1), 15);
    const includeStatuses = args.include_statuses !== false;

    let offset;
    let firstRun = false;
    if (mode === "recent") offset = 0;
    else if (mode === "offset") offset = args.offset ?? 0;
    else {
      if (s.offset === undefined || s.offset === null) {
        // First ever check: read retained history so nothing sent before setup is lost.
        offset = 0;
        firstRun = true;
      } else offset = s.offset;
    }

    const all = { messages: [], statuses: [] };
    const raws = [];
    let next = offset;
    for (let page = 0; page < maxPages; page++) {
      const r = await this.poll({ offset: next, limit, timeout: page === 0 ? wait : 0 });
      if (r.status === 204 || !r.body) break;
      raws.push(r.body);
      await this.ingest(r.body);
      const simp = this.simplify(r.body);
      all.messages.push(...simp.messages);
      all.statuses.push(...simp.statuses);
      if (simp.next_offset === undefined || simp.next_offset === next) break;
      next = simp.next_offset;
      if (simp.messages.length + simp.statuses.length < limit) break;
    }

    const advance = mode === "new" || (mode === "offset" && args.advance);
    if (advance) await this.saveState({ offset: next, last_check_at: Math.floor(Date.now() / 1000) });

    if (args.mark_read) {
      const mine = all.messages.filter((m) => m.from?.startsWith("user:") && m.type !== "reaction");
      const lastMsg = mine[mine.length - 1];
      if (lastMsg) {
        try {
          // Marking the latest read marks the conversation read in the app.
          await this.request("POST", "/statuses", { json: { messaging_product: "whatsapp", status: "read", message_id: lastMsg.id }, retryOn: [429, 503] });
        } catch (e) {
          all.mark_read_error = e.message;
        }
      }
    }

    const out = {
      mode,
      ...(firstRun ? { note: "First check: included retained history (up to 30 days)." } : {}),
      since_last_check: prevCheck && mode === "new" ? etTime(prevCheck) : undefined,
      count: all.messages.length,
      messages: all.messages,
      ...(includeStatuses ? { receipts: all.statuses } : {}),
      next_offset: next,
      saved_position: advance ? next : prevOffset,
      ...(all.mark_read_error ? { mark_read_error: all.mark_read_error } : {}),
    };
    if (args.include_raw) out.raw = raws;
    return out;
  }

  async status(message_id, typing) {
    const json = { messaging_product: "whatsapp", status: "read", message_id };
    if (typing) json.typing_indicator = { type: "text" };
    const r = await this.request("POST", "/statuses", { json, retryOn: [429, 503] });
    return r.body;
  }

  async mediaInfo(id) {
    const r = await this.request("GET", `/media/${encodeURIComponent(id)}`, { retryOn: [429] });
    return r.body;
  }

  async getMedia({ media_id, download = true, max_bytes = 8000000 }) {
    const meta = await this.mediaInfo(media_id);
    const info = { ...meta };
    delete info.url; // the url needs the token; don't leak it into chat logs
    if (!download) return [{ type: "text", text: JSON.stringify(info, null, 2) }];
    const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) {
      let b;
      try { b = await res.json(); } catch { b = await res.text(); }
      throw new ApiError(res.status, b);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = (meta.mime_type || res.headers.get("content-type") || "application/octet-stream").split(";")[0];
    const content = [{ type: "text", text: JSON.stringify({ ...info, downloaded_bytes: bytes.length }, null, 2) }];
    if (bytes.length > max_bytes) {
      content.push({ type: "text", text: `File is ${bytes.length} bytes, over max_bytes (${max_bytes}); content not inlined.` });
      return content;
    }
    if (mime.startsWith("image/")) content.push({ type: "image", data: bytesToB64(bytes), mimeType: mime });
    else if (mime.startsWith("audio/")) content.push({ type: "audio", data: bytesToB64(bytes), mimeType: mime });
    else if (mime.startsWith("text/") || mime === "application/json") content.push({ type: "text", text: new TextDecoder().decode(bytes) });
    else
      content.push({
        type: "resource",
        resource: { uri: `whatsapp-media://${media_id}`, mimeType: mime, blob: bytesToB64(bytes) },
      });
    return content;
  }
}

// ---------- tool dispatch ----------

async function callTool(name, args, token, env) {
  const a = new Agent(token, env);
  switch (name) {
    case "whatsapp_send_text":
      return jsonText(await a.sendText(args));
    case "whatsapp_send_media":
      return jsonText(await a.sendMedia(args));
    case "whatsapp_send_batch": {
      const items = Array.isArray(args.items) ? args.items : [];
      if (!items.length) throw new Error("items is empty");
      const results = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        try {
          const kind = it.kind || (it.type && it.type !== "text" ? "media" : "text");
          const r = kind === "media" ? await a.sendMedia({ ...it, to: args.to }) : await a.sendText({ ...it, to: args.to });
          results.push({ index: i, ok: true, ...r });
        } catch (e) {
          results.push({ index: i, ok: false, error: e.message });
          return jsonText({ sent: i, stopped_at: i, results }, true);
        }
      }
      return jsonText({ sent: results.length, results });
    }
    case "whatsapp_get_messages":
      return jsonText(await a.getMessages(args));
    case "whatsapp_mark_read":
      return jsonText(await a.status(args.message_id, !!args.typing));
    case "whatsapp_typing": {
      let id = args.message_id;
      if (!id) {
        const s = await a.loadState();
        id = s.last_user_message_id;
        if (!id) throw new Error("No message id known yet; run whatsapp_get_messages first or pass message_id.");
      }
      return jsonText({ ...(await a.status(id, true)), message_id: id, note: "Typing shows until you reply or 25s." });
    }
    case "whatsapp_upload_media": {
      const file = await a.resolveFile(args);
      const id = await a.upload(file);
      return jsonText({ media_id: id, mime_type: file.mime, bytes: file.bytes.length, filename: file.name, expires: "30 days" });
    }
    case "whatsapp_get_media":
      return { content: await a.getMedia(args) };
    case "whatsapp_delete_media": {
      const r = await a.request("DELETE", `/media/${encodeURIComponent(args.media_id)}`, { retryOn: [429] });
      return jsonText(r.body);
    }
    case "whatsapp_get_state": {
      const s = await a.loadState();
      let discovery;
      if (!s.creator_id) {
        try {
          await a.creator();
        } catch (e) {
          discovery = e.message;
        }
      }
      const st = { ...a.state };
      for (const k of ["last_check_at", "last_sent_at", "last_user_message_at"]) if (st[k]) st[k + "_et"] = etTime(st[k]);
      return jsonText({ kv_enabled: !!env.STATE, ...st, ...(discovery ? { creator_discovery: discovery } : {}) });
    }
    case "whatsapp_set_state": {
      const patch = {};
      if (args.creator_id) {
        if (!/^user:\d+$/.test(args.creator_id)) throw new Error("creator_id must look like user:<digits>");
        patch.creator_id = args.creator_id;
      }
      if (args.offset !== undefined) patch.offset = args.offset;
      if (args.reset_offset) {
        // Find head: walk from the saved offset (or 0) to the end.
        await a.loadState();
        let off = a.state.offset ?? 0;
        for (let i = 0; i < 20; i++) {
          const r = await a.poll({ offset: off, limit: 100, timeout: 0 });
          if (r.status === 204 || !r.body) break;
          await a.ingest(r.body);
          if (r.body.next_offset === undefined || r.body.next_offset === off) break;
          off = r.body.next_offset;
        }
        patch.offset = off;
      }
      return jsonText(await a.saveState(patch));
    }
    case "whatsapp_stage_media": {
      if (!env.STAGE) throw new Error("Staging bucket not configured.");
      const meta = await a.mediaInfo(args.media_id);
      const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new ApiError(res.status, await res.text());
      const ext = { "video/mp4": "mp4", "image/jpeg": "jpg", "image/png": "png", "audio/ogg": "ogg", "application/pdf": "pdf" }[(meta.mime_type || "").split(";")[0]] || "bin";
      const name = (args.filename || `${args.media_id}.${ext}`).replace(/[^A-Za-z0-9._-]/g, "_");
      const key = `${crypto.randomUUID().slice(0, 12)}/${name}`;
      await env.STAGE.put(key, res.body, { httpMetadata: { contentType: (meta.mime_type || "application/octet-stream").split(";")[0] } });
      return jsonText({ url: `${env.__ORIGIN}/stage/${key}`, bytes: meta.file_size, mime_type: meta.mime_type, expires: "~24 hours" });
    }
    case "whatsapp_api_request": {
      const method = (args.method || "GET").toUpperCase();
      let path = String(args.path || "");
      if (path.startsWith(API)) path = path.slice(API.length);
      if (!path.startsWith("/")) path = "/" + path;
      if (path.includes("..")) throw new Error("bad path");
      const r = await a.request(method, path, { json: method === "POST" ? args.body || {} : undefined, retries: 0 });
      if (path.startsWith("/updates") && r.body) await a.ingest(r.body);
      return jsonText({ status: r.status, body: r.body });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- MCP plumbing ----------

async function handleRpc(msg, token, env) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return fail(-32600, "Invalid Request");
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "WhatsApp Agent Platform: message the agent's creator on WhatsApp at any time (text, images, video, audio, documents, stickers, replies, link previews), read what they sent since the last check (whatsapp_get_messages), view their attachments (whatsapp_get_media), and show read receipts / typing. The agent can only message its creator. Rate limits: 12 sends/min, 15 polls/min.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    case "tools/call": {
      const name = params?.name;
      if (!TOOLS.find((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      if (!token) return reply(text(NO_TOKEN_MESSAGE, true));
      try {
        return reply(await callTool(name, params?.arguments || {}, token, env));
      } catch (err) {
        return reply(text(err?.message || String(err), true));
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

// Temporary public file staging (R2 bucket "agent-stage", objects expire after ~1 day).
// GET/HEAD are public with CORS so web pages can fetch staged files; PUT needs the STAGE_SECRET header.
async function handleStage(request, env, url) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Expose-Headers": "Content-Length, Content-Type" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!env.STAGE) return new Response("staging not configured", { status: 500, headers: cors });
  const key = decodeURIComponent(url.pathname.slice("/stage/".length));
  if (!key || key.includes("..")) return new Response("bad key", { status: 400, headers: cors });
  if (request.method === "PUT") {
    if (!env.STAGE_SECRET || request.headers.get("x-stage-secret") !== env.STAGE_SECRET) return new Response("forbidden", { status: 403, headers: cors });
    await env.STAGE.put(key, request.body, { httpMetadata: { contentType: request.headers.get("content-type") || "application/octet-stream" } });
    return new Response(JSON.stringify({ url: `${url.origin}/stage/${key}` }), { status: 200, headers: { "Content-Type": "application/json", ...cors } });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const obj = await env.STAGE.get(key);
    if (!obj) return new Response("not found", { status: 404, headers: cors });
    const h = { ...cors, "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream", "Content-Length": String(obj.size), "Cache-Control": "no-store" };
    return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers: h });
  }
  return new Response("method not allowed", { status: 405, headers: cors });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

export default {
  async fetch(request, env) {
    const u0 = new URL(request.url);
    env.__ORIGIN = u0.origin;
    if (u0.pathname.startsWith("/stage/")) return handleStage(request, env, u0);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "GET") {
      return new Response("whatsappagentmcp: MCP endpoint. POST JSON-RPC here with ?bearer_token=<agent API key>.", {
        status: 200,
        headers: { "Content-Type": "text/plain", ...CORS },
      });
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, GET, OPTIONS", ...CORS } });

    const url = new URL(request.url);
    let token = url.searchParams.get("bearer_token");
    if (!token) {
      const h = request.headers.get("Authorization") || "";
      if (h.toLowerCase().startsWith("bearer ")) token = h.slice(7).trim();
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    if (Array.isArray(payload)) {
      const results = [];
      for (const m of payload) {
        const r = await handleRpc(m, token, env);
        if (r) results.push(r);
      }
      return results.length ? json(results) : new Response(null, { status: 202, headers: CORS });
    }
    const result = await handleRpc(payload, token, env);
    return result ? json(result) : new Response(null, { status: 202, headers: CORS });
  },
};
