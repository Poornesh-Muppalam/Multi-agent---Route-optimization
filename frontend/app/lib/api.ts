import type { Stop, RouteResult, AgentEvent } from "./types";

const BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:8000";

export async function optimizeRoute(
  stops: Stop[],
  returnToStart: boolean
): Promise<RouteResult> {
  const res = await fetch(`${BASE}/optimize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stops, return_to_start: returnToStart }),
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
  onEvent: (event: AgentEvent) => void
): Promise<void> {
  const res = await fetch(`${BASE}/optimize/agents/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stops, return_to_start: returnToStart }),
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
