"""
Phase 2: the agent crew.

A small team of agents coordinates a route plan and explains it in plain
English. The division of labour is the whole point of RouteMind:

    - the AGENTS handle language, coordination, and explanation, and
    - the SOLVER (OR-Tools, in solver.py) does the actual route math.

The agents are wired together with LangGraph as a linear pipeline:

    planner -> data -> conditions -> optimizer -> explainer

Only the optimizer touches the real math; it calls solve_route. Everything
else is a fast language model turning numbers and rules into sentences.

The language model is deliberately a FAST hosted model (Claude Haiku 4.5 by
default) because the steps stream live into the UI and latency matters. Set
ROUTEMIND_MODEL to a bigger model (for example claude-opus-5) if you would
rather trade speed for depth. If no ANTHROPIC_API_KEY is present, every agent
falls back to a deterministic template so the app still runs end to end.
"""

from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator, List, Optional, TypedDict

from langgraph.graph import END, START, StateGraph

from solver import solve_route

MODEL = os.environ.get("ROUTEMIND_MODEL", "claude-haiku-4-5")

# One Anthropic client for the whole process, created lazily so the app boots
# fine without the SDK key. When it is None, agents use template text.
_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        from anthropic import AsyncAnthropic

        _client = AsyncAnthropic()
        return _client
    except Exception:
        return None


