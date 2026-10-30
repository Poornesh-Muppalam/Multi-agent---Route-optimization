import type {
  Stop,
  RouteResult,
  AgentEvent,
  ChatAction,
  ChatBrain,
  ChatResponse,
} from "./types";

const BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:8000";

// When set, the chat brain lives in an n8n workflow (see routemind/n8n/). The
// frontend sends each message there for interpretation; the deterministic
// apply + re-solve still happens in the local backend via /chat/apply. When
// unset, we fall back to the all-in-one backend /chat endpoint.
const N8N_CHAT_URL = process.env.NEXT_PUBLIC_N8N_CHAT_URL;

// Which brain powers the chat (Gemini / Groq / Claude / Ollama / Rules).
export async function getChatBrain(): Promise<ChatBrain> {
  const res = await fetch(`${BASE}/chat/info`);
  if (!res.ok) throw new Error(`Backend responded with ${res.status}`);
  return res.json();
}

export async function optimizeRoute(
  stops: Stop[],
  returnToStart: boolean,
  departMin?: number
): Promise<RouteResult> {
  const res = await fetch(`${BASE}/optimize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stops, return_to_start: returnToStart, depart_min: departMin ?? null }),
  });
  if (!res.ok) {
    throw new Error(`Backend responded with ${res.status}`);
  }
  return res.json();
}

// Phase 2: run the agent crew and receive its steps live. The backend streams
// Server-Sent Events; we read the response body and hand each parsed event to
// onEvent as it arrives, so the UI can light up the activity panel in real time.
export async function streamAgents(
  stops: Stop[],
  returnToStart: boolean,
  onEvent: (event: AgentEvent) => void,
  departMin?: number
): Promise<void> {
  const res = await fetch(`${BASE}/optimize/agents/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stops, return_to_start: returnToStart, depart_min: departMin ?? null }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Backend responded with ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as AgentEvent);
      } catch {
        // ignore a partial or malformed frame
      }
    }
  }
}

// Phase 3: send a plain-English change to the run and get back the applied
// edit, the re-solved route, and an explanation of what it cost.
//
// If NEXT_PUBLIC_N8N_CHAT_URL is set, the message is interpreted by the n8n
// workflow (the "brain"); edits are then applied + re-solved by the backend
// (/chat/apply), while questions are answered by n8n directly. Otherwise we use
// the all-in-one backend /chat endpoint.
export async function sendChat(
  stops: Stop[],
  returnToStart: boolean,
  message: string,
  result?: RouteResult | null,
  departMin?: number
): Promise<ChatResponse> {
  if (N8N_CHAT_URL) {
    return sendChatViaN8n(stops, returnToStart, message, result, departMin);
  }
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stops, return_to_start: returnToStart, message, depart_min: departMin ?? null }),
  });
  if (!res.ok) {
    throw new Error(`Backend responded with ${res.status}`);
  }
  return res.json();
}

// The route-editing action kinds the backend can apply. Anything else is
// treated as a plain answer from the workflow.
const EDIT_KINDS = new Set([
  "remove",
  "set_window",
  "set_service",
  "reorder",
  "set_return",
  "reoptimize",
]);

