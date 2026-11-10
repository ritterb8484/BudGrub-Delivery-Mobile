import type { StopStatus, Trip, TripStop } from "@/api/types";
import type { QueuedEvent } from "./queue";

/**
 * Apply still-pending (or locally accepted) stop actions to the last known trip so the UI keeps working offline
 * (BUD-124): an "arrived" tapped in a dead zone shows the stop as arrived, a queued cash hand-over updates the drawer.
 * Server state always wins once the event is acknowledged and the trip is refetched.
 */
export interface StopActionMeta {
  orderId: string;
  action: "en-route" | "arrived" | "phone" | "id-check" | "deliver" | "return";
  /** phone: outcome; id-check: local result; deliver: cash */
  outcome?: string;
  localOk?: boolean;
  cashReceivedCents?: number;
  changeCents?: number;
}

const NEXT: Partial<Record<StopActionMeta["action"], StopStatus>> = {
  "en-route": "en_route",
  arrived: "arrived",
  deliver: "delivered",
  return: "returned",
};

export function applyPending(trip: Trip, events: QueuedEvent[]): Trip {
  const pending = events.filter((e) => e.kind === "stop_action" && e.status === "pending").sort((a, b) => a.sequence - b.sequence);
  if (!pending.length) return trip;
  let float = trip.floatAvailableCents;
  const stops: TripStop[] = trip.stops.map((s) => ({ ...s }));
  for (const e of pending) {
    const m = e.meta as unknown as StopActionMeta;
    const s = stops.find((x) => x.orderId === m.orderId);
    if (!s) continue;
    const next = NEXT[m.action];
    if (next) s.status = next;
    if (m.action === "phone" && m.outcome === "confirmed" && !s.phoneConfirmedAt) s.phoneConfirmedAt = e.deviceTs;
    if (m.action === "phone") s.phoneAttempts = [...s.phoneAttempts, { at: e.deviceTs, outcome: m.outcome ?? "unknown" }];
    if (m.action === "id-check") {
      if (m.localOk && !s.idVerifiedAt) s.idVerifiedAt = e.deviceTs;
      if (!m.localOk) s.idChecks = [...s.idChecks, { at: e.deviceTs, ok: false, reasons: [] }];
    }
    if (m.action === "deliver" && m.cashReceivedCents != null) float += m.cashReceivedCents - (m.changeCents ?? 0);
  }
  return { ...trip, stops, floatAvailableCents: float };
}
