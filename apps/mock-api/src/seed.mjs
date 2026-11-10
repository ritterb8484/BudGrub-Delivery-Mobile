/** Seed data: tenant Desert Bloom, stub identities, one planned trip in Las Vegas. Synthetic. */

export const CHECKLIST = [
  { key: "agent_card", label: "I am carrying my valid agent card" },
  { key: "approved_vehicle", label: "This is an approved delivery vehicle" },
  { key: "inspection_card", label: "The vehicle inspection card is in the vehicle" },
  { key: "alarm", label: "The vehicle alarm is working" },
  { key: "lockbox", label: "The lockbox / locked cargo area is secure" },
  { key: "no_passengers", label: "No passengers are in the vehicle" },
];

export const ID_TYPES = ["drivers_license", "state_id", "passport", "military_id"];

export const STAFF = {
  "stub-jamal": {
    id: "stf_jamal",
    name: "Jamal Pierce",
    email: "jamal.pierce@desertbloom.test",
    role: "driver",
    status: "active",
    tenant: { id: "ten_desert_bloom", name: "Desert Bloom" },
    agent: { agentCardNumber: "NV-AG-104233", agentCardExpires: "2027-06-30", disclosedToCcb: true, status: "active", problems: [] },
  },
  "stub-rosa": {
    id: "stf_rosa",
    name: "Rosa Delgado",
    email: "rosa.delgado@desertbloom.test",
    role: "driver",
    status: "active",
    tenant: { id: "ten_desert_bloom", name: "Desert Bloom" },
    agent: { agentCardNumber: "NV-AG-099120", agentCardExpires: "2026-01-31", disclosedToCcb: true, status: "active", problems: ["Agent card expired 2026-01-31"] },
  },
  "stub-dana": {
    id: "stf_dana",
    name: "Dana Whitfield",
    email: "dana.whitfield@desertbloom.test",
    role: "dispatcher",
    status: "active",
    tenant: { id: "ten_desert_bloom", name: "Desert Bloom" },
    agent: null,
  },
};

export const DISPENSARY = { name: "Desert Bloom · Spring Mountain", address: "4500 Spring Mountain Rd, Las Vegas NV 89103", lat: 36.1263, lng: -115.195 };

let tripCounter = 2000;

export function seedTrip(now = new Date(), driverId = "stf_jamal") {
  const n = ++tripCounter;
  const lockedAt = new Date(now.getTime() - 10 * 60_000).toISOString();
  const eta = (min) => new Date(now.getTime() + min * 60_000).toISOString();
  const tag = (s) => `1A4060300003B0100${String(n).padStart(4, "0")}${s}`;
  return {
    id: `trp_${n}`,
    number: `TR-${n}`,
    status: "planned",
    driverId,
    vehicle: { id: "veh_2", label: "Van 2 · Toyota Sienna · NV 7BUD142" },
    flowerEquivG: 17.5,
    capFlowerEquivG: 70,
    valueCents: 21400,
    capValueCents: 300000,
    floatIssuedCents: 0,
    manifestLockedAt: lockedAt,
    planVersion: 1,
    planAcknowledgedVersion: 1,
    returnToStore: true,
    manualManifest: null,
    plannedRoute: "Spring Mountain → W Sahara → Charleston → Spring Mountain",
    completedAt: null,
    dispensary: DISPENSARY,
    geofenceRadiusM: 150,
    dwellThresholdSec: 180,
    loadPhotoRequired: false,
    load: null,
    lastSequence: 0,
    stops: [
      {
        orderId: `ord_${n}_1`, orderNumber: `BG-${n}1`, seq: 1, status: "pending",
        recipient: "Jamal Pierce", recipientFirstName: "Jamal", phone: "+17025550141",
        address: { line1: "2300 W Sahara Ave", line2: "Apt 412", city: "Las Vegas", zip: "89102", instructions: "Gate code 4412", lat: 36.1442, lng: -115.1786 },
        items: [
          { name: "Blue Dream 3.5 g", qty: 1, metrcTag: tag("01"), weightG: 3.5, flowerEquivG: 3.5, lineTotalCents: 4000 },
          { name: "Live resin cart 1 g", qty: 1, metrcTag: tag("02"), weightG: 1, flowerEquivG: 4, lineTotalCents: 1400 },
        ],
        totalCents: 5400, paymentMethod: "cash", settledMethod: null, payLink: null, windowLabel: "2:00–4:00 PM", eta: eta(18),
        phoneConfirmedAt: null, phoneAttempts: [], idVerifiedAt: null, idChecks: [],
      },
      {
        orderId: `ord_${n}_2`, orderNumber: `BG-${n}2`, seq: 2, status: "pending",
        recipient: "Maria Garcia Lopez", recipientFirstName: "Maria", phone: "+17025550188",
        address: { line1: "900 S Rancho Dr", line2: null, city: "Las Vegas", zip: "89106", instructions: null, lat: 36.1612, lng: -115.1704 },
        items: [{ name: "Gummies 100 mg", qty: 2, metrcTag: tag("03"), weightG: 30, flowerEquivG: 5, lineTotalCents: 6000 }],
        totalCents: 6000, paymentMethod: "aeropay", settledMethod: "aeropay", payLink: null, windowLabel: "2:30–4:30 PM", eta: eta(31),
        phoneConfirmedAt: null, phoneAttempts: [], idVerifiedAt: null, idChecks: [],
      },
      {
        orderId: `ord_${n}_3`, orderNumber: `BG-${n}3`, seq: 3, status: "pending",
        recipient: "Alicia Moore", recipientFirstName: "Alicia", phone: "+17025550127",
        address: { line1: "1500 W Charleston Blvd", line2: null, city: "Las Vegas", zip: "89102", instructions: "Call on arrival", lat: 36.1588, lng: -115.1629 },
        items: [{ name: "Pre-roll 5-pack", qty: 1, metrcTag: tag("04"), weightG: 5, flowerEquivG: 5, lineTotalCents: 10000 }],
        totalCents: 10000, paymentMethod: "cash", settledMethod: null, payLink: null, windowLabel: "3:00–5:00 PM", eta: eta(44),
        phoneConfirmedAt: null, phoneAttempts: [], idVerifiedAt: null, idChecks: [],
      },
    ],
  };
}