async def _llm(system: str, user: str) -> Optional[str]:
    """Ask the fast model for one short line. Returns None on any failure so
    the caller can fall back to a template."""
    client = _get_client()
    if client is None:
        return None
    try:
        msg = await client.messages.create(
            model=MODEL,
            max_tokens=200,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        parts = [b.text for b in msg.content if getattr(b, "type", None) == "text"]
        text = " ".join(parts).strip()
        return text or None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Shared state that flows through the graph. Each agent adds its own field.
# ---------------------------------------------------------------------------
class State(TypedDict, total=False):
    stops: List[dict]
    return_to_start: bool
    speed_kmph: float
    window_rules: List[str]
    result: dict
    # One message per agent, keyed by the agent name via NODE_META below.
    plan: str
    data_summary: str
    condition_text: str
    optimize_summary: str
    explanation: str


def _window_rules(stops: List[dict]) -> List[str]:
    """Pull the human-readable time-window rules out of the stops."""
    rules: List[str] = []
    for s in stops:
        w = s.get("window")
        if w:
            rules.append(
                f"{s.get('name', 'A stop')} between {_fmt(w[0])} and {_fmt(w[1])}"
            )
    return rules


def _fmt(minutes: float) -> str:
    total = int(round(minutes))
    hours = (total // 60) % 24
    mins = total % 60
    suffix = "am" if hours < 12 else "pm"
    hour12 = hours % 12 or 12
    return f"{hour12}:{mins:02d} {suffix}"


async def _pause_if_templated() -> None:
    """Without a live model the template path is instant, which makes the live
    panel flash by. A tiny pause keeps the streaming legible in the demo."""
    if _get_client() is None:
        await asyncio.sleep(0.4)


# ---------------------------------------------------------------------------
# The agents.
# ---------------------------------------------------------------------------
async def planner(state: State) -> dict:
    sites = max(len(state["stops"]) - 1, 0)
    rules = _window_rules(state["stops"])
    plan = await _llm(
        "You are the Planner in a food-bank delivery crew. In ONE short "
        "sentence, state the plan for turning these delivery sites into the "
        "shortest van run. Do not do any math or invent numbers.",
        f"There are {sites} delivery sites. Serving windows: {rules or 'none'}. "
        f"Return to the food bank: {state['return_to_start']}.",
    )
    if plan is None:
        rule_note = f" while hitting {len(rules)} serving window(s)" if rules else ""
        plan = (
            f"Plan: gather the {sites} delivery sites, apply the serving "
            f"windows, hand them to the solver, and explain the shortest "
            f"run{rule_note}."
        )
        await _pause_if_templated()
    return {"plan": plan}


async def data_agent(state: State) -> dict:
    stops = state["stops"]
    base = stops[0]["name"] if stops else "the food bank"
    sites = max(len(stops) - 1, 0)
    windowed = sum(1 for s in stops if s.get("window"))
    summary = await _llm(
        "You are the Data agent. In ONE short sentence, confirm the delivery "
        "sites are ready for routing. Be concrete and do not invent details.",
        f"{sites} delivery sites, starting from '{base}' (the base). "
        f"{windowed} of them have a serving window.",
    )
    if summary is None:
        summary = (
            f"Loaded {sites} delivery sites from base {base}"
            + (f", {windowed} with a serving window." if windowed else ".")
        )
        await _pause_if_templated()
    return {"data_summary": summary}


async def conditions(state: State) -> dict:
    rules = _window_rules(state["stops"])
    text = await _llm(
        "You are the Conditions agent. Restate the serving-window rules in ONE "
        "short, friendly sentence. If there are none, say there are no serving "
        "windows. Do not invent times.",
        f"Serving windows: {rules or 'none'}.",
    )
    if text is None:
        text = (
            "No serving windows to hit."
            if not rules
            else "Serving windows to hit: " + "; ".join(rules) + "."
        )
        await _pause_if_templated()
    return {"window_rules": rules, "condition_text": text}


async def optimizer(state: State) -> dict:
    """The one agent that does real math: it calls the OR-Tools solver."""
    result = await asyncio.to_thread(
        solve_route,
        state["stops"],
        return_to_start=state["return_to_start"],
        speed_kmph=state.get("speed_kmph", 30.0),
    )
    if not result.get("ok"):
        summary = result.get("reason", "The solver could not find a route.")
    else:
        by_id = {s["id"]: s for s in state["stops"]}
        order = [by_id[i]["name"] for i in result.get("ordered_stop_ids", [])]
        km = round(result.get("total_distance_m", 0) / 1000, 1)
        mins = result.get("total_time_min", 0)
        summary = (
            f"Best run: {' -> '.join(order)}. "
            f"{km} km, about {mins} min of driving."
        )
    return {"result": result, "optimize_summary": summary}


async def explainer(state: State) -> dict:
    result = state.get("result", {})
    if not result.get("ok"):
        text = await _llm(
            "You are the Explainer. In ONE short, kind sentence, tell the "
            "driver the run could not be planned and suggest widening a serving "
            "window or dropping a site.",
            f"Reason: {result.get('reason', 'unknown')}.",
        )
        if text is None:
            text = (
                "No run fits every serving window. Try widening a window or "
                "dropping a site."
            )
            await _pause_if_templated()
        return {"explanation": text}

    km = round(result.get("total_distance_m", 0) / 1000, 1)
    mins = result.get("total_time_min", 0)
    rules = state.get("window_rules", [])
    text = await _llm(
        "You are the Explainer. In 1-2 short sentences, explain the delivery "
        "run to a non-technical driver: the total distance and drive time, and "
        "why the order reaches each site inside its serving window. Use ONLY "
        "the numbers given; do not invent any.",
        f"Total distance: {km} km. Drive time: {mins} min. "
        f"Serving windows met: {rules or 'none'}.",
    )
    if text is None:
        rule_note = (
            f" The order was arranged so the van reaches {rules[0]}." if rules else ""
        )
        text = (
            f"The run covers {km} km in about {mins} minutes of driving."
            f"{rule_note}"
        )
        await _pause_if_templated()
    return {"explanation": text}


# ---------------------------------------------------------------------------
# Wire the agents into a LangGraph pipeline.
# ---------------------------------------------------------------------------
def build_graph():
    g = StateGraph(State)
    g.add_node("planner", planner)
    g.add_node("data", data_agent)
    g.add_node("conditions", conditions)
    g.add_node("optimizer", optimizer)
    g.add_node("explainer", explainer)
    g.add_edge(START, "planner")
    g.add_edge("planner", "data")
    g.add_edge("data", "conditions")
    g.add_edge("conditions", "optimizer")
    g.add_edge("optimizer", "explainer")
    g.add_edge("explainer", END)
    return g.compile()


# Public description of the crew, and which state field holds each agent's
# message. The frontend uses the labels/roles; the streamer uses the keys.
NODE_META = {
    "planner": {"label": "Planner", "role": "Sets the plan", "key": "plan"},
    "data": {"label": "Data", "role": "Prepares the sites", "key": "data_summary"},
    "conditions": {
        "label": "Conditions",
        "role": "Reads serving windows",
        "key": "condition_text",
    },
    "optimizer": {
        "label": "Optimizer",
        "role": "Runs OR-Tools",
        "key": "optimize_summary",
    },
    "explainer": {
        "label": "Explainer",
        "role": "Explains the run",
        "key": "explanation",
    },
}

AGENTS_PUBLIC = [
    {"id": nid, "label": m["label"], "role": m["role"]}
    for nid, m in NODE_META.items()
]

_graph = build_graph()


async def run_agents(
    stops: List[dict], return_to_start: bool, speed_kmph: float = 30.0
) -> dict:
    """Run the whole crew once and return the final state (non-streaming)."""
    return await _graph.ainvoke(
        {
            "stops": stops,
            "return_to_start": return_to_start,
            "speed_kmph": speed_kmph,
        }
    )


async def stream_agents(
    stops: List[dict], return_to_start: bool, speed_kmph: float = 30.0
) -> AsyncIterator[dict]:
    """Run the crew and yield one event per agent as it finishes, so the UI can
    light up the activity panel step by step."""
    yield {
        "type": "pipeline",
        "agents": AGENTS_PUBLIC,
        "model": MODEL,
        "live": _get_client() is not None,
    }

    init: State = {
        "stops": stops,
        "return_to_start": return_to_start,
        "speed_kmph": speed_kmph,
    }
    result: Optional[dict] = None

    async for chunk in _graph.astream(init, stream_mode="updates"):
        for node, delta in chunk.items():
            meta = NODE_META.get(node)
            if not meta:
                continue
            if node == "optimizer":
                result = delta.get("result")
            yield {
                "type": "agent",
                "agent": node,
                "label": meta["label"],
                "role": meta["role"],
                "status": "done",
                "message": delta.get(meta["key"], ""),
            }

    yield {"type": "result", "result": result}
    yield {"type": "done"}
