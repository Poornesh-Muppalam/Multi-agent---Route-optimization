# RouteMind — Technical Report

**Author:** Poornesh Muppalam
**Professor:** Prashant Khanduri

**Project:** RouteMind — AI-assisted, multi-agent delivery-route optimization for a food bank
**Domain:** Last-mile logistics / vehicle routing with time windows
**Status:** Working full-stack application (local dev), actively iterated
**Document scope:** End-to-end technical overview — architecture, subsystems, the
development journey, key engineering decisions, API contracts, configuration, and
known limitations.

---

## 1. Executive Summary

RouteMind plans a food bank's daily delivery van run. A dispatcher adds community
delivery sites (by address search or map click), sets each site's **serving window**
and **on-site drop time**, chooses when the van departs, and asks the system to build
the shortest run that still reaches every site inside its window. The result is drawn
on a live map as a turn-by-turn route with an estimated arrival (ETA) at each stop.

The system is deliberately split so that **deterministic math stays authoritative**
and **language models do only what they are genuinely good at**:

- A **constraint solver** (Google OR-Tools) computes the actual visiting order,
  respecting time windows, drop times, the departure time, and optional ordering
  pins. Road distances/times come from a routing service (OSRM).
- A **crew of five agents** (LangGraph) wraps the solver with real analysis:
  validating inputs, predicting conflicts before solving, running the solver,
  **auto-repairing** an infeasible run, and advising the dispatcher.
- A **natural-language chat** lets the dispatcher edit the run or ask questions in
  plain English; it is interpreted by an LLM (with a rule-based fallback) and the
  deterministic edits are applied and re-solved by the backend.

The application runs fully **free and offline-capable**: without any API key the
chat uses a rule-based parser and the agents use computed/template text; with a free
LLM key (Google Gemini by default) the same flows gain natural-language quality.

---

## 2. System Architecture

### 2.1 High-level components

```
┌──────────────────────────── Browser (Next.js 14, React 18, TS) ───────────────────────────┐
│  page.tsx  — app state, flows (optimize, agents, chat, conditions, departure)               │
│  MapView.tsx — Google Maps: markers, route polyline, vehicle animation, geocoding           │
│  lib/api.ts — typed fetch client (REST + SSE)   lib/types.ts — shared types                 │
│  globals.css — warm/vibrant theme (CSS variables, Bricolage Grotesque + Inter)              │
└───────────────┬────────────────────────────────────────────────────────────────────────────┘
                │ HTTP / Server-Sent Events        │ Google Maps JS (Places, Geocoding, Directions)
                ▼                                   ▼
┌──────────── Backend (FastAPI, Python) ───────────┐        Google Maps Platform
│  app.py    — REST + SSE endpoints                │
│  solver.py — OR-Tools routing + OSRM matrices    │──► OSRM public server (road distances/times)
│  agents.py — LangGraph crew + LLM adapter        │──► LLM provider (Gemini / Groq / Ollama / Claude)
│  chat.py   — interpret → apply → re-solve/answer │
└──────────────────────────────────────────────────┘
```

### 2.2 Technology stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), React 18.3, TypeScript 5.5 |
| Maps | `@react-google-maps/api` 2.20; Maps JS, Places (Autocomplete), Geocoding, Directions, Geometry |
| Backend | FastAPI, Uvicorn, Pydantic 2 |
| Optimization | Google OR-Tools (constraint-programming routing) |
| Routing data | OSRM public server (`router.project-osrm.org`) with a straight-line fallback |
| Agents | LangGraph (linear state graph) |
| LLM | OpenAI-compatible adapter (default: Google Gemini `gemini-flash-lite-latest`); Anthropic as legacy fallback |
| Config | `python-dotenv` (`backend/.env`), Next public env (`frontend/.env.local`) |

### 2.3 Source inventory (approximate sizes)

```
backend/solver.py   ~301 LOC   OR-Tools solver, OSRM, time model
backend/agents.py   ~604 LOC   agent crew + LLM provider adapter + auto-repair
backend/chat.py     ~525 LOC   NL interpret / apply / answer
backend/app.py      ~145 LOC   FastAPI endpoints
frontend/app/page.tsx          ~758 LOC   main UI + state
frontend/app/components/MapView.tsx ~374 LOC   Google Maps integration
frontend/app/lib/api.ts        ~270 LOC   client (REST + SSE + n8n-era flexible parser)
frontend/app/lib/types.ts      ~121 LOC   shared types
frontend/app/globals.css       ~482 LOC   theme + layout
```

---

