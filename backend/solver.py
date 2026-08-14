"""
The route solver. This is the honest, non AI core of RouteMind.

It takes a list of stops and returns the best visiting order using Google
OR-Tools. The language model agents (added in a later phase) coordinate and
explain, but the actual optimisation math lives here so the answer is fast
and reliable.
"""

from __future__ import annotations

import json
import math
import os
import urllib.request
from typing import List, Optional, Tuple

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

# A public OSRM server gives real road distances and typical drive times for
# free with no key. Set ROUTEMIND_ROUTING=off to force the straight-line
# estimate, or OSRM_URL to point at your own (production) OSRM instance.
OSRM_URL = os.environ.get("OSRM_URL", "https://router.project-osrm.org")


def road_matrices(stops: List[dict]) -> Optional[Tuple[List[List[int]], List[List[float]]]]:
    """Fetch real road (duration_seconds, distance_meters) matrices from OSRM.

    Returns None on any problem (routing disabled, too many stops, network
    error, bad response) so the solver can fall back to the estimate. OSRM's
    public server reflects the real road network but not live traffic.
    """
    if os.environ.get("ROUTEMIND_ROUTING", "osrm").lower() == "off":
        return None
    n = len(stops)
    if n < 2 or n > 100:  # keep table calls small and safe
        return None
    coords = ";".join(f"{s['lng']},{s['lat']}" for s in stops)
    url = f"{OSRM_URL}/table/v1/driving/{coords}?annotations=duration,distance"
    try:
        with urllib.request.urlopen(url, timeout=6) as resp:
            data = json.load(resp)
        if data.get("code") != "Ok":
            return None
        d, m = data["durations"], data["distances"]
        durations = [[int(round((d[i][j] or 0))) for j in range(n)] for i in range(n)]
        distances = [[float(m[i][j] or 0.0) for j in range(n)] for i in range(n)]
        return durations, distances
    except Exception:
        return None


