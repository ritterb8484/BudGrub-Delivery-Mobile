/**
 * Durable, ordered event queue (BUD-124).
 *
 * Every compliance event (location batch, scan/load, call, ID result, cash, hand-over, return, incident, fuel stop) is
 * written here with a monotonic per-scope sequence number and the device timestamp BEFORE any network call. `drain`
 * replays pending events in sequence order. The server is idempotent per event id (`Idempotency-Key`) and rejects a
 * sequence that is not `lastSequence + 1` with `OUT_OF_ORDER` + `expectedSequence`, which the queue resolves:
 *
 *  - expected < sent  → the server is missing earlier events: re-send from the gap (events are kept until trip close).
 *  - expected > sent  → the server already consumed those numbers (e.g. a reinstall reset the device counter):
 *                       renumber the still-pending events from `expected`, preserving their order.
 *
 * A business rejection (4xx other than 401/408/409-OUT_OF_ORDER/429) consumes the sequence on the server, so the event
 * is marked `rejected` with the server's reason and draining continues; transport failures and 5xx stop the drain and
 * leave the event pending for the next attempt.
 *
 * Storage is abstracted (QueueStore) so the logic is tested against an in-memory store and runs on SQLite in the app.
 */

export type EventStatus = "pending" | "acked" | "rejected";

export type EventKind =
  | "location"
  | "stop_action"
  | "load"
  | "trip_event"
  | "incident";

export interface QueuedEvent {
  id: string;
  /** "trip:<tripId>" for trip-scoped events (sequenced), "incidents" for incidents filed outside a trip. */
  scope: string;
  sequence: number;
  /** When true the server enforces ordering on this scope and the body carries `sequence`. */
  sequenced: boolean;
  kind: EventKind;
  path: string;
  body: Record<string, unknown>;
  deviceTs: string;
  status: EventStatus;
  attempts: number;
  lastError: string | null;
  /** Server response body (ack or rejection). */
  response: unknown;
  ackedAt: string | null;
  /** Small, non-sensitive descriptor for the sync screen and local overlays (e.g. { orderId, action }). */
  meta: Record<string, unknown>;
}

export interface QueueStore {
  insert(e: QueuedEvent): Promise<void>;
  update(id: string, patch: Partial<QueuedEvent>): Promise<void>;
  /** All events of a scope ordered by sequence ascending. */
  listScope(scope: string): Promise<QueuedEvent[]>;
  /** Every scope that has at least one event. */
  scopes(): Promise<string[]>;
  deleteScope(scope: string): Promise<void>;
  /** Allocate the next sequence number for a scope atomically (counter survives deleteScope). */
  nextSequence(scope: string): Promise<number>;
  /** Raise the scope counter so the next allocation is at least `value` (used when rebasing). */
  bumpSequence(scope: string, atLeast: number): Promise<void>;
}

export type SendResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "rejected"; status: number; code: string; message: string; body: unknown }
  | { kind: "out_of_order"; expected: number }
  | { kind: "retry"; error: string }
  | { kind: "unauthorized" };

export type Sender = (e: QueuedEvent) => Promise<SendResult>;

export interface DrainReport {
  sent: number;
  rejected: number;
  replayedFromGap: number;
  rebased: number;
  stoppedBy: null | "retry" | "unauthorized" | "gap_unresolvable" | "loop_guard";
  error: string | null;
}

export interface EnqueueInput {
  scope: string;
  kind: EventKind;
  path: string;
  body: Record<string, unknown>;
  sequenced?: boolean;
  meta?: Record<string, unknown>;
}

export interface QueueOptions {
  now?: () => Date;
  uuid: () => string;
  /** Strip sensitive fields from a body once the server has acknowledged it (e.g. full DOB on ID checks). */
  redactOnAck?: (e: QueuedEvent) => Record<string, unknown> | null;
}

export const tripScope = (tripId: string) => `trip:${tripId}`;

export class EventQueue {
  private draining: Promise<DrainReport> | null = null;
  private readonly now: () => Date;