## 3. Backend Subsystems

### 3.1 The solver (`solver.py`) — the honest core

The solver is the single source of truth for route math. Key elements:

- **Distance/time matrices.** `road_matrices()` fetches real driving **durations and
  distances** from OSRM's table service for up to 100 stops. On any failure (routing
  disabled, too many stops, network error), it falls back to `build_time_matrix()` /
  `haversine_meters()` — a straight-line estimate at a fixed average speed. The result
  reports `distance_source: "road" | "estimate"` so the UI can be honest about it.

- **OR-Tools model.** A `RoutingModel` with one vehicle and a depot (node 0). The arc
  cost is travel time **plus the origin's service (drop) time**, so long drops
  correctly push back everything downstream.

- **Time dimension & departure.** A `Time` dimension always drives the schedule. The
  vehicle's start cumul is fixed to the **departure time** (`depart_min`, minutes from
  midnight; defaults to the current local time — "leave now"). Serving windows become
  `CumulVar.SetRange(earliest, latest)` constraints on their nodes; waiting before a
  window opens is permitted via slack. ETAs (`arrivals_min`) are read back from the
  Time dimension for every stop.

- **Ordering pins.** The chat's "put X first/last" is honored as a hard constraint on
  the Time dimension's cumulative variables (pinned stop ≤ / ≥ every other delivery).

- **Capacity horizon.** The dimension's maximum cumulative time is
  **`departure + 24h`** (not a fixed midnight ceiling). This was a deliberate fix: a
  late departure with a long route would otherwise exceed a same-day cap and be
  wrongly reported infeasible.

Output is a plain dict: `ok`, `order`, `ordered_stop_ids`, `legs`,
`total_distance_m`, `total_time_min`, `arrivals_min`, `binding_rules`,
`returned_to_start`, `distance_source`.

### 3.2 The agent crew (`agents.py`) — analysis, judgment, self-repair

A LangGraph linear pipeline, **each node backed by computation** (so it works with no
LLM key; the LLM only narrates):

```
validator → feasibility → optimizer → diagnostician → advisor
```

1. **Validator** — judges the input: flags out-of-service-area sites, near-duplicate
   pins, distance **outliers** (a site far from the cluster ⇒ likely a bad pin), and
   implausible drop times (<0 or >120 min).
2. **Feasibility Analyst** — *predicts conflicts before solving.* Using a haversine
   estimate from the departure time, it detects windows already in the past and
   windows unreachable from the base in time.
3. **Optimizer** — calls `solve_route` (the only node that does the real math).
4. **Diagnostician** — *reacts.*
   - **On failure**, runs a **minimal-impact fix ladder**, each rung confirmed by a
     real re-solve: (1) shift departure earlier (keeps all deliveries & windows),
     (2) widen the tightest blocking window, (3) drop the fewest sites. It applies the
     first rung that works and returns a **repaired route + a `repair` descriptor**.
   - **On success**, acts as a quality judge, flagging a site whose marginal detour
     dominates the run ("…adds ~210 min — consider a separate trip").
5. **Advisor** — synthesizes validator issues + feasibility verdict + diagnostician
   outcome into one recommendation.

**LLM provider adapter.** `_get_client()` resolves a client in priority order:
OpenAI-compatible (`LLM_BASE_URL` + `LLM_API_KEY` → Groq / Gemini / Ollama / OpenAI),
then Anthropic (`ANTHROPIC_API_KEY`), else `None` (deterministic fallback). `_llm()`
returns short free-text; `_llm_json()` returns a parsed object via the provider's JSON
mode. `brain_info()` reports the active brain for the UI badge.

### 3.3 The chat (`chat.py`)

A chat turn is: **interpret → apply → re-solve → explain** (for edits), or
**interpret → answer** (for questions).

- **Interpretation** maps a message to a structured action (`ACTION_SCHEMA`:
  `kind`, `site_query`, window fields, `service_min`, `position`, `return_value`,
  `note`). `kind ∈ {remove, set_window, set_service, reorder, set_return, reoptimize,
  ask, unknown}`. An LLM path (`_llm_interpret` via `_llm_json`) is used when a key is
  present; otherwise a **regex rule-based parser** (`_rule_interpret`) handles times
  ("8 to 9 am"), site resolution by shared-word matching, etc.
- **`apply_action`** performs the deterministic edit and resolves the referenced site.
- **`apply_turn`** solves before/after and computes the real cost delta; **`_explain`**
  phrases it (LLM or template). **`answer_question`** answers run questions from a
  computed run context, always honest that live traffic is not modeled.

