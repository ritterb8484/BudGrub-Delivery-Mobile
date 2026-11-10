import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import type { Trip, TripStop } from "@/api/types";
import { clock } from "@/lib/format";
import { color, radius } from "@/theme";
import { T } from "./ui";

type Pt = { latitude: number; longitude: number };

function region(points: Pt[]) {
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.02, (maxLat - minLat) * 1.6),
    longitudeDelta: Math.max(0.02, (maxLng - minLng) * 1.6),
  };
}

const pt = (s: TripStop): Pt | null => (s.address.lat != null && s.address.lng != null ? { latitude: s.address.lat, longitude: s.address.lng } : null);

/**
 * BUD-77: plan preview, store → stops in order → store, with the server ETA per stop.
 * BUD-88: `nextOnly` shows only the next stop (and the vehicle) during the trip; no reorder or skip.
 */
export function RouteMap({ trip, nextOnly, next, me }: { trip: Trip; nextOnly?: boolean; next?: TripStop | null; me?: { lat: number; lng: number } | null }) {
  const store = trip.dispensary ? { latitude: trip.dispensary.lat, longitude: trip.dispensary.lng } : null;
  const stops = useMemo(() => (nextOnly ? (next ? [next] : []) : trip.stops.filter((s) => s.status !== "cancelled")), [trip.stops, nextOnly, next]);
  const stopPts = stops.map((s) => ({ s, p: pt(s) })).filter((x): x is { s: TripStop; p: Pt } => x.p !== null);
  const path = nextOnly ? [] : [store, ...stopPts.map((x) => x.p), trip.returnToStore !== false ? store : null].filter((p): p is Pt => p !== null);
  const meP = me ? { latitude: me.lat, longitude: me.lng } : null;
  const all = [...(store && !nextOnly ? [store] : []), ...stopPts.map((x) => x.p), ...(meP ? [meP] : [])];

  if (!all.length) return <View style={[s.map, s.none]}><T tone="text3">No geocoded addresses to show on the map.</T></View>;
  return (
    <View style={s.map} accessibilityLabel={nextOnly ? "Map of your next stop" : "Route preview map"}>
      {/* initialRegion is read once, so the next-stop map is remounted per stop; otherwise it stays on the last one. */}
      <MapView key={nextOnly ? (next?.orderId ?? "none") : "route"} style={StyleSheet.absoluteFill} initialRegion={region(all)} userInterfaceStyle="dark" showsUserLocation={!!nextOnly} toolbarEnabled={false} pitchEnabled={false} rotateEnabled={false}>
        {store && !nextOnly ? <Marker coordinate={store} title={trip.dispensary?.name ?? "Dispensary"} pinColor={color.purple} /> : null}
        {stopPts.map(({ s: st, p }) => (
          <Marker key={st.orderId} coordinate={p} title={`${st.seq}. ${st.recipientFirstName ?? st.recipient.split(" ")[0]}`} description={st.eta ? `ETA ${clock(st.eta)}` : st.windowLabel} pinColor={color.green} />
        ))}
        {path.length > 1 ? <Polyline coordinates={path} strokeColor={color.purple} strokeWidth={3} lineDashPattern={[8, 6]} /> : null}
      </MapView>
    </View>
  );
}

const s = StyleSheet.create({
  map: { height: 220, borderRadius: radius.md, overflow: "hidden", borderWidth: 1, borderColor: color.border, backgroundColor: color.surface2 },
  none: { alignItems: "center", justifyContent: "center" },
});
