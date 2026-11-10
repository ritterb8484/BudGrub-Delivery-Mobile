/**
 * Driver API types. These mirror what apps/admin/src/pages/DriverTrip.tsx reads from `GET /api/admin/driver/trips`
 * (types imported there from ../lib/types). When this app moves into the monorepo, replace this file with re-exports
 * from `@budgrub/api-client` (generated from openapi.json) and delete the duplicates.
 *
 * Fields marked "driver app" are additions the native app needs; see docs/driver-api-changes.md.
 */

export type StopStatus = "pending" | "en_route" | "arrived" | "delivered" | "returned" | "cancelled";
export type TripStatus = "planned" | "departed" | "completed" | "cancelled";
export type StopActionName = "en-route" | "arrived" | "phone" | "id-check" | "deliver" | "return";
export type PhoneOutcome = "confirmed" | "no_answer" | "voicemail" | "wrong_number" | "declined";

export interface Address {
  line1: string;
  line2?: string | null;
  city: string;
  zip: string;
  instructions?: string | null;
  /** driver app: geocoded position for the map, navigation and geofences */
  lat?: number | null;
  lng?: number | null;
}

export interface StopItem {
  name: string;
  qty: number;
  metrcTag: string | null;
  /** driver app: per-item weight for the offer screen */
  weightG?: number | null;
  flowerEquivG?: number | null;
  lineTotalCents?: number | null;
}

export interface PhoneAttempt {
  at: string;
  outcome: PhoneOutcome | string;
  note?: string | null;
}

export interface IdCheckReason {
  code: string;
  message: string;
}

export interface IdCheckResult {
  ok: boolean;
  reasons: IdCheckReason[];
}

export interface IdCheckLog extends IdCheckResult {
  at: string;
  idType?: string;
  last4?: string | null;
  dobYear?: number | null;
}

export interface PayLink {
  status: "pending" | "paid" | "expired" | "declined";
  expiresAt: string;
  url?: string;
}

export interface TripStop {
  orderId: string;
  orderNumber: string;
  seq: number;
  status: StopStatus;
  recipient: string;
  /** driver app: offer screen shows first name only */
  recipientFirstName?: string | null;
  phone?: string | null;
  address: Address;
  items: StopItem[];
  totalCents: number;
  paymentMethod: "cash" | "aeropay" | string;
  settledMethod?: string | null;
  payLink?: PayLink | null;
  windowLabel: string;
  /** server ETA (services/tracking.ts) */
  eta?: string | null;
  phoneConfirmedAt: string | null;
  phoneAttempts: PhoneAttempt[];
  idVerifiedAt: string | null;
  idChecks: IdCheckLog[];
}

export interface Dispensary {
  name: string;
  address?: string;
  lat: number;
  lng: number;
}

export interface TripLoad {
  scannedTags: string[];
  attestedAt: string | null;
  photoUrl?: string | null;
}

export interface Trip {
  id: string;
  number: string;
  status: TripStatus;
  vehicle: { id?: string; label: string };
  flowerEquivG: number;
  /** driver app: per-trip cap the offer is shown against */
  capFlowerEquivG?: number | null;
  capValueCents?: number | null;
  valueCents?: number | null;
  cashExpectedCents: number;
  floatIssuedCents: number;
  floatAvailableCents: number;
  plannedRoute?: string | null;
  manifestLockedAt: string | null;
  planVersion: number;
  planAcknowledgedVersion: number;
  returnToStore?: boolean;
  manualManifest?: { reference: string } | null;
  completedAt?: string | null;
  stops: TripStop[];
  /** driver app: geofence centre for the store */
  dispensary?: Dispensary | null;
  geofenceRadiusM?: number | null;
  dwellThresholdSec?: number | null;
  loadPhotoRequired?: boolean;
  load?: TripLoad | null;
  /** driver app: last event sequence the server processed for this trip */
  lastSequence?: number;
}

export interface ChecklistItem {
  key: string;
  label: string;
}

export interface AgentSummary {
  name: string;
  agentCardNumber: string | null;
  agentCardExpires: string | null;
  problems: string[];
}

export interface DriverTripsResponse {
  current: Trip | null;
  recent: Trip[];
  checklist: ChecklistItem[];
  idTypes: string[];
  agent: AgentSummary;
  minAge: number;
  metrcDegraded: boolean;
}

export type StopActionBody =
  | { outcome: PhoneOutcome | string; note?: string }
  | { name: string; dob: string; idType: string; last4: string | null; expires: string | null }
  | { cashReceivedCents?: number }
  | { reason: string }
  | Record<string, never>;

export type StaffRole = "driver" | "dispatcher" | "manager" | "admin" | "compliance" | string;

export interface StaffMe {
  id: string;
  name: string;
  email?: string | null;
  role: StaffRole;
  status?: "active" | "suspended" | string;
  tenant?: { id: string; name: string } | null;
  agent?: {
    agentCardNumber: string | null;
    agentCardExpires: string | null;
    disclosedToCcb?: boolean;
    status?: "active" | "suspended" | string;
    problems?: string[];
  } | null;
}

export interface IncidentInput {
  kind: "crash" | "theft_loss" | "unauthorized_stop" | "other";
  description: string;
  location: string | null;
  packages: string[];
  policeReportNumber: string | null;
  injuries?: boolean;
  /** driver app */
  tripId?: string | null;
  lat?: number | null;
  lng?: number | null;
  startedAt?: string | null;
  durationSec?: number | null;
}

export interface LocationPing {
  lat: number;
  lng: number;
  speedMps: number | null;
  heading: number | null;
  accuracyM: number | null;
  recordedAt: string;
}
