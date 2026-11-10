import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, NetworkError } from "@/api/client";
import type { DriverTripsResponse } from "@/api/types";
import { DEFAULT_ID_RULES, type IdRules } from "@/id/validator";
import { updateTrackingContext } from "@/location/task";
import { kv, KV } from "@/storage/db";
import { queue, useSyncStatus } from "@/sync/engine";
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
    if (e instanceof NetworkError) {
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
  useEffect(() => {
    if (current?.status === "departed" && !q.data?.fromCache) void updateTrackingContext(current);
  }, [current?.id, current?.planVersion, current?.status, q.data?.fromCache]); // eslint-disable-line react-hooks/exhaustive-deps

  const trip = useMemo(() => (current ? applyPending(current, events) : null), [current, events]);
  const rules: IdRules = useMemo(
    () => (q.data ? { acceptedTypes: q.data.data.idTypes.length ? q.data.data.idTypes : DEFAULT_ID_RULES.acceptedTypes, minAge: q.data.data.minAge || 21 } : DEFAULT_ID_RULES),
    [q.data],
  );
  return { ...q, trip, events, rules, fromCache: q.data?.fromCache ?? false, cachedAt: q.data?.cachedAt ?? null };
}

export function useRefreshDriver() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: DRIVER_KEY });
}
