export interface LatLng {
  lat: number;
  lng: number;
}

export interface Geofence extends LatLng {
  id: string;
  kind: "dispensary" | "stop";
  radiusM: number;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function insideAny(p: LatLng, fences: Geofence[]): Geofence | null {
  for (const f of fences) if (distanceM(p, f) <= f.radiusM) return f;
  return null;
}
