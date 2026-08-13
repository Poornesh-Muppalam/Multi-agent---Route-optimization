"""
Phase 3: the chat.

The driver (or dispatcher) types a plain-English change to the run — "drop the
senior center", "move the shelter to 8 to 9 am", "put Seven Trees last", "don't
go back to the food bank" — and RouteMind:

    1. interprets the message into a structured edit,
    2. applies it, re-solves with OR-Tools,
    3. and explains what changed and what it cost (distance and drive-time delta).

Interpretation uses the fast Claude model when a key is present (structured
output), and falls back to a rule-based parser so the chat still works with no
key. The solver is still the honest core — the chat only decides *what* to
change, never the route math.
"""

from __future__ import annotations

import json
import re
from typing import List, Optional, Tuple

import agents
from solver import solve_route

# ---------------------------------------------------------------------------
# Interpreting the message into a structured action.
# ---------------------------------------------------------------------------

KINDS = ["remove", "set_window", "set_service", "reorder", "set_return", "reoptimize", "unknown"]

# Structured-output schema for the fast model. Sentinels (-1, "none", "") keep
# every field a plain required type, which the structured-output API accepts.
ACTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "enum": KINDS},
        "site_query": {"type": "string"},
        "window_start_min": {"type": "integer"},
        "window_end_min": {"type": "integer"},
        "clear_window": {"type": "boolean"},
        "service_min": {"type": "integer"},
        "position": {"type": "string", "enum": ["first", "last", "none"]},
        "return_value": {"type": "string", "enum": ["true", "false", "none"]},
        "note": {"type": "string"},
    },
    "required": [
        "kind",
        "site_query",
        "window_start_min",
        "window_end_min",
        "clear_window",
        "service_min",
        "position",
        "return_value",
        "note",
    ],
}


def _blank_action() -> dict:
    return {
        "kind": "unknown",
        "site_query": "",
        "window_start_min": -1,
        "window_end_min": -1,
        "clear_window": False,
        "service_min": -1,
        "position": "none",
        "return_value": "none",
        "note": "",
    }


async def _llm_interpret(message: str, stops: List[dict]) -> Optional[dict]:
    client = agents._get_client()
    if client is None:
        return None
    site_list = ", ".join(f'"{s["name"]}"' for s in stops if s.get("id") != "depot")
    system = (
        "You turn a food-bank dispatcher's plain-English request into ONE structured "
        "edit to a delivery run. Times are minutes from midnight (9:00 am = 540, "
        "noon = 720, 2:30 pm = 870). Use sentinels for unused fields: -1 for numbers, "
        '"none" for position/return_value, "" for site_query. site_query is the site '
        "the user named, copied loosely. Choose kind: remove, set_window, set_service, "
        "reorder (with position first/last), set_return (return_value true/false), "
        "reoptimize (just re-run), or unknown (put a short clarification in note)."
    )
    user = f"Delivery sites: {site_list or 'none'}.\nRequest: {message}"
    try:
        msg = await client.messages.create(
            model=agents.MODEL,
            max_tokens=300,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"format": {"type": "json_schema", "schema": ACTION_SCHEMA}},
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
        data = json.loads(text)
        action = _blank_action()
        action.update({k: data[k] for k in action if k in data})
        return action
    except Exception:
        return None


# Rule-based fallback so the chat works with no API key.
_TIME_RE = re.compile(
    r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", re.IGNORECASE
)


def _parse_clock(token: str) -> Optional[int]:
    token = token.strip().lower()
    if token in ("noon", "midday"):
        return 720
    if token in ("midnight",):
        return 0
    m = _TIME_RE.fullmatch(token.strip())
    if not m:
        return None
    hour = int(m.group(1))
    minute = int(m.group(2) or 0)
    suffix = m.group(3)
    if suffix == "pm" and hour != 12:
        hour += 12
    if suffix == "am" and hour == 12:
        hour = 0
    return hour * 60 + minute


