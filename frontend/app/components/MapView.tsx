"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GoogleMap,
  Marker,
  Circle,
  Polyline,
  Autocomplete,
  useJsApiLoader,
} from "@react-google-maps/api";
import type { Stop } from "../lib/types";

// Static so the loader doesn't re-init on every render. "geometry" powers the
// smooth vehicle interpolation along the route.
const LIBRARIES: ("places" | "geometry")[] = ["places", "geometry"];
const FALLBACK_CENTER = { lat: 37.3382, lng: -121.8863 };

// Reverse-geocode types that only exist on developed land (a real road or
// address at the click). Water — the Pacific and the Bay — has none of these;
// Google only returns generic "plus_code"/"locality" results there, so we
// deliberately exclude those to keep clicks on land.
const LAND_TYPES = new Set([
  "street_address", "route", "premise", "subpremise", "intersection",
]);

interface Props {
  stops: Stop[];
  orderedStopIds?: string[];
  returnedToStart?: boolean;
  onAdd: (lat: number, lng: number, name?: string) => void;
  onWarn: (message: string) => void;
  serviceRadiusMeters?: number;
}

function MapView(props: Props) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const { isLoaded, loadError } = useJsApiLoader({
    id: "routemind-gmaps",
    googleMapsApiKey: apiKey ?? "",
    libraries: LIBRARIES,
  });

  if (!apiKey) {
    return (
      <div className="map-msg">
        <b>Google Maps needs an API key.</b>
        <span>
          Set <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> (in <code>frontend/.env.local</code> locally,
          or as a Vercel environment variable) and reload. Enable the Maps JavaScript, Directions,
          Places, and Geocoding APIs on your Google Cloud project.
        </span>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="map-msg">
        <b>Couldn&apos;t load Google Maps.</b>
        <span>Check that the API key is valid and the required APIs are enabled and billed.</span>
      </div>
    );
  }
  if (!isLoaded) return <div className="map-msg">Loading map…</div>;

  return <MapInner {...props} />;
}

