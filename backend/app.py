"""
RouteMind backend API.

Phase 1 exposes /optimize, which takes a list of stops and returns the best
visiting order straight from the OR-Tools solver.

Phase 2 adds the agent crew (see agents.py): /optimize/agents runs the whole
LangGraph pipeline and returns the final state, while /optimize/agents/stream
streams each agent's step live over Server-Sent Events for the activity panel.
"""

from __future__ import annotations

import json
from typing import AsyncIterator, List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from agents import run_agents, stream_agents
from chat import chat_turn
from solver import solve_route

app = FastAPI(title="RouteMind API", version="0.2.0")

# Allow the local Next.js dev server and any deployed frontend to call us.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Stop(BaseModel):
    id: str
    name: str
    lat: float
    lng: float
    service_min: float = 0
    window: Optional[List[float]] = Field(
        default=None,
        description="Optional [earliest, latest] minutes from midnight this stop must be reached within.",
    )


class OptimizeRequest(BaseModel):
    stops: List[Stop]
    return_to_start: bool = True
    speed_kmph: float = 30.0


class ChatRequest(OptimizeRequest):
    message: str


@app.get("/")
def health():
    return {"status": "ok", "service": "RouteMind API", "phase": 3}


@app.post("/optimize")
def optimize(req: OptimizeRequest):
    stops = [stop.model_dump() for stop in req.stops]
    result = solve_route(
        stops,
        return_to_start=req.return_to_start,
        speed_kmph=req.speed_kmph,
    )
    return result


@app.post("/optimize/agents")
async def optimize_agents(req: OptimizeRequest):
    """Run the whole agent crew once and return the final state, including the
    solver result and each agent's plain-English message."""
    stops = [stop.model_dump() for stop in req.stops]
    return await run_agents(stops, req.return_to_start, req.speed_kmph)


@app.post("/optimize/agents/stream")
async def optimize_agents_stream(req: OptimizeRequest):
    """Stream the crew's steps live over Server-Sent Events. Each agent emits
    one event as it finishes, then a final result event."""
    stops = [stop.model_dump() for stop in req.stops]

    async def event_source() -> AsyncIterator[bytes]:
        try:
            async for event in stream_agents(
                stops, req.return_to_start, req.speed_kmph
            ):
                yield f"data: {json.dumps(event)}\n\n".encode()
        except Exception as exc:  # surface failures to the panel, don't hang
            payload = {"type": "error", "message": str(exc)}
            yield f"data: {json.dumps(payload)}\n\n".encode()

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/chat")
async def chat(req: ChatRequest):
    """Phase 3: interpret a plain-English change to the run, apply it, re-solve,
    and explain what changed and what it cost."""
    stops = [stop.model_dump() for stop in req.stops]
    return await chat_turn(req.message, stops, req.return_to_start, req.speed_kmph)
