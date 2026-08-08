"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Stop, RouteResult, AgentInfo } from "./lib/types";
import { optimizeRoute, streamAgents } from "./lib/api";

// Leaflet touches the browser window, so the map only loads on the client.
const MapView = dynamic(() => import("./components/MapView"), { ssr: false });

// A real morning for a food-bank van: it leaves the warehouse and drops meals
// and groceries at community sites, several of which can only receive during a
// set serving window (a senior lunch, a morning shelter service, an
// after-school pantry). service_min is how long unloading takes on site.
const SEED_STOPS: Stop[] = [
  { id: "depot", name: "Community Food Bank", lat: 37.3382, lng: -121.8863 },
  { id: "s1", name: "Sunrise Senior Center", lat: 37.3541, lng: -121.9552, service_min: 15, window: [660, 750] }, // lunch 11:00–12:30
  { id: "s2", name: "Westside Family Shelter", lat: 37.323, lng: -121.943, service_min: 20, window: [540, 630] }, // morning 9:00–10:30
  { id: "s3", name: "Alum Rock Community Pantry", lat: 37.3688, lng: -121.911, service_min: 15 }, // any time
  { id: "s4", name: "Seven Trees After-School Pantry", lat: 37.302, lng: -121.848, service_min: 20, window: [870, 960] }, // 2:30–4:00 pm
];