  constructor(private readonly store: QueueStore, private readonly opts: QueueOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Persist an event. Resolves once it is durable; no network is touched. */
  async enqueue(input: EnqueueInput): Promise<QueuedEvent> {
    const sequence = await this.store.nextSequence(input.scope);
    const e: QueuedEvent = {
      id: this.opts.uuid(),
      scope: input.scope,
      sequence,
      sequenced: input.sequenced ?? input.scope.startsWith("trip:"),
      kind: input.kind,
      path: input.path,
      body: input.body,
      deviceTs: this.now().toISOString(),
      status: "pending",
      attempts: 0,
      lastError: null,
      response: null,
      ackedAt: null,
      meta: input.meta ?? {},
    };
    await this.store.insert(e);
    return e;
  }

  async scopes(): Promise<string[]> {
    return this.store.scopes();
  }

  async list(scope: string): Promise<QueuedEvent[]> {
    return this.store.listScope(scope);
  }

  async pending(scope?: string): Promise<QueuedEvent[]> {
    const scopes = scope ? [scope] : await this.store.scopes();
    const all: QueuedEvent[] = [];
    for (const s of scopes) all.push(...(await this.store.listScope(s)).filter((e) => e.status === "pending"));
    return all;
  }

  async get(scope: string, id: string): Promise<QueuedEvent | undefined> {
    return (await this.store.listScope(scope)).find((e) => e.id === id);
  }

  /** Merge local-only annotations into an event's meta (e.g. the agent reviewed a rejection). Never re-sent. */
  async annotate(e: QueuedEvent, meta: Record<string, unknown>): Promise<void> {
    await this.store.update(e.id, { meta: { ...e.meta, ...meta } });
  }

  /** Remove a closed trip's events (called after the server completes the trip). */
  async purge(scope: string): Promise<void> {
    await this.store.deleteScope(scope);
  }

  /** Drain every scope (or one). Concurrent calls share the in-flight drain. */
  drain(sender: Sender, scope?: string): Promise<DrainReport> {
    if (this.draining) return this.draining;
    this.draining = this.drainAll(sender, scope).finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainAll(sender: Sender, only?: string): Promise<DrainReport> {
    const total: DrainReport = { sent: 0, rejected: 0, replayedFromGap: 0, rebased: 0, stoppedBy: null, error: null };
    const scopes = only ? [only] : await this.store.scopes();
    for (const scope of scopes) {
      const r = await this.drainScope(sender, scope);
      total.sent += r.sent;
      total.rejected += r.rejected;
      total.replayedFromGap += r.replayedFromGap;
      total.rebased += r.rebased;
      if (r.stoppedBy) {
        total.stoppedBy = r.stoppedBy;
        total.error = r.error;
        // A transport failure or 401 affects every scope; a gap problem only its own.
        if (r.stoppedBy === "retry" || r.stoppedBy === "unauthorized") break;
      }
    }
    return total;
  }

  private async drainScope(sender: Sender, scope: string): Promise<DrainReport> {
    const report: DrainReport = { sent: 0, rejected: 0, replayedFromGap: 0, rebased: 0, stoppedBy: null, error: null };
    const initial = await this.store.listScope(scope);
    let guard = initial.length * 4 + 16;

    while (guard-- > 0) {
      const events = await this.store.listScope(scope);
      const next = events.find((e) => e.status === "pending");
      if (!next) return report;

      const result = await sender(next);
      const at = this.now().toISOString();

      switch (result.kind) {
        case "ok": {
          const redacted = this.opts.redactOnAck?.(next);
          await this.store.update(next.id, {
            status: "acked",
            ackedAt: at,
            response: result.body,
            lastError: null,
            attempts: next.attempts + 1,
            ...(redacted ? { body: redacted } : {}),
          });
          report.sent++;
          break;
        }
        case "rejected": {
          const redacted = this.opts.redactOnAck?.(next);
          await this.store.update(next.id, {
            status: "rejected",
            ackedAt: at,
            response: result.body,
            lastError: `${result.code}: ${result.message}`,
            attempts: next.attempts + 1,
            ...(redacted ? { body: redacted } : {}),
          });
          report.rejected++;
          break;
        }
        case "out_of_order": {
          const expected = result.expected;
          if (expected < next.sequence) {
            // The server is missing [expected, next.sequence). Re-send them; they are kept locally until trip close.
            const gap = events.filter((e) => e.sequence >= expected && e.sequence < next.sequence);
            const contiguous = gap.length === next.sequence - expected && gap[0]?.sequence === expected;
            if (!contiguous) {
              await this.store.update(next.id, { lastError: `OUT_OF_ORDER: server expects ${expected}, events before ${next.sequence} are no longer on this device` });
              return { ...report, stoppedBy: "gap_unresolvable", error: `Server expects event ${expected}; this device no longer holds it. Contact dispatch.` };
            }
            for (const g of gap) await this.store.update(g.id, { status: "pending", ackedAt: null });
            report.replayedFromGap += gap.length;
          } else {
            // The server already used these numbers. Renumber everything still pending from `expected`, in order.
            const pending = events.filter((e) => e.status === "pending");
            let seq = expected;
            // Move them out of the way first so numbers never collide mid-rebase.
            const offset = expected + pending.length + (events[events.length - 1]?.sequence ?? 0) + 1;
            for (const [i, p] of pending.entries()) await this.store.update(p.id, { sequence: offset + i });
            for (const p of pending) await this.store.update(p.id, { sequence: seq++ });
            await this.store.bumpSequence(scope, seq);
            report.rebased += pending.length;
          }
          break;
        }
        case "retry": {
          await this.store.update(next.id, { attempts: next.attempts + 1, lastError: result.error });
          return { ...report, stoppedBy: "retry", error: result.error };
        }
        case "unauthorized": {
          return { ...report, stoppedBy: "unauthorized", error: "Signed out" };
        }
      }
    }
    return { ...report, stoppedBy: "loop_guard", error: "Sync stopped after too many resolution attempts" };
  }
}

/** In-memory store, used by tests and as a fallback when SQLite is unavailable. */
export class MemoryQueueStore implements QueueStore {
  private rows = new Map<string, QueuedEvent>();
  private counters = new Map<string, number>();

  async insert(e: QueuedEvent) {
    this.rows.set(e.id, { ...e });
  }
  async update(id: string, patch: Partial<QueuedEvent>) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, ...patch });
  }
  async listScope(scope: string) {
    return [...this.rows.values()].filter((e) => e.scope === scope).sort((a, b) => a.sequence - b.sequence).map((e) => ({ ...e }));
  }
  async scopes() {
    return [...new Set([...this.rows.values()].map((e) => e.scope))];
  }
  async deleteScope(scope: string) {
    for (const [id, e] of this.rows) if (e.scope === scope) this.rows.delete(id);
  }
  async nextSequence(scope: string) {
    const n = (this.counters.get(scope) ?? 0) + 1;
    this.counters.set(scope, n);
    return n;
  }
  async bumpSequence(scope: string, atLeast: number) {
    if ((this.counters.get(scope) ?? 0) < atLeast - 1) this.counters.set(scope, atLeast - 1);
  }
}
