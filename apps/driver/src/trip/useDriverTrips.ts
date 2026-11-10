import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, NetworkError } from "@/api/client";
import type { DriverTripsResponse } from "@/api/types";
import { DEFAULT_ID_RULES, type IdRules } from "@/id/validator";
import { reconcileTracking, updateTrackingContext } from "@/location/task";
import { kv, KV } from "@/storage/db";
import { purgeSettledTrips, queue, useSyncStatus } from "@/sync/engine";
import { applyPending } from "@/sync/overlay";
import { tripScope, type QueuedEvent } from "@/sync/queue";

interface Cached {
  data: DriverTripsResponse;
  at: string;
}

export interface DriverTripsResult {
  data: DriverTripsResponse;
  fromCache: boolean;
  cachedAt: string | null;
}

export const DRIVER_KEY = ["driver"] as const;

/**
 * GET /admin/driver/trips with an offline fallback (BUD-124): whenever a trip is current, the payload — manifest,
 * plan, geofences (stop coordinates), ID rules (idTypes, minAge) and checklist — is cached in SQLite, so scans, calls,
 * ID checks and hand-overs keep working without coverage.
 */
async function fetchDriverTrips(): Promise<DriverTripsResult> {
  try {
    const data = await api.driverTrips();
    if (data.current) await kv.set(KV.driverTrips, { data, at: new Date().toISOString() } satisfies Cached);
    else await kv.remove(KV.driverTrips);
    return { data, fromCache: false, cachedAt: null };
  } catch (e) {
    // No coverage or the API is briefly down (5xx): keep working from the saved trip.
    if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) {
      const c = await kv.get<Cached>(KV.driverTrips);
      if (c) return { data: c.data, fromCache: true, cachedAt: c.at };
    }
    throw e;
  }
}

export function useDriverTrips() {
  const q = useQuery({ queryKey: DRIVER_KEY, queryFn: fetchDriverTrips, refetchInterval: 10_000, retry: 1 });
  const sync = useSyncStatus();
  const tripId = q.data?.data.current?.id ?? null;
  const [loaded, setLoaded] = useState<{ tripId: string; events: QueuedEvent[] } | null>(null);
  const events = useMemo(() => (loaded && loaded.tripId === tripId ? loaded.events : []), [loaded, tripId]);

  // Re-read this trip's queue whenever sync status changes (enqueue, ack, rejection).
  useEffect(() => {
    let live = true;
    if (!tripId) return;
    void queue.list(tripScope(tripId)).then((e) => live && setLoaded({ tripId, events: e }));
    return () => {
      live = false;
    };
  }, [tripId, sync]);

  const current = q.data?.data.current;
  const fresh = q.data ? !q.data.fromCache : false;
  useEffect(() => {
    if (!fresh) return;
    if (current?.status === "departed") void updateTrackingContext(current);
    // The server is the authority on whether a trip is in progress: stop a trace left running for a trip that was
    // closed or cancelled elsewhere (or the app died mid-close), and drop finished trips' fully-synced events.
    void reconcileTracking(current ?? null).catch(() => undefined);
    void purgeSettledTrips(current?.id ?? null).catch(() => undefined);
  }, [current?.id, current?.planVersion, current?.status, fresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const trip = useMemo(() => (current ? applyPending(current, events) : null), [current, events]);
  const rules: IdRules = useMemo(
    () => (q.data ? { acceptedTypes: q.data.data.idTypes.length ? q.data.data.idTypes : DEFAULT_ID_RULES.acceptedTypes, minAge: q.data.data.minAge || 21 } : DEFAULT_ID_RULES),
    [q.data],
  );
  return { ...q, trip, events, rules, fromCache: q.data?.fromCache ?? false, cachedAt: q.data?.cachedAt ?? null };
}

export function useRefreshDriver() {
  const qc = useQueryClient();
  // Stable identity: callers put this in effect deps (pay-link polling).
  return useCallback(() => void qc.invalidateQueries({ queryKey: DRIVER_KEY }), [qc]);
}
