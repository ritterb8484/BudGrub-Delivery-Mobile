import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import type { QueueStore, QueuedEvent } from "@/sync/queue";

/**
 * Local SQLite database (BUD-124): the durable event queue, a key/value store for the cached trip payload, ID rules,
 * geofences, dwell state and load-scan session. Opened lazily so the background location task (which can run without
 * the UI) shares the same file.
 */
let ready: Promise<SQLite.SQLiteDatabase> | null = null;
const legacyName = "budgrub-driver.db";
const secureName = "budgrub-driver-secure.db";
const keyName = "budgrub.driver.db-key";

async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  let key = await SecureStore.getItemAsync(keyName);
  if (!key) {
    if (new File(SQLite.defaultDatabaseDirectory, secureName).exists) {
      throw new Error("The device could not unlock its delivery records.");
    }
    key = Array.from(await Crypto.getRandomBytesAsync(32), byte => byte.toString(16).padStart(2, "0")).join("");
    await SecureStore.setItemAsync(keyName, key, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  }
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid delivery storage key.");
  const db = await SQLite.openDatabaseAsync(secureName, { useNewConnection: true });
  try {
    await db.execAsync(`PRAGMA key = "x'${key}'"`);
    if (!await db.getFirstAsync("PRAGMA cipher_version")) throw new Error("This build lacks encrypted delivery storage.");
    await db.execAsync(`
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
    await migrateLegacyDatabase(db);
    return db;
  } catch (error) {
    await db.closeAsync().catch(() => undefined);
    throw error;
  }
}

async function migrateLegacyDatabase(db: SQLite.SQLiteDatabase) {
  const legacy = new File(SQLite.defaultDatabaseDirectory, legacyName);
  if (!legacy.exists) return;
  const done = await db.getFirstAsync("SELECT 1 FROM kv WHERE key = 'storage.encryptedMigration'");
  if (!done) {
    const path = legacy.uri.startsWith("file://") ? decodeURIComponent(legacy.uri.slice(7)) : legacy.uri;
    await db.runAsync("ATTACH DATABASE ? AS legacy KEY ''", path);
    try {
      await db.withTransactionAsync(async () => {
        await db.execAsync(`
          INSERT OR IGNORE INTO main.events SELECT * FROM legacy.events;
          INSERT OR IGNORE INTO main.counters SELECT * FROM legacy.counters;
          INSERT OR IGNORE INTO main.kv SELECT * FROM legacy.kv;
          INSERT INTO main.kv(key,value,updated_at) VALUES ('storage.encryptedMigration','true',datetime('now'));
        `);
      });
    } finally {
      await db.execAsync("DETACH DATABASE legacy");
    }
  }
  // The unencrypted database is removed only after the encrypted copy commits.
  await SQLite.deleteDatabaseAsync(legacyName);
}

function database(): Promise<SQLite.SQLiteDatabase> {
  return ready ??= openDatabase().catch(error => { ready = null; throw error; });
}

export async function pruneSettledCourierRecords() {
  const db = await database();
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  await db.runAsync("DELETE FROM events WHERE kind = 'courier_step' AND status <> 'pending' AND device_ts < ?", cutoff);
  const cacheCutoff = new Date(Date.now() - 86_400_000).toISOString();
  await db.runAsync("DELETE FROM kv WHERE key LIKE 'cache.food.%' AND updated_at < ?", cacheCutoff);
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
    await (await database()).runAsync(
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
    await (await database()).runAsync(`UPDATE events SET ${sets} WHERE id = ?`, ...values, id);
  }

  async listScope(scope: string) {
    const rows = await (await database()).getAllAsync<EventRow>("SELECT * FROM events WHERE scope = ? ORDER BY sequence ASC", scope);
    return rows.map(fromRow);
  }

  async scopes() {
    const rows = await (await database()).getAllAsync<{ scope: string }>("SELECT DISTINCT scope FROM events ORDER BY scope");
    return rows.map((r) => r.scope);
  }

  async deleteScope(scope: string) {
    await (await database()).runAsync("DELETE FROM events WHERE scope = ?", scope);
  }

  async nextSequence(scope: string) {
    const row = await (await database()).getFirstAsync<{ value: number }>(
      "INSERT INTO counters (scope, value) VALUES (?, 1) ON CONFLICT(scope) DO UPDATE SET value = value + 1 RETURNING value", scope);
    return row!.value;
  }

  async bumpSequence(scope: string, atLeast: number) {
    await (await database()).runAsync(
      "INSERT INTO counters (scope, value) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET value = MAX(value, excluded.value)",
      scope, atLeast - 1,
    );
  }
}

/** Key/value cache (trip payload, rules, geofences, dwell state, load session, acceptance snapshot). */
export const kv = {
  async get<T>(key: string): Promise<T | null> {
    const row = await (await database()).getFirstAsync<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as T) : null;
  },
  async set(key: string, value: unknown): Promise<void> {
    await (await database()).runAsync(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key, JSON.stringify(value), new Date().toISOString(),
    );
  },
  async removePrefix(prefix: string): Promise<void> {
    await (await database()).runAsync("DELETE FROM kv WHERE substr(key, 1, length(?)) = ?", prefix, prefix);
  },
  async remove(key: string): Promise<void> {
    await (await database()).runAsync("DELETE FROM kv WHERE key = ?", key);
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
  /** { id, name } of the last driver signed in on this phone; kept across sign-out (the queue may hold their events). */
  lastStaff: "auth.lastStaff",
  mode: "app.mode",
  permissionsSeen: "app.permissionsSeen",
} as const;