export default function Home() {
  const [stops, setStops] = useState<Stop[]>(SEED_STOPS);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [returnToStart, setReturnToStart] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phase 2: the live agent activity.
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentMsgs, setAgentMsgs] = useState<Record<string, string>>({});
  const [agentsBusy, setAgentsBusy] = useState(false);
  const [agentModel, setAgentModel] = useState<{ model: string; live: boolean } | null>(null);

  const clearRun = () => {
    setRoute(null);
    setAgents([]);
    setAgentMsgs({});
    setError(null);
  };

  const addStop = (lat: number, lng: number) => {
    setStops((prev) => {
      const siteCount = prev.filter((s) => s.id !== "depot").length;
      return [...prev, { id: `s${Date.now()}`, name: `Delivery site ${siteCount + 1}`, lat, lng }];
    });
    clearRun();
  };

  const removeStop = (id: string) => {
    if (id === "depot") return;
    setStops((prev) => prev.filter((s) => s.id !== id));
    clearRun();
  };

  const optimize = async () => {
    setLoading(true);
    clearRun();
    try {
      const result = await optimizeRoute(stops, returnToStart);
      setRoute(result);
      if (!result.ok) setError(result.reason ?? "The route could not be solved.");
    } catch (e) {
      setError("Could not reach the backend. Is it running on port 8000?");
    } finally {
      setLoading(false);
    }
  };

  const optimizeWithAgents = async () => {
    setAgentsBusy(true);
    clearRun();
    try {
      await streamAgents(stops, returnToStart, (ev) => {
        if (ev.type === "pipeline") {
          setAgents(ev.agents);
          setAgentModel({ model: ev.model, live: ev.live });
        } else if (ev.type === "agent") {
          setAgentMsgs((m) => ({ ...m, [ev.agent]: ev.message }));
        } else if (ev.type === "result") {
          setRoute(ev.result);
          if (!ev.result.ok) setError(ev.result.reason ?? "The route could not be solved.");
        } else if (ev.type === "error") {
          setError(ev.message);
        }
      });
    } catch (e) {
      setError("Could not reach the backend. Is it running on port 8000?");
    } finally {
      setAgentsBusy(false);
    }
  };

  const reset = () => {
    setStops(SEED_STOPS);
    clearRun();
    setAgents([]);
  };

  // The first agent that hasn't reported yet is the one currently working.
  const runningAgent = agentsBusy
    ? agents.find((a) => !(a.id in agentMsgs))?.id ?? null
    : null;

  // Show stops in route order once we have a solution.
  const displayStops = useMemo(() => {
    if (route?.ok && route.ordered_stop_ids) {
      const byId = new Map(stops.map((s) => [s.id, s]));
      return route.ordered_stop_ids
        .map((id) => byId.get(id))
        .filter((s): s is Stop => Boolean(s));
    }
    return stops;
  }, [route, stops]);

  // The estimated arrival time at each site, once solved — this is the run sheet.
  const etaById = useMemo(() => {
    const m = new Map<string, number>();
    if (route?.ok && route.ordered_stop_ids && route.arrivals_min) {
      route.ordered_stop_ids.forEach((id, i) => {
        const a = route.arrivals_min![i];
        if (typeof a === "number") m.set(id, a);
      });
    }
    return m;
  }, [route]);

  const siteCount = stops.filter((s) => s.id !== "depot").length;
  const km = route?.total_distance_m ? (route.total_distance_m / 1000).toFixed(1) : "0";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <h1>RouteMind</h1>
          <span className="tag">food-bank delivery routing</span>
        </div>
        <span className="phase-pill">phase 2 · agents + solver</span>
      </header>

      <div className="body">
        <div className="map-wrap">
          <MapView
            stops={stops}
            orderedStopIds={route?.ok ? route.ordered_stop_ids : undefined}
            returnedToStart={route?.returned_to_start}
            onAdd={addStop}
          />
          <div className="hint">Click the map to add a delivery site.</div>
        </div>

        <aside className="panel">
          <section>
            <h2>Community Food Bank</h2>
            <p className="empty">
              Today's van run — meals and groceries out to {siteCount} community{" "}
              {siteCount === 1 ? "site" : "sites"}, several with a serving window that must be met.
              The agents build the shortest run that still hits every window, then hand the driver
              the run sheet below.
            </p>
          </section>

          <section>
            <h2>{route?.ok ? "Run sheet" : "Delivery sites"} ({siteCount})</h2>
            {displayStops.map((s, i) => {
              const isDepot = s.id === "depot";
              const eta = etaById.get(s.id);
              const meta: string[] = [];
              if (s.window) meta.push(`window ${fmtClock(s.window[0])}–${fmtClock(s.window[1])}`);
              if (!isDepot && s.service_min) meta.push(`${s.service_min} min drop`);
              if (!isDepot && typeof eta === "number") meta.push(`ETA ${fmtClock(eta)}`);
              return (
                <div className="stop-row" key={s.id}>
                  <span className={`badge ${isDepot ? "depot" : ""}`}>
                    {isDepot ? "H" : i + (displayStops[0]?.id === "depot" ? 0 : 1)}
                  </span>
                  <span className="name">
                    {isDepot ? `${s.name} (base)` : s.name}
                    {meta.length > 0 && <div className="meta">{meta.join(" · ")}</div>}
                  </span>
                  {!isDepot && (
                    <button className="remove" onClick={() => removeStop(s.id)} aria-label={`Remove ${s.name}`}>
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </section>

          <section>
            <label className="check">
              <input
                type="checkbox"
                checked={returnToStart}
                onChange={(e) => setReturnToStart(e.target.checked)}
              />
              Return to the food bank at the end
            </label>
            <button
              className="primary"
              onClick={optimizeWithAgents}
              disabled={agentsBusy || loading || stops.length < 2}
              style={{ marginTop: 16 }}
            >
              {agentsBusy ? "Agents working…" : "Optimize with agents ✨"}
            </button>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="ghost" onClick={optimize} disabled={loading || agentsBusy || stops.length < 2}>
                {loading ? "Optimizing…" : "Solver only"}
              </button>
              <button className="ghost" onClick={reset}>Reset</button>
            </div>
          </section>

          {agents.length > 0 && (
            <section>
              <h2>
                Agent activity
                {agentModel && (
                  <span className="meta" style={{ textTransform: "none", letterSpacing: 0, marginLeft: 8 }}>
                    {agentModel.live ? agentModel.model : "template mode"}
                  </span>
                )}
              </h2>
              {agents.map((a) => {
                const done = a.id in agentMsgs;
                const running = runningAgent === a.id;
                const state = done ? "done" : running ? "running" : "pending";
                return (
                  <div className={`agent-row ${state}`} key={a.id}>
                    <span className="agent-dot" />
                    <div className="agent-body">
                      <div className="agent-head">
                        <span className="agent-name">{a.label}</span>
                        <span className="agent-role">{a.role}</span>
                      </div>
                      {done && <div className="agent-msg">{agentMsgs[a.id]}</div>}
                      {running && <div className="agent-msg working">working…</div>}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          <section>
            <h2>Result</h2>
            {error && <div className="rule"><span className="mark">!</span>{error}</div>}
            {route?.ok && (
              <>
                <div className="stats">
                  <div className="stat">
                    <div className="num">{km}<span style={{ fontSize: 13 }}> km</span></div>
                    <div className="label">Total distance</div>
                  </div>
                  <div className="stat">
                    <div className="num">{route.total_time_min}<span style={{ fontSize: 13 }}> min</span></div>
                    <div className="label">Drive time</div>
                  </div>
                </div>
                {route.binding_rules && route.binding_rules.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    {route.binding_rules.map((r, i) => (
                      <div className="rule" key={i}><span className="mark">◆</span>{r}</div>
                    ))}
                  </div>
                )}
              </>
            )}
            {!route && !error && (
              <p className="empty">
                Add or remove delivery sites, then hit Optimize with agents. You'll get the
                shortest van run that still reaches every site inside its serving window —
                drawn on the map, with an arrival time (ETA) for each stop.
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function fmtClock(minutes: number): string {
  const total = Math.round(minutes);
  let h = Math.floor(total / 60) % 24;
  const m = total % 60;
  const suffix = h < 12 ? "am" : "pm";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${suffix}`;
}