function MapInner({ stops, orderedStopIds, returnedToStart, onAdd, onWarn, serviceRadiusMeters }: Props) {
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const acRef = useRef<google.maps.places.Autocomplete | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastPlaceRef = useRef<string | null>(null);
  const vehicleRef = useRef<google.maps.Marker | null>(null);
  const rafRef = useRef<number | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);

  const base = stops.find((s) => s.id === "depot") ?? stops[0];
  const center = base ? { lat: base.lat, lng: base.lng } : FALLBACK_CENTER;

  // Pin number = the delivery site's position (route order if solved, else list
  // order). The depot shows "H" and is NOT counted, so these match the run-sheet
  // numbers exactly (sites start at 1).
  const positionById = new Map<string, number>();
  const orderIds = orderedStopIds && orderedStopIds.length > 0 ? orderedStopIds : stops.map((s) => s.id);
  let siteNo = 0;
  orderIds.forEach((id) => {
    if (id === "depot") return;
    positionById.set(id, (siteNo += 1));
  });

  // Fetch the real street-by-street route through the optimized order.
  useEffect(() => {
    if (!orderedStopIds || orderedStopIds.length < 2) {
      setDirections(null);
      return;
    }
    const byId = new Map(stops.map((s) => [s.id, s]));
    const pts = orderedStopIds.map((id) => byId.get(id)).filter((s): s is Stop => Boolean(s));
    if (pts.length < 2) {
      setDirections(null);
      return;
    }
    const origin = { lat: pts[0].lat, lng: pts[0].lng };
    const rest = pts.slice(1).map((s) => ({ lat: s.lat, lng: s.lng }));
    const destination = returnedToStart ? origin : rest[rest.length - 1];
    const mids = returnedToStart ? rest : rest.slice(0, -1);
    const waypoints = mids.map((location) => ({ location, stopover: true }));

    let cancelled = false;
    new google.maps.DirectionsService().route(
      { origin, destination, waypoints, optimizeWaypoints: false, travelMode: google.maps.TravelMode.DRIVING },
      (result, status) => {
        if (!cancelled) setDirections(status === "OK" ? result : null);
      }
    );
    return () => { cancelled = true; };
  }, [orderedStopIds, stops, returnedToStart]);

  // A detailed, street-accurate path (every step's points) for the blue line
  // and the moving vehicle.
  const routePath = useMemo<google.maps.LatLng[] | null>(() => {
    const route = directions?.routes?.[0];
    if (!route) return null;
    const pts: google.maps.LatLng[] = [];
    route.legs.forEach((leg) => leg.steps.forEach((step) => (step.path || []).forEach((p) => pts.push(p))));
    return pts.length > 1 ? pts : null;
  }, [directions]);

  // Drive the vehicle arrow ONCE from the warehouse along the route, then stop
  // (no looping). Updates the marker directly so we don't re-render each frame.
  useEffect(() => {
    if (!routePath || routePath.length < 2) return;
    const sph = google.maps.geometry.spherical;
    const cum: number[] = [0];
    for (let i = 1; i < routePath.length; i++) {
      cum[i] = cum[i - 1] + sph.computeDistanceBetween(routePath[i - 1], routePath[i]);
    }
    const total = cum[cum.length - 1] || 1;
    const duration = 9000; // a single pass of the route

    const posAt = (f: number) => {
      const d = f * total;
      let i = 1;
      while (i < cum.length && cum[i] < d) i++;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(routePath.length - 1, i);
      const seg = cum[i1] - cum[i0] || 1;
      const lf = Math.max(0, Math.min(1, (d - cum[i0]) / seg));
      return sph.interpolate(routePath[i0], routePath[i1], lf);
    };

    const arrow = (rotation: number) => ({
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 6, fillColor: "#1a73e8", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2, rotation,
    });

    // Start parked at the warehouse, pointing toward the first turn.
    const eps = 0.005;
    vehicleRef.current?.setPosition(posAt(0));
    vehicleRef.current?.setIcon(arrow(sph.computeHeading(posAt(0), posAt(eps))));

    let startT = 0;
    const tick = (now: number) => {
      if (!startT) startT = now;
      const f = Math.min(1, (now - startT) / duration);
      const heading = sph.computeHeading(posAt(Math.max(0, f - eps)), posAt(Math.min(1, f + eps)));
      vehicleRef.current?.setPosition(posAt(f));
      vehicleRef.current?.setIcon(arrow(heading));
      if (f < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [routePath]);

  // Frame the map: fit all stops when there are several, else center on the base
  // at a city zoom. Never leaves the map at world-zoom.
  const applyView = (map: google.maps.Map) => {
    if (stops.length > 1) {
      const bounds = new google.maps.LatLngBounds();
      stops.forEach((s) => bounds.extend({ lat: s.lat, lng: s.lng }));
      map.fitBounds(bounds, 64);
    } else {
      map.setCenter(center);
      map.setZoom(12);
    }
  };

  const onMapLoad = useCallback((map: google.maps.Map) => {
    mapRef.current = map;
    applyView(map);
    // Flex containers get their real size just after mount; once the map is
    // idle, tell it to re-measure and re-frame so it doesn't sit at world-zoom.
    google.maps.event.addListenerOnce(map, "idle", () => {
      google.maps.event.trigger(map, "resize");
      applyView(map);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-frame when sites are added or removed.
  useEffect(() => {
    if (mapRef.current) applyView(mapRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops.length]);

  // Click to add — but only if the spot is on land (reject water).
  const handleClick = useCallback(
    (e: google.maps.MapMouseEvent) => {
      const lat = e.latLng?.lat();
      const lng = e.latLng?.lng();
      if (lat == null || lng == null) return;
      if (!geocoderRef.current) geocoderRef.current = new google.maps.Geocoder();
      geocoderRef.current.geocode({ location: { lat, lng } }, (results, status) => {
        const onLand =
          status === "OK" && !!results && results.some((r) => (r.types || []).some((t) => LAND_TYPES.has(t)));
        if (onLand) onAdd(lat, lng);
        else onWarn("No street there — that looks like water. Click on a road/address on land, or use the address search.");
      });
    },
    [onAdd, onWarn]
  );

  const onPlaceChanged = useCallback(() => {
    const place = acRef.current?.getPlace();
    const loc = place?.geometry?.location;

    // Happy path: the user picked a suggestion — we get geometry + a place_id.
    if (loc && place?.place_id) {
      if (place.place_id === lastPlaceRef.current) return;
      lastPlaceRef.current = place.place_id;
      const name = place.name || place.formatted_address?.split(",")[0] || "New delivery site";
      onAdd(loc.lat(), loc.lng(), name);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    // Fallback: the user typed an address and pressed Enter without choosing a
    // suggestion — geocode the raw text so it still gets added.
    const text = inputRef.current?.value?.trim();
    if (!text) {
      onWarn("Type an address, then pick a suggestion or press Enter.");
      return;
    }
    if (text === lastPlaceRef.current) return; // ignore a repeat Enter on same text
    lastPlaceRef.current = text;
    if (!geocoderRef.current) geocoderRef.current = new google.maps.Geocoder();
    geocoderRef.current.geocode(
      { address: text, componentRestrictions: { country: "us" } },
      (results, status) => {
        if (status === "OK" && results && results[0]) {
          const r = results[0];
          const l = r.geometry.location;
          const name = text.split(",")[0] || r.formatted_address?.split(",")[0] || "New delivery site";
          onAdd(l.lat(), l.lng(), name);
          if (inputRef.current) inputRef.current.value = "";
        } else {
          onWarn("Couldn't find that address. Add a city/state, or pick a dropdown suggestion.");
        }
      }
    );
  }, [onAdd, onWarn]);

  return (
    <>
      <GoogleMap
        mapContainerStyle={{ width: "100%", height: "100%" }}
        center={center}
        zoom={11}
        onLoad={onMapLoad}
        onClick={handleClick}
        options={{
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          clickableIcons: false,
        }}
      >
        {serviceRadiusMeters && base && (
          <Circle
            center={center}
            radius={serviceRadiusMeters}
            options={{
              strokeColor: "#0fb389", strokeOpacity: 0.5, strokeWeight: 1.5,
              fillColor: "#0fb389", fillOpacity: 0.05, clickable: false,
            }}
          />
        )}

        {/* Google-style blue navigation route: darker casing under, blue on top */}
        {routePath && (
          <>
            <Polyline
              path={routePath}
              options={{ strokeColor: "#1967d2", strokeOpacity: 1, strokeWeight: 9, zIndex: 1, clickable: false }}
            />
            <Polyline
              path={routePath}
              options={{
                strokeColor: "#4285F4", strokeOpacity: 1, strokeWeight: 5, zIndex: 2, clickable: false,
                icons: [
                  {
                    icon: {
                      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                      scale: 2.4, fillColor: "#ffffff", fillOpacity: 1, strokeColor: "#1967d2", strokeWeight: 1,
                    },
                    repeat: "150px",
                  },
                ],
              }}
            />
          </>
        )}

        {/* The delivery vehicle: a directional arrow that drives once from base */}
        {routePath && (
          <Marker
            position={{ lat: routePath[0].lat(), lng: routePath[0].lng() }}
            zIndex={1200}
            onLoad={(m) => (vehicleRef.current = m)}
            onUnmount={() => (vehicleRef.current = null)}
            icon={{
              path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
              scale: 6,
              fillColor: "#1a73e8",
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 2,
              rotation: 0,
            }}
          />
        )}

        {stops.map((s, i) => {
          const isDepot = s.id === "depot";
          return (
            <Marker
              key={s.id}
              position={{ lat: s.lat, lng: s.lng }}
              zIndex={isDepot ? 999 : 3}
              icon={{
                path: google.maps.SymbolPath.CIRCLE,
                scale: 13,
                fillColor: isDepot ? "#0fb389" : "#ef9f0d",
                fillOpacity: 1,
                strokeColor: "#ffffff",
                strokeWeight: 2.5,
              }}
              label={{
                text: isDepot ? "H" : String(positionById.get(s.id) ?? i + 1),
                color: isDepot ? "#062b21" : "#241703",
                fontSize: "12px",
                fontWeight: "700",
              }}
            />
          );
        })}
      </GoogleMap>

      <div className="map-search">
        <Autocomplete
          onLoad={(ac) => (acRef.current = ac)}
          onPlaceChanged={onPlaceChanged}
          options={{ fields: ["place_id", "geometry", "name", "formatted_address"], componentRestrictions: { country: "us" } }}
        >
          <input ref={inputRef} className="text map-search-input" placeholder="Search an address to add a delivery site…" />
        </Autocomplete>
      </div>
    </>
  );
}

export default memo(MapView);
