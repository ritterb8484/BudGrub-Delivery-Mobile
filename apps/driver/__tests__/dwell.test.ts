import { DEFAULT_DWELL, initialDwellState, runDwell, stepDwell, tripGeofences, type DwellConfig, type DwellPing } from "@/location/dwell";
import { distanceM } from "@/location/geo";

const STORE = { lat: 36.1147, lng: -115.1728 };
const CUSTOMER = { lat: 36.1699, lng: -115.1398 };
const GAS = { lat: 36.14, lng: -115.16 }; // off-route, ~3 km from both

const cfg: DwellConfig = {
  ...DEFAULT_DWELL,
  geofences: [
    { id: "dispensary", kind: "dispensary", ...STORE, radiusM: 150 },
    { id: "o1", kind: "stop", ...CUSTOMER, radiusM: 150 },
  ],
};

/** Pings every 10 s at a point, with a few metres of jitter. */
function sit(at: { lat: number; lng: number }, fromSec: number, seconds: number): DwellPing[] {
  const out: DwellPing[] = [];
  for (let s = 0; s <= seconds; s += 10) out.push({ lat: at.lat + (s % 20 ? 0.00005 : 0), lng: at.lng, t: (fromSec + s) * 1000, accuracyM: 10 });
  return out;
}

describe("dwell detector", () => {
  it("prompts once after 3 minutes stationary off-route, then closes with the duration", () => {
    const pings = [...sit(GAS, 0, 300), { ...CUSTOMER, t: 400_000, accuracyM: 10 }];
    // Leave the gas station toward a non-geofenced point first so the end event comes from movement.
    pings.splice(pings.length - 1, 0, { lat: GAS.lat + 0.01, lng: GAS.lng, t: 310_000, accuracyM: 10 });
    const { events } = runDwell(initialDwellState(), pings, cfg);
    expect(events.map((e) => e.type)).toEqual(["dwell_start", "dwell_end"]);
    expect(events[0]).toMatchObject({ type: "dwell_start", startedAt: 0, elapsedSec: 180 });
    expect(events[1]).toMatchObject({ type: "dwell_end", startedAt: 0, endedAt: 300_000, durationSec: 300 });
  });

  it("does not prompt under the threshold", () => {
    const { events } = runDwell(initialDwellState(), sit(GAS, 0, 170), cfg);
    expect(events).toEqual([]);
  });

  it("ignores long stops inside the dispensary or a planned-stop geofence", () => {
    expect(runDwell(initialDwellState(), sit(STORE, 0, 900), cfg).events).toEqual([]);
    expect(runDwell(initialDwellState(), sit({ lat: CUSTOMER.lat + 0.0005, lng: CUSTOMER.lng }, 0, 900), cfg).events).toEqual([]);
  });

  it("honours a threshold configured on the trip", () => {
    const { events } = runDwell(initialDwellState(), sit(GAS, 0, 70), { ...cfg, thresholdSec: 60 });
    expect(events.map((e) => e.type)).toEqual(["dwell_start"]);
  });

  it("drops inaccurate and out-of-order pings instead of ending a dwell", () => {
    let s = runDwell(initialDwellState(), sit(GAS, 0, 200), cfg).state;
    expect(s.prompted).toBe(true);
    const jump = stepDwell(s, { lat: GAS.lat + 0.01, lng: GAS.lng, t: 210_000, accuracyM: 500 }, cfg);
    expect(jump.events).toEqual([]);
    s = jump.state;
    const stale = stepDwell(s, { lat: GAS.lat + 0.01, lng: GAS.lng, t: 5_000, accuracyM: 5 }, cfg);
    expect(stale.events).toEqual([]);
  });

  it("closes an open dwell when the vehicle enters a geofence", () => {
    const pings = [...sit(GAS, 0, 200), { ...STORE, t: 260_000, accuracyM: 10 }];
    const { events } = runDwell(initialDwellState(), pings, cfg);
    expect(events.map((e) => e.type)).toEqual(["dwell_start", "dwell_end"]);
  });

  it("is resumable across background-task batches", () => {
    const all = sit(GAS, 0, 240);
    const a = runDwell(initialDwellState(), all.slice(0, 10), cfg);
    const b = runDwell(JSON.parse(JSON.stringify(a.state)), all.slice(10), cfg);
    expect([...a.events, ...b.events].map((e) => e.type)).toEqual(["dwell_start"]);
  });

  it("builds geofences from the trip payload", () => {
    const fences = tripGeofences({
      dispensary: STORE,
      geofenceRadiusM: 200,
      stops: [
        { orderId: "o1", address: CUSTOMER },
        { orderId: "o2", address: { lat: null, lng: null } },
      ],
    });
    expect(fences.map((f) => [f.id, f.radiusM])).toEqual([["dispensary", 200], ["o1", 200]]);
    expect(distanceM(STORE, CUSTOMER)).toBeGreaterThan(5000);
  });
});
