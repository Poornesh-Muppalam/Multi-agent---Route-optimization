export interface Stop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  service_min?: number;
  window?: [number, number] | null;
}

export interface Leg {
  from: string;
  to: string;
  distance_m: number;
  time_min: number;
}

export interface RouteResult {
  ok: boolean;
  reason?: string;
  order?: number[];
  ordered_stop_ids?: string[];
  legs?: Leg[];
  total_distance_m?: number;
  total_time_min?: number;
  arrivals_min?: number[];
  binding_rules?: string[];
  returned_to_start?: boolean;
  distance_source?: "road" | "estimate";
}

// Phase 2: the agent crew.
export interface AgentInfo {
  id: string;
  label: string;
  role: string;
}

// Phase 3: the chat.
export interface ChatDelta {
  distance_mi: number;
  time_min: number;
}

// Which brain powers the chat, from GET /chat/info.
export interface ChatBrain {
  live: boolean;
  provider: string;
  label: string;
  model: string | null;
}

// A structured edit, mirroring backend chat.ACTION_SCHEMA. Decided by the n8n
// brain and handed to the backend's /chat/apply for the deterministic re-solve.
export interface ChatAction {
  kind: string;
  site_query: string;
  window_start_min: number;
  window_end_min: number;
  clear_window: boolean;
  service_min: number;
  position: "first" | "last" | "none";
  return_value: "true" | "false" | "none";
  note: string;
}

// What the n8n webhook returns: the interpreted kind, a natural-language reply
// (for ask/unknown), and the structured action (for edits).
export interface N8nInterpretResponse {
  kind: string;
  reply?: string;
  action?: ChatAction;
}

// Response from POST /chat.
export interface ChatResponse {
  ok: boolean;
  kind: string;
  summary?: string;
  reply: string;
  delta?: ChatDelta;
  stops?: Stop[];
  return_to_start?: boolean;
  result?: RouteResult;
}

// A message in the on-screen chat log.
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  delta?: ChatDelta;
  ok?: boolean;
  // On a failed assistant reply, the user message that produced it — so the
  // driver can retry the exact same request with one click.
  retryText?: string;
}

// An auto-repair the Diagnostician applied to make an infeasible run solvable.
// Previewed in the UI so the driver can keep or revert it.
export interface Repair {
  kind: "depart" | "widen_window" | "drop_site";
  description: string;
  original_reason: string;
  stops: Stop[];
  return_to_start: boolean;
  depart_min: number;
}

// Events streamed from /optimize/agents/stream over Server-Sent Events.
export type AgentEvent =
  | { type: "pipeline"; agents: AgentInfo[]; model: string; live: boolean }
  | {
      type: "agent";
      agent: string;
      label: string;
      role: string;
      status: "done";
      message: string;
    }
  | { type: "result"; result: RouteResult; repair?: Repair | null }
  | { type: "done" }
  | { type: "error"; message: string };
