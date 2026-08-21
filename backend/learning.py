"""
Phase 4: learning and unlearning.

Phase 1 assumed a fixed unload time per site. In reality the on-site service
time — how long it actually takes to hand over the food — varies by site, by
how much is delivered, and by the day. This module learns those real service
times from a log of past trips with a small scikit-learn model, so the solver
can plan with what actually happens instead of a guess.

Travel time still comes from the road network (OSRM, in solver.py). The model
refines the human part of the run: the time spent at each stop.

It also supports **unlearning**: on request it removes one site's (customer's)
trips and retrains, genuinely erasing their influence from the model — the
right to be forgotten, done the honest way (exact unlearning by retraining a
small model, not an approximation).

There is no real trip log yet, so on first run we generate a clearly-labelled
synthetic history that stands in for what real logged deliveries would contain.
"""

from __future__ import annotations

import json
import os
import random
from datetime import date, timedelta
from typing import Dict, List, Optional

import numpy as np
from sklearn.linear_model import Ridge
from sklearn.preprocessing import OneHotEncoder

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
TRIPS_PATH = os.path.join(DATA_DIR, "trips.json")

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]

# The sites the demo history is generated for. base_min is the "true" average
# unload time we sample around; the model has to recover something like it from
# noisy logged trips. site_type/base match the seeded run in the frontend.
SEED_SITES = [
    {"id": "s1", "name": "Sunrise Senior Center", "type": "senior_center", "base_min": 14},
    {"id": "s2", "name": "Westside Family Shelter", "type": "shelter", "base_min": 24},
    {"id": "s3", "name": "Alum Rock Community Pantry", "type": "pantry", "base_min": 16},
    {"id": "s4", "name": "Seven Trees After-School Pantry", "type": "pantry", "base_min": 19},
]


# ---------------------------------------------------------------------------
# The trip log (stands in for real logged deliveries).
# ---------------------------------------------------------------------------
def _generate_trips(sites: List[dict], per_site: int = 30, seed: int = 7) -> List[dict]:
    rng = random.Random(seed)
    trips: List[dict] = []
    start = date(2026, 5, 1)
    tid = 1
    for site in sites:
        for _ in range(per_site):
            d = start + timedelta(days=rng.randint(0, 90))
            day = DAYS[d.weekday()] if d.weekday() < 5 else "Fri"
            load = rng.randint(4, 24)  # boxes delivered
            # Actual on-site minutes: a site baseline, plus time per box, plus a
            # small Friday bump (busier), plus noise — this is what a real log
            # would capture and what the model learns to predict.
            minutes = (
                site["base_min"]
                + 0.45 * load
                + (3 if day == "Fri" else 0)
                + rng.gauss(0, 2.0)
            )
            trips.append(
                {
                    "trip_id": tid,
                    "date": d.isoformat(),
                    "customer_id": site["id"],
                    "site_name": site["name"],
                    "site_type": site["type"],
                    "day": day,
                    "load_boxes": load,
                    "actual_service_min": round(max(3.0, minutes), 1),
                }
            )
            tid += 1
    rng.shuffle(trips)
    return trips


def load_trips() -> List[dict]:
    if not os.path.exists(TRIPS_PATH):
        trips = _generate_trips(SEED_SITES)
        save_trips(trips)
        return trips
    with open(TRIPS_PATH) as f:
        return json.load(f)


def save_trips(trips: List[dict]) -> None:
    with open(TRIPS_PATH, "w") as f:
        json.dump(trips, f, indent=2)


