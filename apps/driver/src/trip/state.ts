import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { eventPaths } from "@/api/client";
import type { StopActionName, Trip } from "@/api/types";
import { sessionIsStale, type LoadSession } from "@/load/manifest";
import { kv, KV } from "@/storage/db";
import { enqueue, enqueueAndWait, queue } from "@/sync/engine";
import type { StopActionMeta } from "@/sync/overlay";
import { tripScope, type QueuedEvent } from "@/sync/queue";

/** What the agent reviewed when accepting (BUD-77): a later plan version or manifest lock means "manifest changed". */
export interface Acceptance {
  tripId: string;
  planVersion: number;
  manifestLockedAt: string | null;
  acceptedAt: string;
}

/** Sealed-load attestation (BUD-83). */
export interface Attestation {
  tripId: string;
  manifestLockedAt: string | null;
  sealed: boolean;
  notVisible: boolean;
  lockbox: boolean;
  attestedAt: string;
  eventId: string;
}

const ATTEST_KEY = "trip.attestation";

export function manifestChanged(acc: Acceptance | null, trip: Trip): boolean {
  return !!acc && acc.tripId === trip.id && (acc.planVersion !== trip.planVersion || acc.manifestLockedAt !== trip.manifestLockedAt);
}

export async function accept(trip: Trip) {
  const acc: Acceptance = { tripId: trip.id, planVersion: trip.planVersion, manifestLockedAt: trip.manifestLockedAt, acceptedAt: new Date().toISOString() };
  await kv.set(KV.accepted, acc);
  return acc;
}

export async function clearTripLocal() {
  await Promise.all([kv.remove(KV.accepted), kv.remove(KV.loadSession), kv.remove(ATTEST_KEY)]);
}

export async function saveLoadSession(s: LoadSession | null) {
  if (s) await kv.set(KV.loadSession, s);
  else await kv.remove(KV.loadSession);
}

export function useTripLocal(trip: Trip | null) {
  const [acceptance, setAcceptance] = useState<Acceptance | null>(null);
  const [session, setSession] = useState<LoadSession | null>(null);
  const [attestation, setAttestation] = useState<Attestation | null>(null);
  const [loadEvent, setLoadEvent] = useState<QueuedEvent | null>(null);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    const [acc, sess, att] = await Promise.all([kv.get<Acceptance>(KV.accepted), kv.get<LoadSession>(KV.loadSession), kv.get<Attestation>(ATTEST_KEY)]);
    const valid = trip && acc?.tripId === trip.id ? acc : null;
    setAcceptance(valid);
    setSession(trip && !sessionIsStale(sess, trip) ? sess : null);
    const attValid = trip && att && att.tripId === trip.id && att.manifestLockedAt === trip.manifestLockedAt ? att : null;
    setAttestation(attValid);
    setLoadEvent(attValid ? ((await queue.get(tripScope(attValid.tripId), attValid.eventId)) ?? null) : null);
    setReady(true);
  }, [trip?.id, trip?.manifestLockedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  return { acceptance, session, attestation, loadEvent, ready, reload };
}

/**
 * Submit scans + attestation (BUD-83) through the ordered queue; departure waits for the server's confirmation.
 * The photo, if any, is uploaded with the event and dropped from the device once acknowledged.
 */
export async function submitLoad(trip: Trip, session: LoadSession, att: Omit<Attestation, "eventId" | "tripId" | "manifestLockedAt" | "attestedAt">, photo: { mime: string; dataBase64: string } | null) {
  const attestedAt = new Date().toISOString();
  const e = await enqueueAndWait({
    scope: tripScope(trip.id),
    kind: "load",
    path: eventPaths.load(trip.id),
    body: {
      scans: session.scans,
      attestation: { sealed: att.sealed, notVisible: att.notVisible, lockbox: att.lockbox, attestedAt },
      // What was scanned against: the server refuses the attestation if the trip changed since (BUD-83).
      planVersion: trip.planVersion,
      manifestLockedAt: trip.manifestLockedAt,
      ...(photo ? { photo } : {}),
    },
    meta: { event: "load", tags: session.scans.filter((s) => s.result === "matched").length },
  });
  const saved: Attestation = { tripId: trip.id, manifestLockedAt: trip.manifestLockedAt, attestedAt, eventId: e.id, ...att };
  await kv.set(ATTEST_KEY, saved);
  return e;
}

export function stopAction(tripId: string, orderId: string, action: StopActionName, body: Record<string, unknown>, meta: Partial<StopActionMeta> = {}) {
  return enqueue({
    scope: tripScope(tripId),
    kind: "stop_action",
    path: eventPaths.stopAction(tripId, orderId, action),
    body,
    meta: { orderId, action, ...meta },
  });
}
