import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { auth, eventPaths } from "@/api/client";
import { tokenStore } from "@/auth/oidc";
import type { LocationPing, Trip } from "@/api/types";
import { LOCATION_BATCH_MS, LOCATION_INTERVAL_MS, LOCATION_TASK } from "@/config";
import { kv, KV } from "@/storage/db";
import { enqueue } from "@/sync/engine";
import { tripScope } from "@/sync/queue";
import { color } from "@/theme";
import { DEFAULT_DWELL, initialDwellState, runDwell, tripGeofences, type DwellConfig, type DwellState } from "./dwell";

/**
 * Background trace (BUD-88): every 10–15 s while a trip is departed, with accuracy, speed and heading, batched to
 * POST /admin/driver/trips/{id}/location through the ordered queue. The same task runs off-route dwell detection on
 * device and raises a local notification + in-app prompt ("Fuel stop" / "Report unauthorized stop").
 *
 * Must be imported at module scope from the root layout so the task is defined when the OS relaunches the app headless.
 */

export interface ActiveTripContext {
  tripId: string;
  dwell: DwellConfig;
}

export interface DwellPrompt {
  tripId: string;
  startedAt: number;
  endedAt: number | null;
  lat: number;
  lng: number;
  durationSec: number;
  /** The dwell event id already queued to the timeline */
  resolved: boolean;
}

export function activeContextFor(trip: Trip): ActiveTripContext {
  return {
    tripId: trip.id,
    dwell: { ...DEFAULT_DWELL, thresholdSec: trip.dwellThresholdSec ?? DEFAULT_DWELL.thresholdSec, geofences: tripGeofences(trip) },
  };
}

export async function handleLocations(locations: Location.LocationObject[]): Promise<void> {
  const ctx = await kv.get<ActiveTripContext>(KV.activeTrip);
  if (!ctx || !locations.length) return;

  // Keep the trace at ≥10 s spacing even if the OS delivers more often.
  const lastAt = (await kv.get<number>(KV.lastPingAt)) ?? 0;
  const sorted = [...locations].sort((a, b) => a.timestamp - b.timestamp);
  const kept: Location.LocationObject[] = [];
  let cursor = lastAt;
  for (const l of sorted) {
    if (l.timestamp - cursor >= LOCATION_INTERVAL_MS - 500) {
      kept.push(l);
      cursor = l.timestamp;
    }
  }
  if (!kept.length) return;
  await kv.set(KV.lastPingAt, cursor);

  const pings: LocationPing[] = kept.map((l) => ({
    lat: l.coords.latitude,
    lng: l.coords.longitude,
    speedMps: l.coords.speed ?? null,
    heading: l.coords.heading ?? null,
    accuracyM: l.coords.accuracy ?? null,
    recordedAt: new Date(l.timestamp).toISOString(),
  }));
  await enqueue({ scope: tripScope(ctx.tripId), kind: "location", path: eventPaths.location(ctx.tripId), body: { pings }, meta: { count: pings.length } });

  // Dwell detection.
  const state = (await kv.get<DwellState>(KV.dwellState)) ?? initialDwellState();
  const { state: next, events } = runDwell(state, kept.map((l) => ({ lat: l.coords.latitude, lng: l.coords.longitude, t: l.timestamp, accuracyM: l.coords.accuracy })), ctx.dwell);
  await kv.set(KV.dwellState, next);
  for (const ev of events) {
    if (ev.type === "dwell_start") {
      const prompt: DwellPrompt = { tripId: ctx.tripId, startedAt: ev.startedAt, endedAt: null, lat: ev.at.lat, lng: ev.at.lng, durationSec: ev.elapsedSec, resolved: false };
      await kv.set(KV.dwellPrompt, prompt);
      await enqueue({
        scope: tripScope(ctx.tripId),
        kind: "trip_event",
        path: eventPaths.events(ctx.tripId),
        body: { kind: "dwell", lat: ev.at.lat, lng: ev.at.lng, startedAt: new Date(ev.startedAt).toISOString(), endedAt: null },
        meta: { event: "dwell" },
      });
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "Stopped off route",
          body: `Stationary for ${Math.round(ev.elapsedSec / 60)} min outside the store and your stops. Log a fuel stop or report an unauthorized stop.`,
          data: { type: "dwell_prompt", tripId: ctx.tripId },
        },
        trigger: null,
      }).catch(() => undefined);
    } else {
      const p = await kv.get<DwellPrompt>(KV.dwellPrompt);
      if (p && p.startedAt === ev.startedAt) await kv.set(KV.dwellPrompt, { ...p, endedAt: ev.endedAt, durationSec: ev.durationSec });
    }
  }
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  // Headless relaunch: the UI has not restored the session, so load the token (Keychain: after first unlock).
  if (!auth.getToken()) auth.setToken(await tokenStore.get().catch(() => null));
  await handleLocations(data.locations).catch(() => undefined);
});

export async function startTracking(trip: Trip): Promise<boolean> {
  await kv.set(KV.activeTrip, activeContextFor(trip));
  const bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted) return false;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) return true;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: LOCATION_INTERVAL_MS,
    distanceInterval: 0,
    deferredUpdatesInterval: LOCATION_BATCH_MS,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: `BudGrub trip ${trip.number} in progress`,
      notificationBody: "Your route is recorded for the delivery manifest until the trip is closed.",
      notificationColor: color.purple,
      killServiceOnDestroy: false,
    },
  });
  return true;
}

/** Refresh the geofences/threshold the background task uses after a plan amendment. */
export async function updateTrackingContext(trip: Trip) {
  const cur = await kv.get<ActiveTripContext>(KV.activeTrip);
  if (cur?.tripId === trip.id) await kv.set(KV.activeTrip, activeContextFor(trip));
}

export async function stopTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  await Promise.all([kv.remove(KV.activeTrip), kv.remove(KV.dwellState), kv.remove(KV.dwellPrompt), kv.remove(KV.lastPingAt)]);
}

export async function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
    const p = last ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    return { lat: p.coords.latitude, lng: p.coords.longitude };
  } catch {
    return null;
  }
}
