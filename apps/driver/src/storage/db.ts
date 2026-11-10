import * as SQLite from "expo-sqlite";
import type { QueueStore, QueuedEvent } from "@/sync/queue";

/**
 * Local SQLite database (BUD-124): the durable event queue, a key/value store for the cached trip payload, ID rules,
 * geofences, dwell state and load-scan session. Opened lazily so the background location task (which can run without
 * the UI) shares the same file.
 */
let db: SQLite.SQLiteDatabase | null = null;

export function database(): SQLite.SQLiteDatabase {
  if (db) return db;
  db = SQLite.openDatabaseSync("budgrub-driver.db");
  db.execSync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      sequenced INTEGER NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      body TEXT NOT NULL,
      device_ts TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      response TEXT,
      acked_at TEXT,
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS events_scope_seq ON events (scope, sequence);
    CREATE TABLE IF NOT EXISTS counters (scope TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  return db;
}

interface EventRow {
  id: string;
  scope: string;
  sequence: number;
  sequenced: number;
  kind: string;
  path: string;
  body: string;
  device_ts: string;
  status: string;
  attempts: number;
  last_error: string | null;
  response: string | null;
  acked_at: string | null;
  meta: string;
}

const fromRow = (r: EventRow): QueuedEvent => ({
  id: r.id,
  scope: r.scope,
  sequence: r.sequence,
  sequenced: r.sequenced === 1,
  kind: r.kind as QueuedEvent["kind"],
  path: r.path,
  body: JSON.parse(r.body),
  deviceTs: r.device_ts,
  status: r.status as QueuedEvent["status"],
  attempts: r.attempts,
  lastError: r.last_error,
  response: r.response ? JSON.parse(r.response) : null,
  ackedAt: r.acked_at,
  meta: JSON.parse(r.meta),
});

const COLUMN: Record<string, string> = {
  scope: "scope", sequence: "sequence", sequenced: "sequenced", kind: "kind", path: "path", body: "body", deviceTs: "device_ts",
  status: "status", attempts: "attempts", lastError: "last_error", response: "response", ackedAt: "acked_at", meta: "meta",
};

function toColumnValue(key: string, v: unknown): SQLite.SQLiteBindValue {
  if (key === "body" || key === "meta" || key === "response") return v == null ? null : JSON.stringify(v);
  if (key === "sequenced") return v ? 1 : 0;
  return v as SQLite.SQLiteBindValue;
}

export class SqliteQueueStore implements QueueStore {
  async insert(e: QueuedEvent) {
    await database().runAsync(
      `INSERT INTO events (id, scope, sequence, sequenced, kind, path, body, device_ts, status, attempts, last_error, response, acked_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.id, e.scope, e.sequence, e.sequenced ? 1 : 0, e.kind, e.path, JSON.stringify(e.body), e.deviceTs, e.status, e.attempts,
      e.lastError, e.response == null ? null : JSON.stringify(e.response), e.ackedAt, JSON.stringify(e.meta),
    );
  }

  async update(id: string, patch: Partial<QueuedEvent>) {
    const keys = Object.keys(patch).filter((k) => COLUMN[k]);
    if (!keys.length) return;
    const sets = keys.map((k) => `${COLUMN[k]} = ?`).join(", ");
    const values = keys.map((k) => toColumnValue(k, (patch as Record<string, unknown>)[k]));
    await database().runAsync(`UPDATE events SET ${sets} WHERE id = ?`, ...values, id);
  }

  async listScope(scope: string) {
    const rows = await database().getAllAsync<EventRow>("SELECT * FROM events WHERE scope = ? ORDER BY sequence ASC", scope);
    return rows.map(fromRow);
  }

  async scopes() {
    const rows = await database().getAllAsync<{ scope: string }>("SELECT DISTINCT scope FROM events ORDER BY scope");
    return rows.map((r) => r.scope);
  }

  async deleteScope(scope: string) {
    await database().runAsync("DELETE FROM events WHERE scope = ?", scope);
  }

  async nextSequence(scope: string) {
    let next = 0;
    await database().withExclusiveTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<{ value: number }>("SELECT value FROM counters WHERE scope = ?", scope);
      next = (row?.value ?? 0) + 1;
      await tx.runAsync("INSERT INTO counters (scope, value) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET value = excluded.value", scope, next);
    });
    return next;
  }

  async bumpSequence(scope: string, atLeast: number) {
    await database().runAsync(
      "INSERT INTO counters (scope, value) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET value = MAX(value, excluded.value)",
      scope, atLeast - 1,
    );
  }
}

/** Key/value cache (trip payload, rules, geofences, dwell state, load session, acceptance snapshot). */
export const kv = {
  async get<T>(key: string): Promise<T | null> {
    const row = await database().getFirstAsync<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as T) : null;
  },
  async set(key: string, value: unknown): Promise<void> {
    await database().runAsync(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key, JSON.stringify(value), new Date().toISOString(),
    );
  },
  async remove(key: string): Promise<void> {
    await database().runAsync("DELETE FROM kv WHERE key = ?", key);
  },
};

export const KV = {
  driverTrips: "cache.driverTrips",
  /** { tripId, planVersion, manifestLockedAt, acceptedAt } */
  accepted: "trip.accepted",
  loadSession: "trip.loadSession",
  /** Context the background task needs: { tripId, geofences, dwell config } */
  activeTrip: "trip.active",
  dwellState: "trip.dwellState",
  dwellPrompt: "trip.dwellPrompt",
  lastPingAt: "trip.lastPingAt",
  lastSyncAt: "sync.lastSyncAt",
  pushToken: "push.token",
  mode: "app.mode",
  permissionsSeen: "app.permissionsSeen",
} as const;