def _rule_interpret(message: str, stops: List[dict]) -> dict:
    text = message.lower().strip()
    action = _blank_action()

    # Which site is being referred to (best shared-word match wins).
    best = _resolve_site(message, stops)
    if best:
        action["site_query"] = best["name"]

    if re.search(r"\b(re-?optimi[sz]e|re-?run|optimi[sz]e again|recalculate)\b", text):
        action["kind"] = "reoptimize"
        return action

    if re.search(r"\b(don'?t|do not|no|stop)\b.*\breturn|\bone[- ]way\b", text) or re.search(
        r"\breturn\b.*\b(no|off|false)\b", text
    ):
        action["kind"] = "set_return"
        action["return_value"] = "false"
        return action
    if re.search(r"\b(return|come back|back to (the )?(base|food bank|depot))\b", text):
        action["kind"] = "set_return"
        action["return_value"] = "true"
        return action

    if re.search(r"\b(remove|drop|delete|skip|cancel)\b", text) and best:
        action["kind"] = "remove"
        return action

    if re.search(r"\b(first|earliest|before everything|start with)\b", text) and best:
        action["kind"] = "reorder"
        action["position"] = "first"
        return action
    if re.search(r"\b(last|latest|at the end|end with)\b", text) and best:
        action["kind"] = "reorder"
        action["position"] = "last"
        return action

    if re.search(r"\b(no window|any ?time|remove the window|drop the window)\b", text) and best:
        action["kind"] = "set_window"
        action["clear_window"] = True
        return action

    # "9 to 11", "9am-11am", "11:00 to 12:30 pm", "noon to 1pm", "1 to 2 pm"
    win = re.search(
        r"(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|to|until|till)\s*"
        r"(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)",
        text,
    )
    if win and best and re.search(
        r"\b(window|between|serv(e|ing)|reach|receiv|deliver|move|change|set|shift|reschedul)\w*",
        text,
    ):
        t1, t2 = win.group(1).strip(), win.group(2).strip()
        # "1 to 2 pm" — a suffix on one side usually applies to both.
        suf1 = re.search(r"(am|pm)", t1, re.IGNORECASE)
        suf2 = re.search(r"(am|pm)", t2, re.IGNORECASE)
        if suf2 and not suf1:
            t1 = t1 + suf2.group(1)
        elif suf1 and not suf2:
            t2 = t2 + suf1.group(1)
        a, b = _parse_clock(t1), _parse_clock(t2)
        if a is not None and b is not None and b > a:
            action["kind"] = "set_window"
            action["window_start_min"] = a
            action["window_end_min"] = b
            return action

    svc = re.search(r"(\d{1,3})\s*(?:min|mins|minutes)\b", text)
    if svc and best and re.search(r"\b(unload|drop|service|need|take|takes|spend)\b", text):
        action["kind"] = "set_service"
        action["service_min"] = int(svc.group(1))
        return action

    action["note"] = (
        "I couldn't tell what to change. Try things like 'drop the senior center', "
        "'move the shelter to 8 to 9 am', 'put Seven Trees last', or "
        "'don't return to the food bank'."
    )
    return action


async def interpret(message: str, stops: List[dict]) -> dict:
    return (await _llm_interpret(message, stops)) or _rule_interpret(message, stops)


# ---------------------------------------------------------------------------
# Resolving the referenced site and applying the action.
# ---------------------------------------------------------------------------
def _resolve_site(query: str, stops: List[dict]) -> Optional[dict]:
    if not query:
        return None
    q = query.lower().strip()
    sites = [s for s in stops if s.get("id") != "depot"]
    for s in sites:  # exact-ish name match
        if s["name"].lower() == q or q in s["name"].lower() or s["name"].lower() in q:
            return s
    # fall back to any shared significant word
    q_words = {w for w in re.split(r"\W+", q) if len(w) > 3}
    best, best_score = None, 0
    for s in sites:
        words = {w for w in re.split(r"\W+", s["name"].lower()) if len(w) > 3}
        score = len(q_words & words)
        if score > best_score:
            best, best_score = s, score
    return best


