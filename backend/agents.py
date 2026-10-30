"""
Phase 2: the agent crew — analysts that actually do work.

Each agent has a real, decision-making job backed by computation (so it works
even with no API key); the language model only narrates the reasoning:

    validator -> feasibility -> optimizer -> diagnostician -> advisor

    - Validator      judges the input: out-of-area / duplicate / outlier sites,
                     implausible drop times.
    - Feasibility    predicts window conflicts BEFORE solving.
    - Optimizer      does the real math (OR-Tools, solver.py).
    - Diagnostician  REACTS: on failure it runs a minimal-impact fix ladder
                     (shift departure -> widen a window -> drop a site), applies
                     the first fix that works, and returns a repaired route to
                     preview. On success it judges quality (flags a
                     disproportionately costly site).
    - Advisor        synthesizes it all into one recommendation.

The model is a FAST hosted model (Claude Haiku 4.5 by default) because steps
stream live into the UI. Set ROUTEMIND_MODEL for a bigger model. With no
ANTHROPIC_API_KEY every agent falls back to its computed, deterministic finding.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import AsyncIterator, List, Optional, Tuple, TypedDict

from langgraph.graph import END, START, StateGraph

from solver import _now_minutes, haversine_meters, solve_route

# The chat/agent LLM is provider-agnostic. Preferred path is any OpenAI-compatible
# endpoint (Groq, Google Gemini's OpenAI endpoint, a local Ollama, ...): set
# LLM_BASE_URL + LLM_API_KEY + LLM_MODEL. Anthropic is a legacy fallback via
# ANTHROPIC_API_KEY. With none set, agents/chat fall back to their deterministic
# (rule-based / template) logic — the app still runs fully.
MODEL = os.environ.get("LLM_MODEL") or os.environ.get("ROUTEMIND_MODEL", "claude-haiku-4-5")

# Matches the frontend service area (Northern California, within 130 mi of base).
SERVICE_RADIUS_MI = 130

_client = None
_PROVIDER: Optional[str] = None  # "openai" | "anthropic" | None


def _get_client():
    """Return the active LLM client (lazily), preferring an OpenAI-compatible
    provider, then Anthropic. Returns None when no key is configured."""
    global _client, _PROVIDER
    if _client is not None:
        return _client

    base = os.environ.get("LLM_BASE_URL")
    key = os.environ.get("LLM_API_KEY")
    if base and key:
        try:
            from openai import AsyncOpenAI

            _client = AsyncOpenAI(base_url=base, api_key=key)
            _PROVIDER = "openai"
            return _client
        except Exception:
            pass

    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            from anthropic import AsyncAnthropic

            _client = AsyncAnthropic()
            _PROVIDER = "anthropic"
            return _client
        except Exception:
            pass

    return None


def brain_info() -> dict:
    """Describe the active chat/agent brain for the UI (provider label + model)."""
    client = _get_client()  # also resolves _PROVIDER
    if client is None:
        return {"live": False, "provider": "rules", "label": "Rules", "model": None}
    base = (os.environ.get("LLM_BASE_URL") or "").lower()
    model = (MODEL or "").lower()
    if _PROVIDER == "anthropic":
        label, provider = "Claude", "anthropic"
    elif "groq" in base:
        label, provider = "Groq", "groq"
    elif "generativelanguage.googleapis" in base or "gemini" in model:
        label, provider = "Gemini", "gemini"
    elif "openai.com" in base:
        label, provider = "OpenAI", "openai"
    elif "11434" in base or "localhost" in base or "127.0.0.1" in base:
        label, provider = "Ollama", "ollama"
    else:
        label, provider = "LLM", "openai"
    return {"live": True, "provider": provider, "label": label, "model": MODEL}


async def _llm(system: str, user: str) -> Optional[str]:
    """Ask the model for one short line. Returns None on any failure so the
    caller can fall back to its computed finding."""
    client = _get_client()
    if client is None:
        return None
    try:
        if _PROVIDER == "anthropic":
            msg = await client.messages.create(
                model=MODEL,
                max_tokens=200,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            parts = [b.text for b in msg.content if getattr(b, "type", None) == "text"]
            text = " ".join(parts).strip()
        else:  # OpenAI-compatible (Groq / Gemini / Ollama / OpenAI)
            resp = await client.chat.completions.create(
                model=MODEL,
                max_tokens=220,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
            text = (resp.choices[0].message.content or "").strip()
        return text or None
    except Exception:
        return None


async def _llm_json(system: str, user: str) -> Optional[dict]:
    """Ask the model for a JSON object and return it parsed, or None on failure.
    Uses the provider's JSON mode; the system prompt must name the exact keys."""
    client = _get_client()
    if client is None:
        return None
    try:
        if _PROVIDER == "anthropic":
            msg = await client.messages.create(
                model=MODEL,
                max_tokens=400,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
        else:  # OpenAI-compatible JSON mode
            resp = await client.chat.completions.create(
                model=MODEL,
                max_tokens=400,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
            text = resp.choices[0].message.content or ""
        text = text.strip()
        match = re.search(r"\{.*\}", text, re.S)  # tolerate stray prose/fences
        if match:
            text = match.group(0)
        return json.loads(text)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Shared state that flows through the graph.
# ---------------------------------------------------------------------------
class State(TypedDict, total=False):
    stops: List[dict]
    return_to_start: bool
    speed_kmph: float
    depart_min: Optional[int]
    # agent outputs
    issues: List[str]
    validation: str
    feasibility: str
    result: dict
    optimize_summary: str
    diagnosis: str
    repair: Optional[dict]
    advice: str


# ---------------------------------------------------------------------------
# Helpers (shared, deterministic).
# ---------------------------------------------------------------------------
def _fmt(minutes: float) -> str:
    total = int(round(minutes))
    hours = (total // 60) % 24
    mins = total % 60
    suffix = "am" if hours < 12 else "pm"
    hour12 = hours % 12 or 12
    return f"{hour12}:{mins:02d} {suffix}"


def _sites(stops: List[dict]) -> List[dict]:
    return [s for s in stops if s.get("id") != "depot"]


def _base(stops: List[dict]) -> Optional[dict]:
    return next((s for s in stops if s.get("id") == "depot"), stops[0] if stops else None)


def _window_rules(stops: List[dict]) -> List[str]:
    rules: List[str] = []
    for s in stops:
        w = s.get("window")
        if w:
            rules.append(f"{s.get('name', 'A stop')} between {_fmt(w[0])} and {_fmt(w[1])}")
    return rules


def _effective_depart_min(state: State) -> int:
    dm = state.get("depart_min")
    return int(dm) if dm is not None else _now_minutes()


def _travel_min(a: dict, b: dict, speed_kmph: float) -> float:
    """Straight-line travel estimate in minutes (fast, for pre-checks)."""
    meters = haversine_meters(a["lat"], a["lng"], b["lat"], b["lng"])
    return meters / (speed_kmph * 1000.0 / 60.0)


async def _pause_if_templated() -> None:
    """Without a live model the template path is instant; a tiny pause keeps the
    streamed panel legible."""
    if _get_client() is None:
        await asyncio.sleep(0.35)


async def _narrate(system: str, fact: str) -> str:
    """Let the model phrase a finding; fall back to the computed fact verbatim."""
    text = await _llm(system + " Use ONLY the facts given; do not invent numbers.", fact)
    if text is None:
        await _pause_if_templated()
        return fact
    return text


# ---------------------------------------------------------------------------
# 1. Validator — judges the input.
# ---------------------------------------------------------------------------
async def validator(state: State) -> dict:
    stops = state["stops"]
    base = _base(stops)
    sites = _sites(stops)
    issues: List[str] = []

    dists = {}
    for s in sites:
        mi = haversine_meters(base["lat"], base["lng"], s["lat"], s["lng"]) / 1609.344
        dists[s["id"]] = mi
        if mi > SERVICE_RADIUS_MI:
            issues.append(
                f"{s['name']} is ~{round(mi)} mi from base — outside the {SERVICE_RADIUS_MI} mi service area."
            )

    # Outliers: a site much farther than the rest is often a mis-dropped pin.
    if len(dists) >= 3:
        ordered = sorted(dists.values())
        median = ordered[len(ordered) // 2]
        for s in sites:
            d = dists[s["id"]]
            if median > 0 and d > max(3 * median, 40) and d <= SERVICE_RADIUS_MI:
                issues.append(f"{s['name']} (~{round(d)} mi) is far from the other sites — check the pin.")

    # Near-duplicate coordinates.
    seen: List[dict] = []
    for s in sites:
        for t in seen:
            if abs(s["lat"] - t["lat"]) < 3e-4 and abs(s["lng"] - t["lng"]) < 3e-4:
                issues.append(f"{s['name']} sits on the same spot as {t['name']} — possible duplicate.")
                break
        seen.append(s)

    # Implausible drop times.
    for s in sites:
        sm = s.get("service_min")
        if sm is not None and (sm < 0 or sm > 120):
            issues.append(f"{s['name']}'s drop time ({sm} min) looks off — expected 0–120 min.")

    n = len(sites)
    if not sites:
        fact = "No delivery sites yet — add some to plan a run."
    elif issues:
        fact = f"Checked {n} site(s); {len(issues)} issue(s): " + " ".join(issues)
    else:
        fact = f"Checked {n} site(s): all inside the service area, no duplicates, drop times look sane."

    text = await _narrate("You are the Validator in a food-bank delivery crew. Report the site check in ONE short sentence.", fact)
    return {"issues": issues, "validation": text}


# ---------------------------------------------------------------------------
# 2. Feasibility Analyst — predicts conflicts before solving.
# ---------------------------------------------------------------------------
async def feasibility(state: State) -> dict:
    stops = state["stops"]
    base = _base(stops)
    sites = _sites(stops)
    speed = state.get("speed_kmph", 30.0)
    depart = _effective_depart_min(state)
    windowed = [s for s in sites if s.get("window")]
    risks: List[str] = []

    for s in windowed:
        w = s["window"]
        if w[1] < depart:
            risks.append(
                f"{s['name']}'s window ({_fmt(w[0])}–{_fmt(w[1])}) is already past the {_fmt(depart)} departure."
            )
            continue
        earliest = depart + _travel_min(base, s, speed)
        if earliest > w[1]:
            risks.append(
                f"{s['name']} likely can't be reached by {_fmt(w[1])} leaving at {_fmt(depart)}."
            )

    if not windowed:
        fact = "No serving windows — any order is valid; the solver just minimizes driving."
    elif risks:
        fact = "Feasibility risk before solving: " + " ".join(risks)
    else:
        fact = f"All {len(windowed)} serving window(s) look reachable from a {_fmt(depart)} departure."

    text = await _narrate("You are the Feasibility Analyst. Give your pre-solve verdict in ONE short sentence.", fact)
    return {"feasibility": text}


# ---------------------------------------------------------------------------
# 3. Optimizer — the real math.
# ---------------------------------------------------------------------------
async def optimizer(state: State) -> dict:
    result = await asyncio.to_thread(
        solve_route,
        state["stops"],
        return_to_start=state["return_to_start"],
        speed_kmph=state.get("speed_kmph", 30.0),
        depart_min=state.get("depart_min"),
    )
    if not result.get("ok"):
        summary = result.get("reason", "The solver could not find a route.")
    else:
        by_id = {s["id"]: s for s in state["stops"]}
        order = [by_id[i]["name"] for i in result.get("ordered_stop_ids", []) if i in by_id]
        miles = round(result.get("total_distance_m", 0) / 1609.344, 1)
        mins = result.get("total_time_min", 0)
        summary = f"Best run: {' -> '.join(order)}. {miles} mi, about {mins} min of driving."
    return {"result": result, "optimize_summary": summary}


# ---------------------------------------------------------------------------
# 4. Diagnostician — reacts: auto-repair on failure, quality judge on success.
# ---------------------------------------------------------------------------
def _quality_flag(stops: List[dict], result: dict, speed_kmph: float) -> Optional[str]:
    """Flag a site whose detour dominates the run (analytic, no re-solve)."""
    legs = result.get("legs") or []
    ids = result.get("ordered_stop_ids") or []
    total = result.get("total_time_min") or sum(l.get("time_min", 0) for l in legs)
    if len(ids) < 4 or not total:
        return None
    by_id = {s["id"]: s for s in stops}
    worst_name, worst_marginal = None, 0.0
    for k in range(1, len(ids) - 1):  # interior sites with real neighbours
        sid = ids[k]
        if sid == "depot":
            continue
        leg_in = legs[k - 1].get("time_min", 0) if k - 1 < len(legs) else 0
        leg_out = legs[k].get("time_min", 0) if k < len(legs) else 0
        prev, nxt = by_id.get(ids[k - 1]), by_id.get(ids[k + 1])
        direct = _travel_min(prev, nxt, speed_kmph) if prev and nxt else 0
        marginal = max(0.0, leg_in + leg_out - direct)
        if marginal > worst_marginal:
            worst_name, worst_marginal = by_id.get(sid, {}).get("name"), marginal
    if worst_name and worst_marginal > 0.4 * total and worst_marginal > 20:
        return f"{worst_name} adds about {round(worst_marginal)} min of extra driving — consider a separate trip."
    return None


def _attempt_repair(
    stops: List[dict], return_to_start: bool, speed_kmph: float, depart: int
) -> Optional[Tuple[dict, dict]]:
    """Minimal-impact fix ladder. Returns (repair_descriptor, repaired_result) or
    None. Each rung is confirmed by a real (short-time-limit) solve."""
    T = 2
    windowed = [s for s in _sites(stops) if s.get("window")]

    # Rung 1: leave earlier — keeps every delivery and every window unchanged.
    if windowed:
        earliest_start = min(s["window"][0] for s in windowed)
        cands = sorted(
            {max(0, earliest_start - 30), max(0, earliest_start - 60), 480, 420, 360},
            reverse=True,  # prefer the LATEST departure that works
        )
        for cand in cands:
            if cand >= depart:
                continue  # only propose leaving earlier than the current departure
            r = solve_route(stops, return_to_start=return_to_start, speed_kmph=speed_kmph,
                            time_limit_seconds=T, depart_min=cand)
            if r.get("ok"):
                repair = {
                    "kind": "depart",
                    "description": f"Auto-repaired: leave at {_fmt(cand)} (instead of {_fmt(depart)}) so every serving window is reachable.",
                    "stops": stops,
                    "return_to_start": return_to_start,
                    "depart_min": cand,
                }
                return repair, r

    # Rung 2: widen the tightest window's end to end-of-day.
    for s in sorted(windowed, key=lambda x: x["window"][1]):
        mod = [dict(x) for x in stops]
        for m in mod:
            if m["id"] == s["id"]:
                m["window"] = [s["window"][0], 1439]
        r = solve_route(mod, return_to_start=return_to_start, speed_kmph=speed_kmph,
                        time_limit_seconds=T, depart_min=depart)
        if r.get("ok"):
            repair = {
                "kind": "widen_window",
                "description": f"Auto-repaired: widened {s['name']}'s window (it now closes at 11:59 pm) so the run fits.",
                "stops": mod,
                "return_to_start": return_to_start,
                "depart_min": depart,
            }
            return repair, r

    # Rung 3: drop the fewest sites (windowed first — most likely the blocker).
    for s in sorted(_sites(stops), key=lambda x: 0 if x.get("window") else 1):
        mod = [x for x in stops if x["id"] != s["id"]]
        if len(mod) < 2:
            continue
        r = solve_route(mod, return_to_start=return_to_start, speed_kmph=speed_kmph,
                        time_limit_seconds=T, depart_min=depart)
        if r.get("ok"):
            repair = {
                "kind": "drop_site",
                "description": f"Auto-repaired: dropped {s['name']} — its constraints made the run impossible.",
                "stops": mod,
                "return_to_start": return_to_start,
                "depart_min": depart,
            }
            return repair, r

    return None


async def diagnostician(state: State) -> dict:
    result = state.get("result", {})
    stops = state["stops"]
    speed = state.get("speed_kmph", 30.0)

    if result.get("ok"):
        flag = _quality_flag(stops, result, speed)
        fact = flag or "The run looks efficient — no single site dominates the driving."
        text = await _narrate("You are the Diagnostician judging the route's quality. ONE short sentence.", fact)
        return {"diagnosis": text, "repair": None}

    # Failure — try to repair.
    original_reason = result.get("reason", "No feasible route.")
    depart = _effective_depart_min(state)
    outcome = await asyncio.to_thread(_attempt_repair, stops, state["return_to_start"], speed, depart)

    if outcome is None:
        fact = f"Couldn't auto-repair: {original_reason} Even dropping a site didn't yield a valid run."
        text = await _narrate("You are the Diagnostician. Explain the failure in ONE short sentence and suggest a manual fix.", fact)
        return {"diagnosis": text, "repair": None}

    repair, repaired_result = outcome
    repair["original_reason"] = original_reason
    text = await _narrate("You are the Diagnostician announcing an automatic fix. ONE short sentence.", repair["description"])
    # Overwrite the result with the working repaired route so the UI can preview it.
    return {"diagnosis": text, "repair": repair, "result": repaired_result}


# ---------------------------------------------------------------------------
# 5. Advisor — synthesizes everything into one recommendation.
# ---------------------------------------------------------------------------
async def advisor(state: State) -> dict:
    result = state.get("result", {})
    issues = state.get("issues") or []
    repair = state.get("repair")
    parts: List[str] = []

    if result.get("ok"):
        miles = round(result.get("total_distance_m", 0) / 1609.344, 1)
        mins = result.get("total_time_min", 0)
        parts.append(f"Run ready: {miles} mi, about {mins} min of driving.")
        if repair:
            parts.append(repair["description"])
        else:
            diag = state.get("diagnosis")
            if diag:
                parts.append(diag)
    else:
        parts.append(state.get("diagnosis") or result.get("reason", "No route could be found."))

    if issues:
        extra = f" (+{len(issues) - 1} more)" if len(issues) > 1 else ""
        parts.append(f"Heads up: {issues[0]}{extra}")

    fact = " ".join(parts)
    text = await _narrate("You are the Advisor giving the dispatcher the bottom line in 1-2 short sentences.", fact)
    return {"advice": text}


# ---------------------------------------------------------------------------
# Wire the crew into a LangGraph pipeline.
# ---------------------------------------------------------------------------
def build_graph():
    g = StateGraph(State)
    g.add_node("validator", validator)
    g.add_node("feasibility", feasibility)
    g.add_node("optimizer", optimizer)
    g.add_node("diagnostician", diagnostician)
    g.add_node("advisor", advisor)
    g.add_edge(START, "validator")
    g.add_edge("validator", "feasibility")
    g.add_edge("feasibility", "optimizer")
    g.add_edge("optimizer", "diagnostician")
    g.add_edge("diagnostician", "advisor")
    g.add_edge("advisor", END)
    return g.compile()


NODE_META = {
    "validator": {"label": "Validator", "role": "Checks the sites", "key": "validation"},
    "feasibility": {"label": "Feasibility", "role": "Predicts conflicts", "key": "feasibility"},
    "optimizer": {"label": "Optimizer", "role": "Runs OR-Tools", "key": "optimize_summary"},
    "diagnostician": {"label": "Diagnostician", "role": "Diagnoses & auto-repairs", "key": "diagnosis"},
    "advisor": {"label": "Advisor", "role": "Recommends", "key": "advice"},
}

AGENTS_PUBLIC = [
    {"id": nid, "label": m["label"], "role": m["role"]} for nid, m in NODE_META.items()
]

_graph = build_graph()


async def run_agents(
    stops: List[dict], return_to_start: bool, speed_kmph: float = 30.0,
    depart_min: Optional[int] = None,
) -> dict:
    """Run the whole crew once and return the final state (non-streaming)."""
    return await _graph.ainvoke(
        {
            "stops": stops,
            "return_to_start": return_to_start,
            "speed_kmph": speed_kmph,
            "depart_min": depart_min,
        }
    )


async def stream_agents(
    stops: List[dict], return_to_start: bool, speed_kmph: float = 30.0,
    depart_min: Optional[int] = None,
) -> AsyncIterator[dict]:
    """Run the crew and yield one event per agent as it finishes, then a final
    result event carrying the (possibly repaired) route and any repair preview."""
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
        "depart_min": depart_min,
    }
    result: Optional[dict] = None
    repair: Optional[dict] = None

    async for chunk in _graph.astream(init, stream_mode="updates"):
        for node, delta in chunk.items():
            meta = NODE_META.get(node)
            if not meta:
                continue
            if "result" in delta:  # optimizer sets it; diagnostician may repair it
                result = delta.get("result")
            if delta.get("repair"):
                repair = delta.get("repair")
            yield {
                "type": "agent",
                "agent": node,
                "label": meta["label"],
                "role": meta["role"],
                "status": "done",
                "message": delta.get(meta["key"], ""),
            }

    yield {"type": "result", "result": result, "repair": repair}
    yield {"type": "done"}