def haversine_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Straight line distance between two points on Earth, in meters.

    Phase 1 uses straight line distance to stay dependency free. A later
    phase swaps this for real road distances from a routing service.
    """
    radius = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def build_time_matrix(stops: List[dict], speed_kmph: float) -> List[List[int]]:
    """Turn stops into a table of travel times in whole seconds.

    Every cell [i][j] is roughly how long it takes to drive from stop i to
    stop j at the given average speed.
    """
    speed_mps = speed_kmph * 1000.0 / 3600.0
    n = len(stops)
    matrix = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            meters = haversine_meters(
                stops[i]["lat"], stops[i]["lng"], stops[j]["lat"], stops[j]["lng"]
            )
            matrix[i][j] = int(round(meters / speed_mps))
    return matrix


def solve_route(
    stops: List[dict],
    return_to_start: bool = True,
    speed_kmph: float = 30.0,
    time_limit_seconds: int = 5,
    pins: Optional[List[dict]] = None,
) -> dict:
    """Find the best order to visit every stop, starting from the first one.

    stops: list of dicts with at least id, name, lat, lng. Each stop may also
        carry an optional service_min (minutes spent at the stop) and an
        optional window of [earliest_min, latest_min] measured from the start
        of the day, which the route must respect.
    return_to_start: whether the driver comes back to the first stop.
    pins: optional list of {"node": index, "pos": "first"|"last"} that force a
        delivery site to be visited first or last among the deliveries. Used by
        the Phase 3 chat ("put the shelter first"). Honoured as a hard ordering
        constraint, so an impossible pin (against a time window) makes the run
        unsolvable, which the caller surfaces to the user.

    Returns a plain dict that the API hands straight to the frontend.
    """
    n = len(stops)
    if n == 0:
        return {"ok": False, "reason": "No stops were provided."}
    if n == 1:
        return {
            "ok": True,
            "order": [0],
            "ordered_stop_ids": [stops[0]["id"]],
            "legs": [],
            "total_distance_m": 0,
            "total_time_min": 0,
            "arrivals_min": [0],
            "binding_rules": [],
        }

    # Prefer real road distances/times; fall back to the straight-line estimate.
    road = road_matrices(stops)
    if road is not None:
        time_matrix, dist_matrix = road
        distance_source = "road"
    else:
        time_matrix = build_time_matrix(stops, speed_kmph)
        dist_matrix = None
        distance_source = "estimate"

    has_windows = any(stop.get("window") for stop in stops)
    has_pins = bool(pins)

    depot = 0
    manager = pywrapcp.RoutingIndexManager(n, 1, depot)
    routing = pywrapcp.RoutingModel(manager)

    service_seconds = [int(round(stop.get("service_min", 0) * 60)) for stop in stops]

    def transit_callback(from_index: int, to_index: int) -> int:
        i = manager.IndexToNode(from_index)
        j = manager.IndexToNode(to_index)
        return time_matrix[i][j] + service_seconds[i]

    transit_idx = routing.RegisterTransitCallback(transit_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_idx)

    binding_rules: List[str] = []

    # A Time dimension is needed for time windows and/or ordering pins.
    if has_windows or has_pins:
        horizon = 24 * 3600
        routing.AddDimension(
            transit_idx,
            horizon,  # allow waiting before a window opens
            horizon,  # max time per vehicle
            False,  # do not force start cumul to zero
            "Time",
        )
        time_dim = routing.GetDimensionOrDie("Time")

        if has_windows:
            for node, stop in enumerate(stops):
                window = stop.get("window")
                if not window:
                    continue
                earliest = int(round(window[0] * 60))
                latest = int(round(window[1] * 60))
                index = manager.NodeToIndex(node)
                time_dim.CumulVar(index).SetRange(earliest, latest)
                binding_rules.append(
                    f"{stop['name']} must be reached between "
                    f"{_fmt(window[0])} and {_fmt(window[1])}."
                )

        if has_pins:
            # Force a site first/last by constraining its arrival time relative
            # to every other delivery, using the Time dimension's cumul vars.
            solver = routing.solver()
            delivery_nodes = [node for node in range(n) if node != depot]
            for pin in pins:
                pinned = manager.NodeToIndex(pin["node"])
                for other in delivery_nodes:
                    if other == pin["node"]:
                        continue
                    other_idx = manager.NodeToIndex(other)
                    if pin["pos"] == "first":
                        solver.Add(time_dim.CumulVar(pinned) <= time_dim.CumulVar(other_idx))
                    else:  # "last"
                        solver.Add(time_dim.CumulVar(pinned) >= time_dim.CumulVar(other_idx))
                binding_rules.append(
                    f"{stops[pin['node']]['name']} is pinned to be visited "
                    f"{pin['pos']}."
                )

    search = pywrapcp.DefaultRoutingSearchParameters()
    search.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )
    search.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    search.time_limit.FromSeconds(time_limit_seconds)

    solution = routing.SolveWithParameters(search)
    if solution is None:
        return {
            "ok": False,
            "reason": "No route can satisfy all of the rules. Try widening a time window or removing a stop.",
        }

    order: List[int] = []
    index = routing.Start(0)
    while not routing.IsEnd(index):
        order.append(manager.IndexToNode(index))
        index = solution.Value(routing.NextVar(index))
    # index now sits on the end node, which equals the depot for a closed loop

    legs = []
    total_distance = 0.0
    total_time = 0
    speed_mps = speed_kmph * 1000.0 / 3600.0

    path = order + [depot] if return_to_start else order
    for a, b in zip(path, path[1:]):
        if dist_matrix is not None:
            meters = dist_matrix[a][b]
            seconds = time_matrix[a][b]
        else:
            meters = haversine_meters(
                stops[a]["lat"], stops[a]["lng"], stops[b]["lat"], stops[b]["lng"]
            )
            seconds = int(round(meters / speed_mps))
        legs.append(
            {
                "from": stops[a]["id"],
                "to": stops[b]["id"],
                "distance_m": round(meters),
                "time_min": round(seconds / 60, 1),
            }
        )
        total_distance += meters
        total_time += seconds

    arrivals_min: List[int] = []
    if has_windows:
        time_dim = routing.GetDimensionOrDie("Time")
        for node in order:
            idx = manager.NodeToIndex(node)
            arrivals_min.append(round(solution.Value(time_dim.CumulVar(idx)) / 60))

    return {
        "ok": True,
        "order": order,
        "ordered_stop_ids": [stops[node]["id"] for node in order],
        "legs": legs,
        "total_distance_m": round(total_distance),
        "total_time_min": round(total_time / 60, 1),
        "arrivals_min": arrivals_min,
        "binding_rules": binding_rules,
        "returned_to_start": return_to_start,
        "distance_source": distance_source,
    }


def _fmt(minutes: float) -> str:
    """Turn minutes from midnight into a friendly clock time like 9:30 am."""
    total = int(round(minutes))
    hours = (total // 60) % 24
    mins = total % 60
    suffix = "am" if hours < 12 else "pm"
    hour12 = hours % 12
    if hour12 == 0:
        hour12 = 12
    return f"{hour12}:{mins:02d} {suffix}"
