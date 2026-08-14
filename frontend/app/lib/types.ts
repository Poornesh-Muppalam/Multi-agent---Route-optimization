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
  distance_km: number;
  time_min: number;
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
  | { type: "result"; result: RouteResult }
  | { type: "done" }
  | { type: "error"; message: string };