// Send the message to a custom n8n workflow (the "brain") and normalize whatever
// it returns. The workflow is intentionally free-form: it may return a bare
// string, or an object using any of several common reply keys, and it may
// optionally include a structured edit (nested `action`, or edit fields inline
// alongside an edit `kind`). When it returns an edit, the backend applies it and
// re-solves; otherwise the reply is shown as an answer.
async function sendChatViaN8n(
  stops: Stop[],
  returnToStart: boolean,
  message: string,
  result?: RouteResult | null,
  departMin?: number
): Promise<ChatResponse> {
  const res = await fetch(N8N_CHAT_URL as string, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      stops,
      return_to_start: returnToStart,
      result: result ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(`n8n responded with ${res.status}`);
  }

  // Accept JSON or plain text; unwrap the array/{json} wrappers n8n often adds.
  const rawText = await res.text();
  let payload: unknown = rawText;
  try {
    payload = JSON.parse(rawText);
  } catch {
    // not JSON — leave payload as the raw string
  }
  payload = unwrapN8n(payload);

  // If the workflow decided a route edit, apply it in the backend (which owns
  // the OR-Tools math and computes the real cost).
  const action = extractAction(payload);
  if (action) {
    return applyAction(action, stops, returnToStart, undefined, departMin);
  }

  // Otherwise treat it as an answer. `kind: "unknown"` (if provided) marks it bad.
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const kind = typeof obj?.kind === "string" ? (obj.kind as string) : "ask";
  const reply = extractReply(payload);
  if (!reply) {
    return {
      ok: false,
      kind: "unknown",
      reply: "The n8n workflow didn't return an answer. Check the workflow's Respond node.",
    };
  }
  return { ok: kind !== "unknown", kind, reply };
}

// n8n commonly wraps output as [{ ... }] or [{ json: { ... } }]; peel one layer.
function unwrapN8n(p: unknown): unknown {
  let cur = p;
  if (Array.isArray(cur)) cur = cur[0];
  if (cur && typeof cur === "object" && "json" in (cur as Record<string, unknown>)) {
    cur = (cur as Record<string, unknown>).json;
  }
  return cur;
}

// Pull an answer string out of a string payload or the usual reply keys.
function extractReply(p: unknown): string {
  if (typeof p === "string") return p.trim();
  if (!p || typeof p !== "object") return "";
  const o = p as Record<string, unknown>;
  const val = o.reply ?? o.output ?? o.answer ?? o.text ?? o.message ?? o.content;
  return typeof val === "string" ? val.trim() : "";
}

// Pull a structured edit out of a nested `action`, or inline edit fields sitting
// next to an edit `kind`. Returns null if it's not an edit.
function extractAction(p: unknown): ChatAction | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  // A nested action counts only if ITS kind is a real edit kind — workflows
  // often include an action object even for questions (with kind "ask").
  const nested = o.action;
  if (nested && typeof nested === "object") {
    const nk = (nested as Record<string, unknown>).kind;
    if (typeof nk === "string" && EDIT_KINDS.has(nk)) {
      return normalizeAction(nested as Record<string, unknown>);
    }
  }
  if (typeof o.kind === "string" && EDIT_KINDS.has(o.kind)) {
    return normalizeAction(o);
  }
  return null;
}

// Fill any missing fields with the backend's sentinels and coerce loose types,
// so a hand-built workflow only has to supply the fields its edit needs.
function normalizeAction(a: Record<string, unknown>): ChatAction {
  return {
    kind: String(a.kind),
    site_query: typeof a.site_query === "string" ? a.site_query : "",
    window_start_min: toNum(a.window_start_min, -1),
    window_end_min: toNum(a.window_end_min, -1),
    clear_window: a.clear_window === true || a.clear_window === "true",
    service_min: toNum(a.service_min, -1),
    position: a.position === "first" || a.position === "last" ? a.position : "none",
    return_value: coerceReturn(a.return_value),
    note: typeof a.note === "string" ? a.note : "",
  };
}

function toNum(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function coerceReturn(v: unknown): "true" | "false" | "none" {
  if (v === true || v === "true") return "true";
  if (v === false || v === "false") return "false";
  return "none";
}

// Apply a structured edit (from the n8n brain) via the backend, which re-solves
// with OR-Tools and returns the real cost/delta.
export async function applyAction(
  action: ChatAction,
  stops: Stop[],
  returnToStart: boolean,
  speedKmph?: number,
  departMin?: number
): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/chat/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      stops,
      return_to_start: returnToStart,
      depart_min: departMin ?? null,
      ...(speedKmph != null ? { speed_kmph: speedKmph } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Backend responded with ${res.status}`);
  }
  return res.json();
}
