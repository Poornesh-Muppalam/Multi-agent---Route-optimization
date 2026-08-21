"use client";

import { memo } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Circle, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { Stop } from "../lib/types";

function pinIcon(label: string, depot: boolean): L.DivIcon {
  const cls = depot ? "pin teal" : "pin amber";
  return L.divIcon({
    className: "",
    html: `<div class="${cls}"><span>${label}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: depot ? [15, 15] : [15, 30],
  });
}

function ClickToAdd({ onAdd }: { onAdd: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onAdd(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

interface Props {
  stops: Stop[];
  orderedStopIds?: string[];
  returnedToStart?: boolean;
  onAdd: (lat: number, lng: number) => void;
  serviceRadiusMeters?: number;
}

function MapView({
  stops,
  orderedStopIds,
  returnedToStart,
  onAdd,
  serviceRadiusMeters,
}: Props) {
  const center: [number, number] =
    stops.length > 0 ? [stops[0].lat, stops[0].lng] : [37.3382, -121.8863];

  // The base anchors the service area; fall back to the map center.
  const base = stops.find((s) => s.id === "depot") ?? stops[0];
  const serviceCenter: [number, number] = base ? [base.lat, base.lng] : center;

  // Work out the number shown on each pin: its position along the route if we
  // have one, otherwise its position in the list.
  const positionById = new Map<string, number>();
  if (orderedStopIds && orderedStopIds.length > 0) {
    orderedStopIds.forEach((id, i) => positionById.set(id, i + 1));
  } else {
    stops.forEach((s, i) => positionById.set(s.id, i + 1));
  }

  // Build the route line from the ordered stops.
  let line: [number, number][] = [];
  if (orderedStopIds && orderedStopIds.length > 0) {
    const byId = new Map(stops.map((s) => [s.id, s]));
    line = orderedStopIds
      .map((id) => byId.get(id))
      .filter((s): s is Stop => Boolean(s))
      .map((s) => [s.lat, s.lng]);
    if (returnedToStart && line.length > 1) line.push(line[0]);
  }

  return (
    <MapContainer
      center={center}
      zoom={12}
      zoomControl={true}
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        attribution='&copy; OpenStreetMap contributors &copy; CARTO'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      {serviceRadiusMeters && (
        <Circle
          center={serviceCenter}
          radius={serviceRadiusMeters}
          pathOptions={{ color: "#35d6b0", weight: 1.5, opacity: 0.5, fillColor: "#35d6b0", fillOpacity: 0.05 }}
        />
      )}
      {line.length > 1 && (
        <Polyline
          positions={line}
          pathOptions={{ className: "route-line", color: "#f6a821", weight: 4, opacity: 0.95 }}
        />
      )}
      {stops.map((s, i) => (
        <Marker
          key={s.id}
          position={[s.lat, s.lng]}
          icon={pinIcon(String(positionById.get(s.id) ?? i + 1), i === 0)}
        />
      ))}
      <ClickToAdd onAdd={onAdd} />
    </MapContainer>
  );
}

export default memo(MapView);
