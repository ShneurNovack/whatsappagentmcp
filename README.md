# whatsappagentmcp

MCP server for the **WhatsApp Agent Platform** (`https://api.whatsapp.com/agent/v1`, developer manual v1, Aug 25 2026), running on Cloudflare Workers.

It lets Claude message the agent's creator on WhatsApp any time and read what they send back.

## Connect

Add a custom connector in Claude with this URL:

```
https://whatsappagentmcp.shneur.workers.dev/?bearer_token=<AGENT_API_KEY>
```

Get the key in WhatsApp: Settings > Agents > (your agent) > open its chat > Chat info > API key. Send the agent any message once so the server can learn your user id.

## Tools

| Tool | What it does |
| --- | --- |
| `whatsapp_send_text` | Text with WhatsApp formatting, link previews, reply-quoting; auto-splits over 4096 chars |
| `whatsapp_send_media` | Image, video, audio, document or sticker from a URL, base64 or media id, with caption/filename/reply |
| `whatsapp_send_batch` | Several text/media messages in order |
| `whatsapp_get_messages` | Messages + receipts since the last check (saved position), or full 30-day history, optional long-poll and mark-read |
| `whatsapp_get_media` | Metadata + content of an attachment (images/audio inline, text as text, other files as blobs) |
| `whatsapp_mark_read` | Blue ticks, optional typing indicator |
| `whatsapp_typing` | Typing indicator on the latest message |
| `whatsapp_upload_media` | Upload a file, get a media id |
| `whatsapp_delete_media` | Delete a media object |
| `whatsapp_get_state` / `whatsapp_set_state` | Saved creator id, read position, last activity |
| `whatsapp_api_request` | Raw call to any agent API path |

State (read position, creator id) is stored in KV (`STATE` binding), keyed by a hash of the token. The token itself is never stored.

Limits from the API: 12 sends/min, 15 polls/min, 12/min per media method. The agent can only message its creator.

## Deploy

Pushes to `main` deploy automatically through Cloudflare Workers Builds (`npx wrangler deploy`).
