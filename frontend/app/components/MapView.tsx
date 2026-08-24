"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  GoogleMap,
  Marker,
  Circle,
  DirectionsRenderer,
  Autocomplete,
  useJsApiLoader,
} from "@react-google-maps/api";
import type { Stop } from "../lib/types";

// Static so the loader doesn't re-init on every render.
const LIBRARIES: ("places")[] = ["places"];
const FALLBACK_CENTER = { lat: 37.3382, lng: -121.8863 };

// Reverse-geocode result types that mean "this is a real place on land".
const LAND_TYPES = new Set([
  "street_address", "route", "premise", "subpremise", "intersection",
  "plus_code", "neighborhood", "sublocality", "locality", "postal_code",
  "point_of_interest", "establishment", "park", "airport",
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
  const mapRef = useRef<google.maps.Map | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const acRef = useRef<google.maps.places.Autocomplete | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastPlaceRef = useRef<string | null>(null);
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);

  const base = stops.find((s) => s.id === "depot") ?? stops[0];
  const center = base ? { lat: base.lat, lng: base.lng } : FALLBACK_CENTER;

  // Pin number = position along the route if solved, else position in the list.
  const positionById = new Map<string, number>();
  if (orderedStopIds && orderedStopIds.length > 0) {
    orderedStopIds.forEach((id, i) => positionById.set(id, i + 1));
  } else {
    stops.forEach((s, i) => positionById.set(s.id, i + 1));
  }

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

  const onMapLoad = useCallback(
    (map: google.maps.Map) => {
      mapRef.current = map;
      if (stops.length > 1) {
        const bounds = new google.maps.LatLngBounds();
        stops.forEach((s) => bounds.extend({ lat: s.lat, lng: s.lng }));
        map.fitBounds(bounds, 64);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Click to add — but only if the spot is on land (reject water).
  const handleClick = useCallback(
    (e: google.maps.MapMouseEvent) => {
      const lat = e.latLng?.lat();
      const lng = e.latLng?.lng();
      if (lat == null || lng == null) return;
      if (!geocoderRef.current) geocoderRef.current = new google.maps.Geocoder();
      geocoderRef.current.geocode({ location: { lat, lng } }, (results, status) => {
        const onLand =
          status === "OK" &&
          !!results &&
          results.some((r) => (r.types || []).some((t) => LAND_TYPES.has(t)));
        if (onLand) onAdd(lat, lng);
        else onWarn("That spot looks like water — please pick a location on land.");
      });
    },
    [onAdd, onWarn]
  );

  const onPlaceChanged = useCallback(() => {
    const place = acRef.current?.getPlace();
    const loc = place?.geometry?.location;
    // A fully-resolved selection has both geometry and a place_id. Google fires
    // this event twice on Enter (a rough guess, then the exact place); require
    // both, and ignore a repeat of the same place_id, so one address adds once.
    if (!loc || !place?.place_id) {
      onWarn("Pick an address from the dropdown suggestions to add it.");
      return;
    }
    if (place.place_id === lastPlaceRef.current) return;
    lastPlaceRef.current = place.place_id;
    const name =
      place.name || place.formatted_address?.split(",")[0] || "New delivery site";
    onAdd(loc.lat(), loc.lng(), name);
    if (inputRef.current) inputRef.current.value = "";
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

        {directions && (
          <DirectionsRenderer
            directions={directions}
            options={{
              suppressMarkers: true,
              preserveViewport: true,
              polylineOptions: { strokeColor: "#ef9f0d", strokeOpacity: 0.95, strokeWeight: 5 },
            }}
          />
        )}

        {stops.map((s, i) => {
          const isDepot = i === 0;
          return (
            <Marker
              key={s.id}
              position={{ lat: s.lat, lng: s.lng }}
              zIndex={isDepot ? 999 : 1}
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
