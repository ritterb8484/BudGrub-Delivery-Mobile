import type { Trip } from "@/api/types";

/**
 * Package scan against the locked manifest (BUD-83, NAC 678B.321 / .327).
 *
 * Every Metrc tag on the manifest must be scanned once before departure. A tag that is not on the manifest, or the same
 * tag scanned twice, raises a blocking mismatch ("contact dispensary"). An unknown tag keeps departure blocked until the
 * load is rescanned from scratch (the stray package is removed) or the manifest is re-issued; a duplicate is recorded
 * and can be dismissed because the package is already accounted for.
 */

export interface ManifestLine {
  tag: string;
  orderId: string;
  orderNumber: string;
  name: string;
  qty: number;
}

export type ScanOutcome =
  | { kind: "matched"; line: ManifestLine }
  | { kind: "duplicate"; line: ManifestLine }
  | { kind: "unknown"; tag: string };

export interface ScanRecord {
  tag: string;
  at: string;
  result: ScanOutcome["kind"];
}

export interface LoadSession {
  tripId: string;
  manifestLockedAt: string | null;
  scans: ScanRecord[];
}

/** Metrc package tags are 24 characters (1A4 + facility + serial). Barcodes may carry spaces or lower case. */
export function normaliseTag(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function manifestLines(trip: Pick<Trip, "stops">): ManifestLine[] {
  const lines: ManifestLine[] = [];
  for (const s of trip.stops) {
    if (s.status === "cancelled") continue;
    for (const i of s.items) {
      if (!i.metrcTag) continue;
      lines.push({ tag: normaliseTag(i.metrcTag), orderId: s.orderId, orderNumber: s.orderNumber, name: i.name, qty: i.qty });
    }
  }
  return lines;
}

export function newSession(trip: Pick<Trip, "id" | "manifestLockedAt">): LoadSession {
  return { tripId: trip.id, manifestLockedAt: trip.manifestLockedAt, scans: [] };
}

export function scanTag(session: LoadSession, lines: ManifestLine[], raw: string, at: string): { session: LoadSession; outcome: ScanOutcome } {
  const tag = normaliseTag(raw);
  const line = lines.find((l) => l.tag === tag);
  let outcome: ScanOutcome;
  if (!line) outcome = { kind: "unknown", tag };
  else if (session.scans.some((s) => s.tag === tag && s.result === "matched")) outcome = { kind: "duplicate", line };
  else outcome = { kind: "matched", line };
  return { session: { ...session, scans: [...session.scans, { tag, at, result: outcome.kind }] }, outcome };
}

export interface LoadSummary {
  total: number;
  loaded: ManifestLine[];
  missing: ManifestLine[];
  unknownTags: string[];
  duplicates: string[];
  /** All lines scanned exactly once and no stray tag: departure may proceed (subject to attestation). */
  complete: boolean;
  blockedReason: string | null;
}

export function summarise(session: LoadSession, lines: ManifestLine[]): LoadSummary {
  const matched = new Set(session.scans.filter((s) => s.result === "matched").map((s) => s.tag));
  const loaded = lines.filter((l) => matched.has(l.tag));
  const missing = lines.filter((l) => !matched.has(l.tag));
  const unknownTags = [...new Set(session.scans.filter((s) => s.result === "unknown").map((s) => s.tag))];
  const duplicates = [...new Set(session.scans.filter((s) => s.result === "duplicate").map((s) => s.tag))];
  let blockedReason: string | null = null;
  if (unknownTags.length) blockedReason = `${unknownTags.length} package${unknownTags.length === 1 ? " is" : "s are"} not on the manifest. Remove ${unknownTags.length === 1 ? "it" : "them"}, contact the dispensary, and rescan the load.`;
  else if (missing.length) blockedReason = `${missing.length} of ${lines.length} package${lines.length === 1 ? "" : "s"} not scanned yet.`;
  else if (!lines.length) blockedReason = "The manifest has no Metrc packages. Contact the dispensary.";
  return { total: lines.length, loaded, missing, unknownTags, duplicates, complete: blockedReason === null, blockedReason };
}

/** The manifest was re-issued (lock timestamp moved): the scan session no longer applies. */
export function sessionIsStale(session: LoadSession | null, trip: Pick<Trip, "id" | "manifestLockedAt">): boolean {
  return !session || session.tripId !== trip.id || session.manifestLockedAt !== trip.manifestLockedAt;
}
