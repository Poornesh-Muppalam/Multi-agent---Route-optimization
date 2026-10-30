"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Stop, RouteResult, AgentInfo, ChatMessage, ChatDelta, Repair, ChatBrain } from "./lib/types";
import { optimizeRoute, streamAgents, sendChat, getChatBrain } from "./lib/api";

// Leaflet touches the browser window, so the map only loads on the client.
const MapView = dynamic(() => import("./components/MapView"), { ssr: false });

// RouteMind currently serves Northern California — the SF Bay Area and out to
// roughly 130 miles of the food-bank base. Clicks beyond this are refused.
const SERVICE_RADIUS_MILES = 130;
const SERVICE_RADIUS_METERS = SERVICE_RADIUS_MILES * 1609.344;

// Great-circle distance in miles, for the service-area check.
function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// The run starts empty except for the base (the food bank). The dispatcher adds
// delivery sites from the map/address search, then sets each site's serving
// window and drop time via the ⚙ conditions editor.
const SEED_STOPS: Stop[] = [
  { id: "depot", name: "Community Food Bank", lat: 37.3382, lng: -121.8863 },
];

export default function Home() {
  const [stops, setStops] = useState<Stop[]>(SEED_STOPS);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [returnToStart, setReturnToStart] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [condId, setCondId] = useState<string | null>(null); // which site's conditions editor is open
  const [warning, setWarning] = useState<string | null>(null);

  // When the van leaves the depot (minutes from midnight). ETAs are measured
  // from here. Start with a stable default for SSR, then snap to "now" on mount
  // (avoids a hydration mismatch from calling new Date() during render).
  const [departMin, setDepartMin] = useState<number>(480); // 8:00 am
  useEffect(() => {
    setDepartMin(nowMin());
  }, []);

  // Auto-dismiss the out-of-area warning after a few seconds.
  useEffect(() => {
    if (!warning) return;
    const t = setTimeout(() => setWarning(null), 7000);
    return () => clearTimeout(t);
  }, [warning]);

  // Phase 2: the live agent activity.
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentMsgs, setAgentMsgs] = useState<Record<string, string>>({});
  const [agentsBusy, setAgentsBusy] = useState(false);
  const [agentModel, setAgentModel] = useState<{ model: string; live: boolean } | null>(null);
  // An auto-repair the Diagnostician proposed for an infeasible run (preview).
  const [repair, setRepair] = useState<Repair | null>(null);

  // Stable across renders (only touches setters) so it doesn't re-create addStop.
  const clearRun = useCallback(() => {
    setRoute(null);
    setAgents([]);
    setAgentMsgs({});
    setError(null);
    setRepair(null);
  }, []);

  // useCallback keeps this reference stable while `stops` is unchanged, so the
  // memoized map does not re-render on every keystroke in the chat. `name` is
  // supplied when a site is added from an address search.
  const addStop = useCallback((lat: number, lng: number, name?: string) => {
    // Only allow sites inside the service area (Northern California / Bay Area).
    const base = stops.find((s) => s.id === "depot") ?? stops[0];
    const dist = base ? milesBetween(base.lat, base.lng, lat, lng) : 0;
    if (dist > SERVICE_RADIUS_MILES) {
      setWarning(
        `That location is about ${Math.round(dist)} miles from the food bank — outside our service area. ` +
          `RouteMind currently serves Northern California (the SF Bay Area, within ${SERVICE_RADIUS_MILES} miles). ` +
          `It isn't available in that region yet.`
      );
      return;
    }
    // Don't add a second marker at (essentially) the same spot as an existing one.
    const dup = stops.find(
      (s) => s.id !== "depot" && Math.abs(s.lat - lat) < 3e-4 && Math.abs(s.lng - lng) < 3e-4
    );
    if (dup) {
      setWarning(`"${dup.name}" is already on the run at that location.`);
      return;
    }
    setWarning(null);
    const id = `s${Date.now()}`;
    setStops((prev) => {
      const siteCount = prev.filter((s) => s.id !== "depot").length;
      return [...prev, { id, name: name || `Delivery site ${siteCount + 1}`, lat, lng }];
    });
    clearRun();
    setEditingId(name ? null : id); // named (from address) sites don't need rename mode
  }, [stops, clearRun]);

  const removeStop = (id: string) => {
    if (id === "depot") return;
    setStops((prev) => prev.filter((s) => s.id !== id));
    if (condId === id) setCondId(null);
    clearRun();
  };

  const renameStop = (id: string, name: string) => {
    setStops((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  };

  // Update a site's conditions (serving window / drop time). Any change
  // invalidates the current run, so clear it and let the user re-optimize.
  const updateStop = (id: string, patch: Partial<Stop>) => {
    setStops((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    clearRun();
  };

  // Leaving the editor: fall back to a placeholder if the name was left blank.
  const commitName = (id: string) => {
    setStops((prev) =>
      prev.map((s) => (s.id === id && !s.name.trim() ? { ...s, name: "Untitled site" } : s))
    );
    setEditingId(null);
  };

  const optimize = async () => {
    setLoading(true);
    clearRun();
    try {
      const result = await optimizeRoute(stops, returnToStart, departMin);
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
          setRepair(ev.repair ?? null);
          if (!ev.result.ok && !ev.repair) {
            setError(ev.result.reason ?? "The route could not be solved.");
          }
        } else if (ev.type === "error") {
          setError(ev.message);
        }
      }, departMin);
    } catch (e) {
      setError("Could not reach the backend. Is it running on port 8000?");
    } finally {
      setAgentsBusy(false);
    }
  };

  // Accept the Diagnostician's auto-repair: commit its changed sites/departure.
  const keepRepair = () => {
    if (!repair) return;
    setStops(repair.stops);
    setReturnToStart(repair.return_to_start);
    setDepartMin(repair.depart_min);
    setError(null);
    setRepair(null);
  };

  // Reject the auto-repair: fall back to the original infeasible result.
  const revertRepair = () => {
    if (!repair) return;
    setRoute(null);
    setError(repair.original_reason);
    setRepair(null);
  };

  // Full reset back to the initial screen: seed sites, cleared route/agents,
  // chat, warnings, and the return-to-base toggle.
  const reset = () => {
    setStops(SEED_STOPS);
    setReturnToStart(true);
    clearRun();
    setAgents([]);
    setAgentMsgs({});
    setAgentModel(null);
    setChatLog([]);
    setChatInput("");
    setWarning(null);
    setEditingId(null);
    setCondId(null);
  };

  // Phase 3: the chat.
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [chatBrain, setChatBrain] = useState<ChatBrain | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Discover which brain powers the chat (Gemini / Groq / Claude / Rules).
  useEffect(() => {
    getChatBrain().then(setChatBrain).catch(() => setChatBrain(null));
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatLog, chatBusy]);

  // The core turn: send one message and append the reply. On failure the reply
  // carries `retryText` so it can be re-sent. Does not echo the user bubble —
  // callers add it (or leave the existing one in place, as retry does).
  const runChat = async (msg: string) => {
    setChatBusy(true);
    try {
      const res = await sendChat(stops, returnToStart, msg, route, departMin);
      if (res.ok && res.stops) {
        setStops(res.stops);
        if (typeof res.return_to_start === "boolean") setReturnToStart(res.return_to_start);
        if (res.result) setRoute(res.result);
        setError(null);
        setWarning(null);
      }
      setChatLog((l) => [
        ...l,
        { role: "assistant", text: res.reply, delta: res.delta, ok: res.ok, retryText: res.ok ? undefined : msg },
      ]);
    } catch {
      setChatLog((l) => [
        ...l,
        { role: "assistant", text: "Couldn't reach the backend on port 8000.", ok: false, retryText: msg },
      ]);
    } finally {
      setChatBusy(false);
    }
  };

  const sendChatMessage = async (preset?: string) => {
    const msg = (preset ?? chatInput).trim();
    if (!msg || chatBusy) return;
    setChatInput("");
    setEditingId(null);
    setChatLog((l) => [...l, { role: "user", text: msg }]);
    await runChat(msg);
  };

  // Re-run a failed reply's original request, replacing the failed bubble.
  const retryMessage = (idx: number) => {
    if (chatBusy) return;
    const target = chatLog[idx]?.retryText;
    if (!target) return;
    setChatLog((l) => l.filter((_, i) => i !== idx));
    runChat(target);
  };

  const clearChat = () => {
    if (chatBusy) return;
    setChatLog([]);
    setChatInput("");
    setCopiedIdx(null);
  };

  const copyMessage = async (idx: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context) — silently ignore.
    }
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
  const miles = route?.total_distance_m ? (route.total_distance_m / 1609.344).toFixed(1) : "0";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <h1>RouteMind</h1>
          <span className="tag">food-bank delivery routing</span>
        </div>
        <span className="phase-pill">agents · chat · live ETAs</span>
      </header>

      <div className="body">
        <div className="map-wrap">
          <MapView
            stops={stops}
            orderedStopIds={route?.ok ? route.ordered_stop_ids : undefined}
            returnedToStart={route?.returned_to_start}
            onAdd={addStop}
            onWarn={setWarning}
            serviceRadiusMeters={SERVICE_RADIUS_METERS}
          />
          {warning && (
            <div className="warn" role="alert">
              <span className="warn-mark">⚠</span>
              <span>{warning}</span>
              <button className="warn-x" onClick={() => setWarning(null)} aria-label="Dismiss">×</button>
            </div>
          )}
          <div className="hint">
            Search an address, or click on land inside the shaded area (Northern California, within {SERVICE_RADIUS_MILES} mi).
          </div>
        </div>

        <aside className="panel">
          <section>
            <h2>Community Food Bank</h2>
            <p className="empty">
              {siteCount === 0 ? (
                <>
                  Add delivery sites to plan today's van run — search an address or click on the
                  map, then set each site's serving window and drop time with the ⚙ button. The
                  agents build the shortest run that still hits every window.
                </>
              ) : (
                <>
                  Today's van run — meals and groceries out to {siteCount} community{" "}
                  {siteCount === 1 ? "site" : "sites"}. Set each site's serving window and drop time
                  with the ⚙ button; the agents build the shortest run that still hits every window,
                  then hand the driver the run sheet below.
                </>
              )}
            </p>
          </section>

          <section>
            <h2 className="sheet-head">
              <span>{route?.ok ? "Run sheet" : "Delivery sites"} ({siteCount})</span>
              {route?.ok && (
                <span className="sheet-totals">
                  {miles} mi · {route.total_time_min} min
                </span>
              )}
            </h2>
            {route?.ok && route.distance_source && (
              <p className="sheet-src">
                {route.distance_source === "road"
                  ? "Real road distances & drive times (OSRM) · not live traffic."
                  : "Straight-line estimate at ~19 mph · routing service unavailable."}
              </p>
            )}
            {displayStops.map((s, i) => {
              const isDepot = s.id === "depot";
              const eta = etaById.get(s.id);
              const meta: string[] = [];
              if (s.window) meta.push(`window ${fmtClock(s.window[0])}–${fmtClock(s.window[1])}`);
              if (!isDepot && s.service_min) meta.push(`${s.service_min} min drop`);
              if (!isDepot && typeof eta === "number") meta.push(`ETA ${fmtClock(eta)}`);
              const hasWindow = Boolean(s.window);
              return (
                <div key={s.id}>
                  <div className="stop-row">
                    <span className={`badge ${isDepot ? "depot" : ""}`}>
                      {isDepot ? "H" : i + (displayStops[0]?.id === "depot" ? 0 : 1)}
                    </span>
                    <span className="name">
                      {editingId === s.id ? (
                        <input
                          className="name-edit"
                          autoFocus
                          value={s.name}
                          placeholder="Name this site"
                          onChange={(e) => renameStop(s.id, e.target.value)}
                          onFocus={(e) => e.currentTarget.select()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Escape") commitName(s.id);
                          }}
                          onBlur={() => commitName(s.id)}
                        />
                      ) : (
                        <button
                          className="name-text"
                          onClick={() => setEditingId(s.id)}
                          title="Click to rename"
                        >
                          {isDepot ? `${s.name} (base)` : s.name}
                          <span className="edit-hint">✎</span>
                        </button>
                      )}
                      {meta.length > 0 && <div className="meta">{meta.join(" · ")}</div>}
                    </span>
                    {!isDepot && (
                      <button
                        className={`cond-btn ${condId === s.id ? "on" : ""}`}
                        onClick={() => setCondId(condId === s.id ? null : s.id)}
                        aria-label={`Conditions for ${s.name}`}
                        title="Serving window & drop time"
                      >
                        ⚙
                      </button>
                    )}
                    {!isDepot && (
                      <button className="remove" onClick={() => removeStop(s.id)} aria-label={`Remove ${s.name}`}>
                        ×
                      </button>
                    )}
                  </div>

                  {!isDepot && condId === s.id && (
                    <div className="cond-editor">
                      <div className="cond-field">
                        <label>Drop time</label>
                        <input
                          type="number"
                          className="cond-input"
                          min={0}
                          max={240}
                          value={s.service_min ?? 0}
                          onChange={(e) =>
                            updateStop(s.id, { service_min: Math.max(0, Math.min(240, Number(e.target.value) || 0)) })
                          }
                        />
                        <span className="cond-unit">min on site</span>
                      </div>

                      <div className="cond-field">
                        <label className="cond-check">
                          <input
                            type="checkbox"
                            checked={hasWindow}
                            onChange={(e) =>
                              updateStop(s.id, { window: e.target.checked ? s.window ?? [540, 630] : null })
                            }
                          />
                          Serving window
                        </label>
                      </div>

                      {hasWindow && (
                        <div className="cond-field cond-window">
                          <input
                            type="time"
                            className="cond-input"
                            value={s.window ? toTimeInput(s.window[0]) : ""}
                            onChange={(e) => {
                              const v = parseTimeInput(e.target.value);
                              if (v != null) updateStop(s.id, { window: [v, s.window?.[1] ?? v] });
                            }}
                          />
                          <span className="cond-unit">to</span>
                          <input
                            type="time"
                            className="cond-input"
                            value={s.window ? toTimeInput(s.window[1]) : ""}
                            onChange={(e) => {
                              const v = parseTimeInput(e.target.value);
                              if (v != null) updateStop(s.id, { window: [s.window?.[0] ?? v, v] });
                            }}
                          />
                        </div>
                      )}
                      {hasWindow && s.window && s.window[1] <= s.window[0] && (
                        <div className="cond-warn">End time must be after the start time.</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {route?.ok && route.binding_rules && route.binding_rules.length > 0 && (
              <div className="sheet-rules">
                {route.binding_rules.map((r, i) => (
                  <div className="rule" key={i}><span className="mark">◆</span>{r}</div>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="depart-row">
              <span className="depart-label">Van leaves at</span>
              <input
                type="time"
                className="cond-input"
                value={toTimeInput(departMin)}
                onChange={(e) => {
                  const v = parseTimeInput(e.target.value);
                  if (v != null) {
                    setDepartMin(v);
                    clearRun();
                  }
                }}
              />
              <button
                className="chip"
                onClick={() => {
                  setDepartMin(nowMin());
                  clearRun();
                }}
                title="Set to the current time"
              >
                now
              </button>
            </div>
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

            {repair && (
              <div className="repair-banner" role="status" style={{ marginTop: 14, marginBottom: 0 }}>
                <div className="repair-head">
                  <span className="repair-mark">✦</span>
                  <span>Diagnostician auto-repaired the run</span>
                </div>
                <p className="repair-desc">{repair.description}</p>
                <div className="row">
                  <button className="primary" style={{ padding: "8px 14px" }} onClick={keepRepair}>
                    Keep this fix
                  </button>
                  <button className="ghost" onClick={revertRepair}>Revert</button>
                </div>
              </div>
            )}
            {error && (
              <div className="rule" style={{ marginTop: 14 }}>
                <span className="mark">!</span>{error}
              </div>
            )}
          </section>

          <section>
            <h2 className="chat-head">
              <span className="chat-title">
                Change the run
                {chatBrain && (
                  <span
                    className={`chat-brain ${chatBrain.live ? "" : "offline"}`}
                    title={chatBrain.live ? `Powered by ${chatBrain.label}${chatBrain.model ? ` (${chatBrain.model})` : ""}` : "No LLM key set — using the rule-based parser"}
                  >
                    chat: {chatBrain.label}
                  </span>
                )}
              </span>
              {chatLog.length > 0 && (
                <button className="clear-chat" onClick={clearChat} disabled={chatBusy}>
                  Clear chat
                </button>
              )}
            </h2>
            <div className="chat-log">
              {chatLog.length === 0 && (
                <p className="empty">
                  Ask a question about the run ("should I leave earlier to beat traffic?", "why this
                  order?") or tell me a change ("drop the senior center", "put the shelter first") —
                  I'll re-plan and say what it cost.
                </p>
              )}
              {chatLog.map((m, i) => (
                <div
                  key={i}
                  className={`bubble ${m.role}${m.ok === false ? " bad" : ""}`}
                >
                  {m.text}
                  {m.delta && (m.delta.distance_mi !== 0 || m.delta.time_min !== 0) && (
                    <div className="delta">{fmtDelta(m.delta)}</div>
                  )}
                  {m.role === "assistant" && (
                    <div className="bubble-actions">
                      <button
                        className="msg-act"
                        onClick={() => copyMessage(i, m.text)}
                        title="Copy this reply"
                      >
                        {copiedIdx === i ? "Copied ✓" : "Copy"}
                      </button>
                      {m.retryText && (
                        <button
                          className="msg-act"
                          onClick={() => retryMessage(i)}
                          disabled={chatBusy}
                          title="Send this request again"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {chatBusy && <div className="bubble assistant typing">re-planning…</div>}
              <div ref={chatEndRef} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <input
                className="text"
                value={chatInput}
                placeholder="e.g. put Seven Trees last"
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendChatMessage();
                }}
                disabled={chatBusy}
              />
              <button
                className="ghost"
                onClick={() => sendChatMessage()}
                disabled={chatBusy || !chatInput.trim()}
              >
                Send
              </button>
            </div>
            <div className="chips">
              {[
                "should I leave earlier to beat traffic?",
                "why this order?",
                "drop the senior center",
                "put the shelter first",
                "don't return to the food bank",
              ].map((s) => (
                <button key={s} className="chip" onClick={() => sendChatMessage(s)} disabled={chatBusy}>
                  {s}
                </button>
              ))}
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

        </aside>
      </div>
    </div>
  );
}

// Current local wall-clock time as minutes from midnight — the van's "leave now"
// departure, so ETAs are relative to the real current time.
function nowMin(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function fmtClock(minutes: number): string {
  const total = Math.round(minutes);
  let h = Math.floor(total / 60) % 24;
  const m = total % 60;
  const suffix = h < 12 ? "am" : "pm";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${suffix}`;
}

function fmtDelta(d: ChatDelta): string {
  const sign = (v: number) => (v > 0 ? `+${v}` : `${v}`);
  return `${sign(d.distance_mi)} mi · ${sign(d.time_min)} min vs before`;
}

// "HH:MM" (24h, from <input type="time">) → minutes from midnight.
function parseTimeInput(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// minutes from midnight → "HH:MM" for an <input type="time"> value.
function toTimeInput(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = Math.round(min) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