# ---------------------------------------------------------------------------
# The model: predict on-site service minutes from site + load + day.
# ---------------------------------------------------------------------------
class ServiceTimeModel:
    """A small ridge regression over one-hot(site, day) plus load. Small on
    purpose: it fits and retrains in milliseconds, which is what makes exact
    unlearning (retrain-without-them) practical."""

    def __init__(self) -> None:
        self.trained = False
        self.version = 0
        self.mae: Optional[float] = None
        self.trips: List[dict] = []
        self._enc: Optional[OneHotEncoder] = None
        self._model: Optional[Ridge] = None

    def _design(self, trips: List[dict], fit_encoder: bool):
        cat = np.array([[t["customer_id"], t["day"]] for t in trips])
        if fit_encoder:
            self._enc = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
            X_cat = self._enc.fit_transform(cat)
        else:
            X_cat = self._enc.transform(cat)
        X_num = np.array([[float(t["load_boxes"])] for t in trips])
        return np.hstack([X_cat, X_num])

    def fit(self, trips: List[dict]) -> None:
        self.trips = trips
        self.version += 1
        if len(trips) < 3:
            self.trained = False
            self.mae = None
            return
        X = self._design(trips, fit_encoder=True)
        y = np.array([t["actual_service_min"] for t in trips])
        self._model = Ridge(alpha=1.0)
        self._model.fit(X, y)
        # In-sample mean absolute error — a simple honesty check on the fit.
        self.mae = float(np.mean(np.abs(self._model.predict(X) - y)))
        self.trained = True

    def predict_minutes(
        self, customer_id: str, load_boxes: float = 12, day: str = "Wed"
    ) -> Optional[float]:
        if not self.trained:
            return None
        X = self._design(
            [{"customer_id": customer_id, "day": day, "load_boxes": load_boxes}],
            fit_encoder=False,
        )
        return round(float(self._model.predict(X)[0]), 1)


# One process-wide model, trained lazily.
_model = ServiceTimeModel()


def _ensure_trained() -> None:
    if not _model.trained or not _model.trips:
        _model.fit(load_trips())


def default_service(customer_id: str) -> Optional[float]:
    for s in SEED_SITES:
        if s["id"] == customer_id:
            return float(s["base_min"])
    return None


def model_summary(stops: Optional[List[dict]] = None) -> dict:
    """Per-site learned vs default service minutes, trip counts, and fit error.

    If `stops` is given, report against those sites (so custom/renamed sites in
    the current run line up); otherwise report against the seed sites.
    """
    _ensure_trained()
    trips = _model.trips
    counts: Dict[str, int] = {}
    for t in trips:
        counts[t["customer_id"]] = counts.get(t["customer_id"], 0) + 1

    sites_source = (
        [{"id": s["id"], "name": s["name"]} for s in stops if s.get("id") != "depot"]
        if stops
        else [{"id": s["id"], "name": s["name"]} for s in SEED_SITES]
    )

    rows = []
    for s in sites_source:
        learned = _model.predict_minutes(s["id"])
        rows.append(
            {
                "id": s["id"],
                "name": s["name"],
                "default_min": default_service(s["id"]),
                "learned_min": learned,
                "trips": counts.get(s["id"], 0),
            }
        )
    return {
        "ok": True,
        "model_version": _model.version,
        "total_trips": len(trips),
        "mae_min": round(_model.mae, 2) if _model.mae is not None else None,
        "sites": rows,
    }


def learned_service_for(customer_id: str) -> Optional[float]:
    """The learned on-site minutes for a site, or None if the model can't say."""
    _ensure_trained()
    return _model.predict_minutes(customer_id)


def unlearn(customer_id: str) -> dict:
    """Remove one site's (customer's) trips and retrain — the right to be
    forgotten, done as exact unlearning."""
    _ensure_trained()
    before = len(_model.trips)
    name = next((t["site_name"] for t in _model.trips if t["customer_id"] == customer_id), customer_id)
    kept = [t for t in _model.trips if t["customer_id"] != customer_id]
    removed = before - len(kept)
    if removed == 0:
        return {
            "ok": False,
            "removed": 0,
            "reply": f"No trips on record for {name}, so there was nothing to forget.",
        }
    save_trips(kept)
    _model.fit(kept)
    return {
        "ok": True,
        "customer_id": customer_id,
        "site_name": name,
        "removed": removed,
        "reply": (
            f"Forgotten {name}: removed {removed} past trips and retrained the model "
            f"(now version {_model.version}, {len(kept)} trips). The site's history no "
            f"longer influences any prediction."
        ),
        "model": model_summary(),
    }


def reset_history() -> dict:
    """Regenerate the synthetic trip log and retrain (demo convenience)."""
    trips = _generate_trips(SEED_SITES)
    save_trips(trips)
    _model.fit(trips)
    return model_summary()
