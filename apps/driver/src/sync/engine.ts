import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { auth, rawRequest } from "@/api/client";
import { SYNC_INTERVAL_MS } from "@/config";
import { kv, KV, SqliteQueueStore } from "@/storage/db";
import { EventQueue, tripScope, type EnqueueInput, type QueuedEvent } from "./queue";
import { createHttpSender } from "./sender";

/**
 * App-wide sync engine (BUD-124). Owns the SQLite-backed queue, sends events with `Idempotency-Key: <event id>` and
 * `sequence`, replays on reconnect / foreground / every 15 s while anything is pending, and publishes status
 * (queued count, last sync, rejections) to the UI.
 */

/** After the server acknowledges, keep only what the stop log needs (BUD-101: never keep full DOB; drop photos). */
function redactOnAck(e: QueuedEvent): Record<string, unknown> | null {
  if (e.meta.action === "id-check") {
    const b = e.body as { idType?: string; last4?: string | null; dob?: string };
    return { idType: b.idType ?? null, last4: b.last4 ?? null, dobYear: b.dob ? Number(b.dob.slice(0, 4)) : null };
  }
  if (e.body.photo) return { ...e.body, photo: { uploaded: true } };
  return null;
}

export const queue = new EventQueue(new SqliteQueueStore(), { uuid: () => Crypto.randomUUID(), redactOnAck });

export const httpSender = createHttpSender(
  (path, body, headers) => rawRequest(path, { method: "POST", body, headers, timeoutMs: 30_000 }),
  { hasToken: () => Boolean(auth.getToken()), onUnauthorized: () => auth.emitUnauthorized() },
);

export interface SyncStatus {
  pending: number;
  /** Rejections the agent has not reviewed yet. */
  rejected: QueuedEvent[];
  lastSyncAt: string | null;
  lastError: string | null;
  syncing: boolean;
  online: boolean | null;
}

let status: SyncStatus = { pending: 0, rejected: [], lastSyncAt: null, lastError: null, syncing: false, online: null };
const listeners = new Set<() => void>();
function publish(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  for (const l of listeners) l();
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

export async function refreshStatus() {
  const scopes = await queue.pending();
  const rejected: QueuedEvent[] = [];
  const scopeNames = new Set(scopes.map((e) => e.scope));
  const active = await kv.get<{ tripId: string }>(KV.activeTrip);
  if (active) scopeNames.add(tripScope(active.tripId));
  scopeNames.add("incidents");
  for (const s of scopeNames) rejected.push(...(await queue.list(s)).filter((e) => e.status === "rejected" && !e.meta.reviewed));
  publish({ pending: scopes.length, rejected, lastSyncAt: status.lastSyncAt ?? (await kv.get<string>(KV.lastSyncAt)) });
}

/** Drain now. Safe to call often; concurrent calls share one drain. */
export async function syncNow(): Promise<void> {
  publish({ syncing: true });
  try {
    const r = await queue.drain(httpSender);
    if (!r.stoppedBy || r.sent || r.rejected) {
      const at = new Date().toISOString();
      await kv.set(KV.lastSyncAt, at);
      publish({ lastSyncAt: at });
    }
    publish({ lastError: r.stoppedBy && r.stoppedBy !== "unauthorized" ? r.error : null });
  } finally {
    publish({ syncing: false });
    await refreshStatus();
  }
}

/** Persist an event (durable before any network call), then try to send it. */
export async function enqueue(input: EnqueueInput): Promise<QueuedEvent> {
  const e = await queue.enqueue(input);
  await refreshStatus();
  void syncNow();
  return e;
}

/** Enqueue and wait (bounded) for the server's answer; resolves with the event in whatever state it reached. */
export async function enqueueAndWait(input: EnqueueInput, timeoutMs = 8_000): Promise<QueuedEvent> {
  const e = await queue.enqueue(input);
  await refreshStatus();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await syncNow();
    const cur = await queue.get(e.scope, e.id);
    if (!cur || cur.status !== "pending") return cur ?? e;
    if (status.lastError) break; // offline or server down: return the pending event, it replays later
    await new Promise((r) => setTimeout(r, 500));
  }
  return (await queue.get(e.scope, e.id)) ?? e;
}

export async function markReviewed(e: QueuedEvent) {
  await queue.annotate(e, { reviewed: true });
  await refreshStatus();
}

/** BUD-124: the trip cannot close until the queue is empty and the server has acknowledged every event. */
export async function tripQueueClear(tripId: string): Promise<{ clear: boolean; pending: number }> {
  const pending = (await queue.pending(tripScope(tripId))).length + (await queue.pending("incidents")).length;
  return { clear: pending === 0, pending };
}

/** Start the replay triggers: connectivity regained, app foregrounded, and a timer while anything is pending. */
export function startSyncLoop(): () => void {
  void refreshStatus().then(() => syncNow());
  const net = Network.addNetworkStateListener((s) => {
    const online = Boolean(s.isConnected && s.isInternetReachable !== false);
    publish({ online });
    if (online) void syncNow();
  });
  void Network.getNetworkStateAsync().then((s) => publish({ online: Boolean(s.isConnected && s.isInternetReachable !== false) }));
  const app = AppState.addEventListener("change", (st) => {
    if (st === "active") void syncNow();
  });
  const timer = setInterval(() => {
    if (status.pending > 0 && !status.syncing) void syncNow();
  }, SYNC_INTERVAL_MS);
  return () => {
    net.remove();
    app.remove();
    clearInterval(timer);
  };
}
