# RouteMind chat brain on n8n

This makes the chat **interpreted by an n8n workflow** in real time. n8n is the
"brain" (it reads the message + run state and decides a structured edit, or answers
a question); the RouteMind backend stays the route-math engine (it applies edits and
re-solves with OR-Tools).

```
Frontend chat ──POST──▶ n8n webhook (Claude) ──▶ { kind, reply, action }
       │                                                    │
       │  edits: POST /chat/apply ◀───────────────────────┘
       ▼
  local backend applies + re-solves (OR-Tools) ──▶ new route + cost
```

Because n8n Cloud is on the public internet and can't reach `localhost:8000`, the
deterministic apply/solve happens locally in the browser→backend hop. n8n only does
interpretation and question-answering, so **no tunnel is needed**.

## Setup (n8n Cloud)

1. **Import the workflow.** In n8n: *Workflows → Import from File →*
   `routemind-chat-workflow.json`.

2. **Attach an Anthropic credential.** Open the **Anthropic Chat Model** node →
   *Credential to connect with* → create/select your Anthropic API key. (The imported
   `credentials.id` is a placeholder and must be replaced by selecting your own.)
   Adjust the `model` if `claude-haiku-4-5-20251001` isn't offered in your list.

3. **Check CORS on the webhook.** Open the **Chat Webhook** node → *Options →
   Allowed Origins (CORS)*. It's set to `*`; for production, restrict it to your
   frontend's origin (e.g. `http://localhost:3000` or your deployed domain).
   Without this, the browser will block the request.

4. **Activate the workflow** (toggle top-right). Only active workflows serve the
   **Production** webhook URL.

5. **Copy the Production webhook URL.** From the **Chat Webhook** node, copy the
   *Production URL* — it looks like:
   `https://<your-subdomain>.app.n8n.cloud/webhook/routemind-chat`

6. **Point the frontend at it.** In `routemind/frontend/.env.local`:
   ```
   NEXT_PUBLIC_N8N_CHAT_URL=https://<your-subdomain>.app.n8n.cloud/webhook/routemind-chat
   ```
   Then restart `next dev` (env vars are read at build/start).

That's it. The chat header will show a **"via n8n"** badge, and each message will
run through your workflow. Leave `NEXT_PUBLIC_N8N_CHAT_URL` blank to fall back to the
built-in backend `/chat`.

## Bring your own workflow

You don't have to import the sample — point `NEXT_PUBLIC_N8N_CHAT_URL` at **any**
n8n workflow whose webhook honors the contract below. The frontend is deliberately
tolerant, so a drag-and-drop workflow can return whatever's easiest.

### What your webhook receives

POST JSON body, available in the workflow as `$json.body`:
```json
{
  "message": "drop the senior center",
  "stops": [ { "id": "s1", "name": "Sunrise Senior Center", "lat": 37.35, "lng": -121.95, "service_min": 15, "window": [660, 750] } ],
  "return_to_start": true,
  "result": { "ok": true, "total_distance_m": 12345, "total_time_min": 42, "ordered_stop_ids": ["depot","s2"], "arrivals_min": [540, 560] }
}
```
`stops`, `return_to_start`, and the last solved `result` are included so your LLM can
answer with real sites, windows, ETAs, and totals.

### What your webhook returns

**To answer a question** — return *any* of these (the frontend shows the text):
- a bare string: `"Leaving 20 min early is a safe buffer."`
- an object with any of these keys: `reply`, `output`, `answer`, `text`, `message`, `content`
  ```json
  { "reply": "Leaving 20 min early is a safe buffer for the 9am window." }
  ```
  (`output` is what n8n's AI Agent node emits by default, so a bare Agent → Respond
  wiring just works.)

**To edit the route** — return an edit `kind` with its fields, either nested under
`action` or inline at the top level. Missing fields default to sentinels, so only
send what the edit needs:

| kind          | fields needed                                  |
|---------------|------------------------------------------------|
| `remove`      | `site_query`                                   |
| `reorder`     | `site_query`, `position` (`"first"`\|`"last"`) |
| `set_window`  | `site_query`, `window_start_min`, `window_end_min` (minutes from midnight), or `clear_window: true` |
| `set_service` | `site_query`, `service_min`                    |
| `set_return`  | `return_value` (`true`/`false`)                |
| `reoptimize`  | (none)                                         |

```json
{ "kind": "remove", "site_query": "senior center" }
```
```json
{ "action": { "kind": "set_window", "site_query": "shelter", "window_start_min": 480, "window_end_min": 540 } }
```

When your response is an edit, the frontend forwards it to the backend
`POST /chat/apply`, which applies it, re-solves with OR-Tools, and returns the new
route + real cost delta (your `reply` text is not needed for edits — the backend
writes the cost explanation). When it's not an edit, the text is shown as the answer.
Times are **minutes from midnight** (9:00 am = 540, noon = 720, 2:30 pm = 870).

> The frontend also unwraps n8n's common `[{ ... }]` / `[{ "json": { ... } }]`
> wrappers, so you don't have to flatten before the Respond node.

## Notes / troubleshooting

- **Node versions.** The JSON pins reasonable `typeVersion`s; if your n8n is newer/older,
  n8n usually imports fine but double-check each node opens without an "unknown node"
  error. The workflow uses standard nodes: Webhook, AI Agent (`@n8n/n8n-nodes-langchain.agent`),
  Anthropic Chat Model (`@n8n/n8n-nodes-langchain.lmChatAnthropic`), Code, Respond to Webhook.
- **Model returns prose instead of JSON?** The **Parse JSON** Code node strips ```` ```json ````
  fences and falls back to `kind: "unknown"` if parsing fails, so the chat degrades
  gracefully rather than erroring.
- **CORS error in the browser Network tab** → fix step 3 (Allowed Origins).
- **Backend must be running** for edits (`/chat/apply`), even with n8n interpreting.