### 3.4 API (`app.py`)

| Method & path | Purpose |
|---|---|
| `GET /` | Health check |
| `POST /optimize` | Raw solve (used by "Solver only") |
| `POST /optimize/agents` | Run the crew once, return final state |
| `POST /optimize/agents/stream` | Stream crew steps live over **Server-Sent Events**; final event carries the (possibly repaired) result + `repair` |
| `POST /chat` | Full chat turn (interpret + apply/answer) |
| `GET /chat/info` | Which brain powers the chat (Gemini/Groq/Claude/Ollama/Rules) |
| `POST /chat/apply` | Apply a pre-decided structured action + re-solve (used by the chat flow) |

All requests share `depart_min`, `return_to_start`, `speed_kmph`, and the `stops`
list. CORS is open for local development.

---

## 4. Frontend Subsystems

### 4.1 Main app (`page.tsx`)

Holds all application state (stops, route, departure time, return-to-base, chat log,
agent activity, repair preview, per-site condition editor) and the primary flows:

- **Add/remove/rename sites**, with a service-area guard (≤130 mi of the base) and a
  duplicate-location guard.
- **Per-site conditions editor** (⚙): drop time (0–240 min) and an optional serving
  window via native time inputs; changes invalidate the current route.
- **Departure control** ("Van leaves at") — editable, defaults to the current time,
  with a "now" button; threaded into every solve so ETAs are real.
- **Optimize with agents** (SSE stream → live agent panel + auto-repair preview) and
  **Solver only** (raw solve).
- **Chat** — message actions (copy, retry on failure), clear chat, preset chips, and
  a dynamic **"chat: Gemini/Rules"** brain badge fetched from `/chat/info`.

### 4.2 Map (`MapView.tsx`)

- **Google Maps** via `useJsApiLoader` (libraries: `places`, `geometry`).
- **Adding sites:** Places **Autocomplete**, with a **geocoding fallback** so typing a
  full address and pressing Enter (without picking a suggestion) still adds the site.
  Map clicks are reverse-geocoded and rejected if they land on water.
- **Markers:** depot shows "H"; delivery sites are **numbered to match the run sheet**
  (the depot is not counted, so sites start at 1).
- **Route rendering:** a `DirectionsService` request through the solved order draws a
  Google-style blue polyline; a vehicle arrow animates once along the path using
  spherical geometry.
- **Framing:** `applyView()` fits bounds for multiple stops, else centers the base at
  a city zoom, and triggers a `resize`/re-frame once idle — preventing the
  world-zoom/grey-band problem after layout changes or with zero sites.

### 4.3 Client & types (`api.ts`, `types.ts`)

`api.ts` exposes `optimizeRoute`, `streamAgents` (SSE reader), `sendChat`,
`applyAction`, `getChatBrain`. `sendChat` still contains a **flexible response
normalizer** (from the n8n era) that tolerates bare strings, varied reply keys, and
array/`{json}` wrappers, and only treats a response as a route edit when its `kind` is
a real edit kind. `types.ts` holds the shared contracts (`Stop`, `RouteResult`,
`ChatResponse`, `AgentEvent`, `Repair`, `ChatBrain`, …).

### 4.4 Styling

A **warm/vibrant** theme driven entirely by CSS variables: cream canvas, amber +
coral + teal accents, warm hairlines; **Bricolage Grotesque** for headers and Inter
for body; an amber→coral→teal gradient wordmark. Layout places the control **panel on
the left** and the map on the right (`flex-direction: row-reverse`).

---

## 5. Development Journey (chronological)

The project began as a phased build (solver → agents → chat → learning) and was then
iterated heavily. Major milestones, in order:

1. **Chat UX polish.** Added per-message **copy**, **retry on failure** (re-sends the
   originating message), and **clear chat**; failed replies carry a `retryText`.
2. **n8n integration (later removed).** Wired the chat "brain" to an n8n Cloud webhook
   in a **hybrid** design: n8n interprets, the local backend applies + re-solves via a
   new `POST /chat/apply`. Added a provider-flexible response parser, a same-origin
   **Next.js rewrite proxy** to sidestep n8n's CORS, and a "via n8n" badge.
3. **Address search & reset fixes.** Address search gained the geocoding fallback;
   **Reset** became a true reset-to-initial (sites, route, chat, departure, warnings).
4. **Per-site conditions.** Added the ⚙ editor so any added site can get a serving
   window and drop time (previously only seed sites had them).
