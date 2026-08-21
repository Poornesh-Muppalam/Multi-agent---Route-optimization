# RouteMind

An interactive route planner where a small team of AI agents plan the smartest driving route and explain every choice, live. You describe your stops and rules in plain English, a real solver does the optimization, and the map redraws as you adjust.

Built for the people who actually plan routes by hand today: a local courier, a florist doing morning drops, a repair tech with a day of house calls, a food bank running a van. They either pay for heavy dispatch software or plan on Google Maps by memory. RouteMind gives them big company routing without the big company cost.

![RouteMind architecture](docs/architecture.svg)

## Who this is for, and the demo scenario

The app ships centered on one concrete operator so the value is obvious: **a community food bank running a delivery van**. A driver leaves the warehouse each morning and drops meals and groceries at community sites — a senior center's lunch, a family shelter's morning service, an after-school pantry — and several of those sites can only receive during a fixed serving window. Get there late and the meal is missed.

That is exactly the problem a solver is good at and a person is not: order a day of stops so every hard time window is met while the total drive stays short. The built-in scenario has four San Jose delivery sites (three with serving windows) plus the food-bank base.

**The deliverable is a run sheet.** Hit *Optimize with agents* and RouteMind returns the driver's actual work order: which site to visit in what order, the estimated arrival time (ETA) at each one, the total distance and drive time, and which serving windows forced the order — with the agents narrating each step as they build it. The same design serves the florist, the repair tech, and the courier; only the stops and the windows change.

## Why it is built this way

The interesting design decision is what does the thinking. The AI agents handle the language, the coordination, and the plain English explanations. The actual route math is done by Google OR-Tools, a real optimization solver, not by a language model. Letting a language model do routing arithmetic would be slow and unreliable. Knowing when to use an AI model and when to use a proper solver is the whole point of the architecture, and it keeps the answers fast and trustworthy.

So RouteMind is an honest hybrid: agents for language, a solver for math, and a live interface that shows the work.

## What you can do right now (Phases 1 and 2)

- See a set of stops on a live map the moment the app loads.
- Click anywhere on the map to add a stop.
- Set a time window rule on a stop (for example, the pharmacy must be reached between 9 and 11 am).
- Hit **Solver only** and watch the shortest valid order get drawn on the map.
- Hit **Optimize with agents** and watch the five-agent crew work step by step in a live activity panel, then draw the same optimized route with a plain-English explanation.
- Type a change in plain English ("drop the senior center", "put the shelter first") and watch the run re-plan, with RouteMind explaining what changed and what it cost.
- Read the total distance, the drive time, and which rules were binding.

### The agent crew (Phase 2)

LangGraph wires five agents into a pipeline; only the optimizer touches the real math.

| Agent | Job |
| --- | --- |
| Planner | States the plan for turning the stops into a route. |
| Data | Confirms the stops are ready for routing. |
| Conditions | Restates the time window rules in plain English. |
| Optimizer | Calls the OR-Tools solver — the one agent that does real math. |
| Explainer | Explains the finished route to a non-technical user. |

The language work runs on a fast Claude model (`claude-haiku-4-5` by default). The steps stream to the browser over Server-Sent Events. Set your key in `backend/.env` to use a real model; without a key the agents fall back to deterministic template text so the app still runs.

Backend endpoints added in Phase 2:

- `POST /optimize/agents` — run the whole crew once, return the final state.
- `POST /optimize/agents/stream` — stream each agent's step live (SSE).

### The chat (Phase 3)

Type a plain-English change to the run in the **Change the run** box and RouteMind interprets it, re-plans, and tells you what it cost:

- "drop the senior center" — remove a site.
- "move the shelter to 8 to 9 am" — set or change a serving window.
- "the shelter needs 30 minutes to unload" — set a site's drop time.
- "put Seven Trees last" / "put the shelter first" — pin a site's position (honoured as a hard ordering constraint by OR-Tools).
- "don't return to the food bank" — one-way run.
- "re-optimize" — just re-run.

Each reply says what changed and the distance/drive-time delta versus the previous run. If a change can't be met — e.g. forcing a windowed site out of its window — RouteMind says so and leaves the run unchanged. Interpretation uses the fast Claude model when a key is present, with a rule-based fallback so the chat still works without one. As always, the language model only decides *what* to change; OR-Tools does the routing.

Backend endpoint added in Phase 3:

- `POST /chat` — interpret a change, apply it, re-solve, and return the new run plus an explanation and cost delta.

### Learning and unlearning (Phase 4)

Phase 1 assumed a fixed unload time per site. In reality the on-site service time varies — by site, by how much is delivered, by the day. A small **scikit-learn** model (`backend/learning.py`) learns each site's real service time from a log of past trips, and the **Learned drop times** panel shows the learned minutes against the old default (e.g. a stop planned at 15 min really takes ~20). *Apply learned times to the run* pushes those into the plan so the ETAs reflect what actually happens. Travel time still comes from the road network (OSRM); the model refines the human part of the run.

It also supports the **right to be forgotten**. *Forget* on a site calls an unlearning agent that removes that site's trips and **retrains** — exact unlearning, not an approximation — so its history no longer influences any prediction. The model is small on purpose: it fits in milliseconds, which is what makes retrain-to-forget practical.

