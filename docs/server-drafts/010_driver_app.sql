-- 010_driver_app.sql — DRAFT for apps/api migrations (E10 driver app).
-- Written without access to apps/api: table names (trips, staff), the tenant column and the RLS setting
-- (current_setting('app.tenant_id')) follow common conventions and MUST be aligned with migrations 001–009 before use.

BEGIN;

-- BUD-124: per-trip device event sequence.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS last_event_sequence integer NOT NULL DEFAULT 0;

-- BUD-124: processed device events (idempotency + replay results).
CREATE TABLE IF NOT EXISTS trip_device_events (
  tenant_id    uuid        NOT NULL,
  trip_id      uuid        NOT NULL REFERENCES trips(id) ON DELETE RESTRICT,  -- audit record: trips are not deleted
  event_id     uuid        NOT NULL,              -- Idempotency-Key
  sequence     integer     NOT NULL,
  kind         text        NOT NULL,              -- stop_action | location | load | trip_event
  path         text        NOT NULL,
  status_code  smallint    NOT NULL,
  response     jsonb       NOT NULL,
  device_ts    timestamptz,
  staff_id     uuid        NOT NULL REFERENCES staff(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, event_id),
  UNIQUE (trip_id, sequence)
);

-- Incidents filed offline: idempotency per staff member (no sequence).
CREATE TABLE IF NOT EXISTS staff_idempotency_keys (
  tenant_id    uuid        NOT NULL,
  staff_id     uuid        NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  key          uuid        NOT NULL,
  status_code  smallint    NOT NULL,
  response     jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, key)
);

-- BUD-83: package scans + sealed-load attestation (one per trip; deleted when the manifest is re-issued).
CREATE TABLE IF NOT EXISTS trip_loads (
  tenant_id           uuid        NOT NULL,
  trip_id             uuid        PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  manifest_locked_at  timestamptz NOT NULL,
  scanned_tags        text[]      NOT NULL,
  scans               jsonb       NOT NULL,       -- [{ tag, at, result }]
  sealed              boolean     NOT NULL,
  not_visible         boolean     NOT NULL,
  lockbox             boolean     NOT NULL,
  attested_at         timestamptz NOT NULL,
  photo_path          text,                       -- evidence storage (EXPORTS_DIR)
  attested_by         uuid        NOT NULL REFERENCES staff(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (sealed AND not_visible AND lockbox)
);

-- BUD-88: trip timeline events from the device (fuel stops, dwell).
CREATE TABLE IF NOT EXISTS trip_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  trip_id      uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind         text        NOT NULL CHECK (kind IN ('fuel_stop', 'dwell')),
  lat          double precision,
  lng          double precision,
  started_at   timestamptz,
  ended_at     timestamptz,
  note         text,
  receipt_path text,
  staff_id     uuid        NOT NULL REFERENCES staff(id),
  device_ts    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'fuel_stop' OR (started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at >= started_at))
);
CREATE INDEX IF NOT EXISTS trip_events_trip ON trip_events (trip_id, created_at);

-- BUD-77: declines audited on the driver record.
CREATE TABLE IF NOT EXISTS driver_trip_declines (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  staff_id    uuid        NOT NULL REFERENCES staff(id),
  trip_id     uuid        NOT NULL REFERENCES trips(id),
  reason      text        NOT NULL CHECK (length(btrim(reason)) >= 3),
  declined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_trip_declines_staff ON driver_trip_declines (staff_id, declined_at DESC);

-- Row-level security: tenant isolation, same pattern as the existing tables (align the setting name).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_device_events', 'staff_idempotency_keys', 'trip_loads', 'trip_events', 'driver_trip_declines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)$p$, t);
  END LOOP;
END $$;

-- Device events and declines are append-only audit records.
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS trip_device_events_append_only ON trip_device_events;
CREATE TRIGGER trip_device_events_append_only BEFORE UPDATE OR DELETE ON trip_device_events FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
DROP TRIGGER IF EXISTS driver_trip_declines_append_only ON driver_trip_declines;
CREATE TRIGGER driver_trip_declines_append_only BEFORE UPDATE OR DELETE ON driver_trip_declines FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

COMMIT;
