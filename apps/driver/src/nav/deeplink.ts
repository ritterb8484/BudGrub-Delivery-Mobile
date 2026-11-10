/**
 * Turn-by-turn navigation is handed to Apple Maps or Google Maps for the next stop only (BUD-88). The app never offers
 * reorder or skip; the URLs below carry a single destination.
 */
export interface NavTarget {
  lat: number;
  lng: number;
  label: string;
}

export function navigationUrls(t: NavTarget, platform: "ios" | "android"): string[] {
  const ll = `${t.lat},${t.lng}`;
  const q = encodeURIComponent(t.label);
  const web = `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
  if (platform === "ios") {
    return [`maps://?daddr=${ll}&q=${q}&dirflg=d`, `comgooglemaps://?daddr=${ll}&directionsmode=driving`, `https://maps.apple.com/?daddr=${ll}&dirflg=d`];
  }
  return [`google.navigation:q=${ll}&mode=d`, `geo:${ll}?q=${ll}(${q})`, web];
}