There is no real trip log yet, so on first run the backend generates a clearly-labelled synthetic history (`trips.json`, git-ignored) that stands in for real logged deliveries. In production this is where your actual delivery records would go.

Backend endpoints added in Phase 4:

- `GET /model` — the learned vs default service time per site, trip counts, and fit error.
- `POST /model/unlearn` — forget one site's trips and retrain (right to be forgotten).
- `POST /model/reset` — regenerate the demo trip log and retrain.

## Build phases

Phase 1 is complete and runnable. The later phases layer on top of this same foundation.

- [x] Phase 1: the map and the solver. Add stops, respect time window rules, draw the optimized route.
- [x] Phase 2: the agents. LangGraph plus a fast language model coordinate the planner, data, conditions, optimizer, and explainer agents, and stream their steps into a live activity panel.
- [x] Phase 3: the chat. Say "put the shelter first" or "drop the senior center" and watch the run redraw, with the explainer telling you what changed and what it cost.
- [x] Phase 4: learning and unlearning. A small model learns real on-site service times from past trips, and an unlearning agent removes a single site's influence from that model on request, so the system stays privacy compliant when someone exercises their right to be forgotten.

## Deploy

RouteMind is two programs, so it deploys as two services (both have free tiers and connect to this GitHub repo): the FastAPI backend on **Render**, the Next.js frontend on **Vercel**.

### 1. Backend on Render

1. Push this repo to GitHub (already done).
2. In Render, create a new **Blueprint** and point it at the repo — Render reads [`render.yaml`](render.yaml) and provisions the `routemind-api` web service automatically (root `backend/`, `uvicorn app:app --host 0.0.0.0 --port $PORT`).
   - Or create a **Web Service** by hand: Root Directory `backend`, Build `pip install -r requirements.txt`, Start `uvicorn app:app --host 0.0.0.0 --port $PORT`.
3. (Optional) In the service's **Environment**, add `ANTHROPIC_API_KEY` to run the agents/chat on Claude instead of the template fallback.
4. Note the service URL, e.g. `https://routemind-api.onrender.com`. Open it to see the health check.

> The free tier sleeps after inactivity, so the first request after idle takes ~30–60s to wake.

### 2. Frontend on Vercel

1. In Vercel, **Import** the same GitHub repo.
2. Set **Root Directory** to `frontend`.
3. Add an environment variable **`NEXT_PUBLIC_BACKEND_URL`** = your Render URL from step 1 (set it *before* deploying — it's baked in at build time).
4. Deploy. Vercel auto-detects Next.js; open the resulting URL and you have the live app.

CORS is already open on the backend, so the Vercel frontend can call the Render backend out of the box. To point a local frontend at a deployed backend instead, set the same variable in `frontend/.env.local`.

## Tech stack

- Frontend: Next.js 14, TypeScript, React, Leaflet with OpenStreetMap tiles.
- Backend: FastAPI (Python) with Google OR-Tools for the optimization, LangGraph for the agent graph, a fast hosted language model (Claude) for the agents, OSRM for real road distances, and scikit-learn for the learned service-time model.
- Deploy: Render (backend) + Vercel (frontend).

## Getting started

You run two small programs, the Python backend and the Next.js frontend, each in its own terminal. When you open the frontend in your browser, you are looking at the finished result.

### 1. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # optional: paste an ANTHROPIC_API_KEY for real Claude agents
uvicorn app:app --reload --port 8000 --env-file .env
```

The API is now live at http://127.0.0.1:8000. You can open that address to see a health check.

### 2. Frontend

In a second terminal:

```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

Open http://localhost:3000 and you will see the map with seeded stops. Click Optimize.

## Project structure

```
routemind/
├── backend/
│   ├── app.py            FastAPI app, the /optimize and agent endpoints
│   ├── solver.py         OR-Tools solver + real road distances (OSRM)
│   ├── agents.py         the LangGraph agent crew (Phase 2)
│   ├── chat.py           the plain-English chat: edits + questions (Phase 3)
│   ├── learning.py       the learned service-time model + unlearning (Phase 4)
│   └── requirements.txt
├── frontend/
│   └── app/
│       ├── page.tsx      main screen, state, and the control panel
│       ├── layout.tsx
│       ├── globals.css   the dispatch console styling
│       ├── components/
│       │   └── MapView.tsx   Leaflet map, numbered pins, route line
│       └── lib/
│           ├── api.ts        calls the backend
│           └── types.ts
└── docs/
    └── architecture.svg
```

## Notes on realism

RouteMind now uses **real road distances and drive times** from a routing service (OSRM) rather than straight-line estimates — so the distances, drive times, and ETAs reflect the actual road network. It falls back to a straight-line estimate at a fixed average speed only if the routing service is unreachable, and every result reports which source it used. Set `OSRM_URL` in `backend/.env` to point at your own OSRM instance for production, or `ROUTEMIND_ROUTING=off` to force the estimate.

The remaining step toward full realism is **live traffic**: the public OSRM server reflects the road network but not current congestion. Wiring a traffic-aware provider (e.g. a keyed Distance Matrix API with `departure_time=now`) is a drop-in change behind the same solver interface — the design doesn't change, only the data source behind the numbers.

## License

MIT. See [LICENSE](LICENSE).