5. **Map/run-sheet pin numbering.** Fixed an off-by-one: the depot is "H" and sites are
   numbered from 1 in route order, matching the run sheet exactly.
6. **Real-time ETA model.** Introduced a **departure time** ("leave now" / editable
   "Van leaves at"), always-on ETAs, and the **departure+24h horizon** fix so late or
   long runs don't falsely report "no route."
7. **Scope trim.** Removed all default delivery sites (start from just the base) and
   **removed the learning/unlearning** feature entirely (static demo data with no real
   trip feed; judged not worth its complexity).
8. **Agent crew redesign.** Replaced the narration-only pipeline with the five real
   analysts above, including the Diagnostician's **auto-repair + preview** (Keep/Revert).
9. **n8n → free LLM.** Removed n8n; built the **provider-agnostic OpenAI-compatible
   adapter**, defaulting to **Google Gemini** (free tier) with a rule-based fallback.
   Added `GET /chat/info` and a dynamic **"chat: Gemini"** badge.
10. **UI redesign.** Panel moved to the left; the standalone "Result" box removed with
    its essentials relocated (totals into the run-sheet header, errors/auto-repair near
    the buttons); the warm/vibrant theme and fonts applied.
11. **Map framing fix.** Resolved the world-zoom/grey-band issue via `applyView()` +
    idle resize + re-frame on stop changes.

---

## 6. Key Engineering Decisions & Trade-offs

- **Math vs. language separation.** OR-Tools owns correctness; LLMs never compute the
  route. This keeps answers fast, reliable, and auditable, and lets the app run with no
  LLM at all.
- **"Leave now" realism vs. demo convenience.** Real ETAs from a real departure can
  render morning windows infeasible in the afternoon — which is *correct*. The editable
  departure field + the Diagnostician's auto-repair make this usable rather than a dead
  end.
- **Agents that earn their place.** After an explicit review, narration-only agents were
  replaced with ones whose decisions change outcomes (validation, feasibility
  prediction, auto-repair, quality judgment).
- **Provider-agnostic LLM.** A single OpenAI-compatible adapter supports Gemini, Groq,
  Ollama, and OpenAI by env vars alone, avoiding vendor lock-in and paid subscriptions.
- **Graceful degradation everywhere.** No OSRM → straight-line estimate; no LLM →
  rules/templates; unfixable run → honest "couldn't auto-repair."

---

## 7. Configuration & Running

**Backend** (`backend/.env`):
```
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_API_KEY=<gemini key>
LLM_MODEL=gemini-flash-lite-latest
OSRM_URL=https://router.project-osrm.org
```
Run: `cd backend && source .venv/bin/activate && uvicorn app:app --port 8000`

**Frontend** (`frontend/.env.local`):
```
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=<maps key>   # browser-only, referrer-restricted
NEXT_PUBLIC_N8N_CHAT_URL=                     # blank → use built-in /chat
```
Run: `cd frontend && npm run dev`  → http://localhost:3000

Keys are separated by surface: the **Maps key is public** (browser) and referrer-
restricted; the **LLM key is server-side** only (in `backend/.env`).

---

## 8. Known Limitations & Future Work

- **Single vehicle.** The model plans one van; multi-vehicle fleet routing is not yet
  modeled (OR-Tools supports it — a natural extension).
- **No live traffic.** OSRM gives typical, not live, drive times; ETAs are honest about
  this but will understate rush-hour durations.
- **Public OSRM limits.** The public server is rate-limited; production should point
  `OSRM_URL` at a self-hosted instance. The Diagnostician's re-solves are bounded to a
  few experiments to avoid excess calls.
- **Service area.** Hard-coded to Northern California (≤130 mi of the base).
- **Vestigial pieces.** `requirements.txt` still lists `scikit-learn`/`numpy` from the
  removed learning feature; the n8n workflow files and the flexible chat parser remain
  though n8n is no longer used — both harmless, removable in cleanup.
- **Chat scope.** Natural-language edits cover the common operations; compound requests
  ("drop A and move B to 9am") are handled one action per turn.

### Candidate next steps
Multi-van fleet routing · driver-facing mobile run sheet · a genuine "learn actual drop
times from completed deliveries" feedback loop · self-hosted OSRM · optional traffic-aware
provider · one-click apply of chat-suggested fixes.

---

*Prepared as an end-to-end technical overview of RouteMind. All subsystem behavior
described above reflects the current codebase (backend `solver.py` / `agents.py` /
`chat.py` / `app.py`; frontend `page.tsx` / `MapView.tsx` / `lib/*` / `globals.css`).*