def apply_action(
    action: dict, stops: List[dict], return_to_start: bool
) -> Tuple[List[dict], bool, Optional[List[dict]], str, Optional[str]]:
    """Return (new_stops, new_return, pins, summary, error). On error the
    caller keeps the old state and just shows the message."""
    kind = action.get("kind", "unknown")
    new_stops = [dict(s) for s in stops]
    pins: Optional[List[dict]] = None
    site = _resolve_site(action.get("site_query", ""), stops)

    needs_site = kind in ("remove", "set_window", "set_service", "reorder")
    if needs_site and site is None:
        return stops, return_to_start, None, "", (
            "I couldn't tell which site you meant. Use its name, e.g. "
            f"\"{next((s['name'] for s in stops if s.get('id') != 'depot'), 'a site')}\"."
        )

    if kind == "reoptimize":
        return new_stops, return_to_start, None, "Re-optimized the run.", None

    if kind == "set_return":
        val = action.get("return_value") == "true"
        return new_stops, val, None, (
            "The van now returns to the food bank." if val else "The van no longer returns to the food bank."
        ), None

    if kind == "remove":
        new_stops = [s for s in new_stops if s["id"] != site["id"]]
        return new_stops, return_to_start, None, f"Removed {site['name']} from the run.", None

    if kind == "set_service":
        mins = action.get("service_min", -1)
        if mins is None or mins < 0:
            return stops, return_to_start, None, "", "Tell me how many minutes the drop takes."
        for s in new_stops:
            if s["id"] == site["id"]:
                s["service_min"] = mins
        return new_stops, return_to_start, None, f"Set {site['name']}'s drop time to {mins} min.", None

    if kind == "set_window":
        for s in new_stops:
            if s["id"] != site["id"]:
                continue
            if action.get("clear_window"):
                s["window"] = None
                return new_stops, return_to_start, None, f"Removed {site['name']}'s serving window.", None
            a, b = action.get("window_start_min", -1), action.get("window_end_min", -1)
            if a is None or b is None or a < 0 or b < 0 or b <= a:
                return stops, return_to_start, None, "", "Give a serving window like '8 to 9 am'."
            s["window"] = [a, b]
            return new_stops, return_to_start, None, (
                f"Set {site['name']}'s serving window to {agents._fmt(a)}–{agents._fmt(b)}."
            ), None
        return stops, return_to_start, None, "", "That site is not in the run."

    if kind == "reorder":
        pos = action.get("position", "none")
        if pos not in ("first", "last"):
            return stops, return_to_start, None, "", "Say whether it should be first or last."
        node = next((i for i, s in enumerate(new_stops) if s["id"] == site["id"]), None)
        if node is None:
            return stops, return_to_start, None, "", "That site is not in the run."
        pins = [{"node": node, "pos": pos}]
        return new_stops, return_to_start, pins, f"Put {site['name']} {pos} in the run.", None

    note = action.get("note") or (
        "I couldn't tell what to change. Try 'drop the senior center', "
        "'move the shelter to 8 to 9 am', or 'put Seven Trees last'."
    )
    return stops, return_to_start, None, "", note


# ---------------------------------------------------------------------------
# The chat turn: interpret -> apply -> solve -> explain the cost.
# ---------------------------------------------------------------------------
def _totals(result: dict) -> Tuple[float, float]:
    return (result.get("total_distance_m", 0) or 0, result.get("total_time_min", 0) or 0)


async def _explain(summary: str, before: dict, after: dict) -> Tuple[str, dict]:
    b_m, b_min = _totals(before) if before.get("ok") else (0, 0)
    a_m, a_min = _totals(after)
    d_km = round((a_m - b_m) / 1000, 1)
    d_min = round(a_min - b_min, 1)
    delta = {"distance_km": d_km, "time_min": d_min}

    def phrase(v: float, unit: str) -> str:
        if v > 0:
            return f"adds {v} {unit}"
        if v < 0:
            return f"saves {abs(v)} {unit}"
        return f"is the same {unit}"

    cost = f"That change {phrase(d_km, 'km')} and {phrase(d_min, 'min')} of driving."
    if not before.get("ok"):
        cost = f"The run now covers {round(a_m/1000,1)} km in about {a_min} min."

    text = await agents._llm(
        "You are the Explainer for a food-bank delivery app. In 1-2 short, friendly "
        "sentences, tell the driver what just changed in the run and what it cost. Use "
        "ONLY the facts given; do not invent numbers.",
        f"Change made: {summary} Cost vs the previous run: {cost}",
    )
    if text is None:
        text = f"{summary} {cost}"
    return text, delta


async def chat_turn(
    message: str, stops: List[dict], return_to_start: bool, speed_kmph: float = 30.0
) -> dict:
    action = await interpret(message, stops)
    new_stops, new_return, pins, summary, error = apply_action(action, stops, return_to_start)

    if error:
        return {"ok": False, "kind": action.get("kind", "unknown"), "reply": error}

    before = solve_route(stops, return_to_start=return_to_start, speed_kmph=speed_kmph)
    after = solve_route(
        new_stops, return_to_start=new_return, speed_kmph=speed_kmph, pins=pins
    )

    if not after.get("ok"):
        reply = (
            f"I can't do that — {summary[:1].lower()}{summary[1:].rstrip('.')} would leave "
            "no run that fits every serving window. Try widening a window or dropping a site."
        )
        return {"ok": False, "kind": action.get("kind", "unknown"), "reply": reply}

    reply, delta = await _explain(summary, before, after)
    return {
        "ok": True,
        "kind": action.get("kind", "unknown"),
        "summary": summary,
        "reply": reply,
        "delta": delta,
        "stops": new_stops,
        "return_to_start": new_return,
        "result": after,
    }
