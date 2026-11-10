import { distanceM, insideAny, type Geofence, type LatLng } from "./geo";

/**
 * On-device off-route dwell detection (BUD-88, NAC 678B.321(10)).
 *
 * The vehicle is "stationary" while every ping stays within `stationaryRadiusM` of the first ping of the cluster
 * (GPS jitter tolerance). Once stationary for longer than `thresholdSec` (default 180 s, configurable from the trip
 * payload) OUTSIDE the dispensary and planned-stop geofences, `dwell_start` is emitted once, and the app prompts
 * "Fuel stop" or "Report unauthorized stop". When the vehicle moves off, `dwell_end` closes it with the duration.
 * Pings inside a geofence reset the detector: stopping at the store or a customer's door is expected.
 *
 * Pure and serialisable: state is persisted between background-task invocations.
 */

export interface DwellPing extends LatLng {
  /** epoch ms */
  t: number;
  accuracyM?: number | null;
}

export interface DwellConfig {
  thresholdSec: number;
  stationaryRadiusM: number;
  /** Pings worse than this are ignored (urban canyon jumps would otherwise end a dwell). */
  maxAccuracyM: number;
  geofences: Geofence[];
}

export interface DwellState {
  anchor: DwellPing | null;
  last: DwellPing | null;
  prompted: boolean;
}

export type DwellEvent =
  | { type: "dwell_start"; startedAt: number; at: LatLng; elapsedSec: number }
  | { type: "dwell_end"; startedAt: number; endedAt: number; at: LatLng; durationSec: number };

export const DEFAULT_DWELL: Omit<DwellConfig, "geofences"> = { thresholdSec: 180, stationaryRadiusM: 40, maxAccuracyM: 75 };

export const initialDwellState = (): DwellState => ({ anchor: null, last: null, prompted: false });

export function stepDwell(state: DwellState, ping: DwellPing, cfg: DwellConfig): { state: DwellState; events: DwellEvent[] } {
  const events: DwellEvent[] = [];
  if (ping.accuracyM != null && ping.accuracyM > cfg.maxAccuracyM) return { state, events };
  if (state.last && ping.t <= state.last.t) return { state, events }; // out-of-order or duplicate ping

  if (insideAny(ping, cfg.geofences)) {
    if (state.prompted && state.anchor && state.last) {
      events.push(endEvent(state.anchor, state.last));
    }
    return { state: { anchor: null, last: ping, prompted: false }, events };
  }

  if (!state.anchor || distanceM(state.anchor, ping) > cfg.stationaryRadiusM) {
    // Moved: close an open dwell, start a new cluster here.
    if (state.prompted && state.anchor && state.last) events.push(endEvent(state.anchor, state.last));
    return { state: { anchor: ping, last: ping, prompted: false }, events };
  }

  const elapsedSec = (ping.t - state.anchor.t) / 1000;
  let prompted = state.prompted;
  if (!prompted && elapsedSec >= cfg.thresholdSec) {
    prompted = true;
    events.push({ type: "dwell_start", startedAt: state.anchor.t, at: { lat: state.anchor.lat, lng: state.anchor.lng }, elapsedSec: Math.round(elapsedSec) });
  }
  return { state: { anchor: state.anchor, last: ping, prompted }, events };
}

function endEvent(anchor: DwellPing, last: DwellPing): DwellEvent {
  return {
    type: "dwell_end",
    startedAt: anchor.t,
    endedAt: last.t,
    at: { lat: anchor.lat, lng: anchor.lng },
    durationSec: Math.round((last.t - anchor.t) / 1000),
  };
}

export function runDwell(state: DwellState, pings: DwellPing[], cfg: DwellConfig) {
  let s = state;
  const events: DwellEvent[] = [];
  for (const p of [...pings].sort((a, b) => a.t - b.t)) {
    const r = stepDwell(s, p, cfg);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

/** Geofences for a trip: the dispensary plus every planned stop with a geocoded address. */
export function tripGeofences(trip: {
  dispensary?: { lat: number; lng: number } | null;
  geofenceRadiusM?: number | null;
  stops: { orderId: string; address: { lat?: number | null; lng?: number | null } }[];
}): Geofence[] {
  const radiusM = trip.geofenceRadiusM ?? 150;
  const fences: Geofence[] = [];
  if (trip.dispensary) fences.push({ id: "dispensary", kind: "dispensary", lat: trip.dispensary.lat, lng: trip.dispensary.lng, radiusM });
  for (const s of trip.stops) {
    if (s.address.lat != null && s.address.lng != null) fences.push({ id: s.orderId, kind: "stop", lat: s.address.lat, lng: s.address.lng, radiusM });
  }
  return fences;
}
