import type { StopStatus } from "@/api/types";

/** Same helpers as apps/admin/src/lib/api.ts (money, clock) and pages/Trips.tsx (STOP_TONE, stopLabel). */

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

/**
 * Cents from a typed dollar amount, or null when it is not a plain non-negative amount ("", ".", "1.2.3", "12,50").
 * Cash figures go on the trip record, so an unreadable entry must block the action instead of being sent as 0/NaN.
 */
export function parseCents(v: string): number | null {
  const t = v.trim().replace(/^\$/, "");
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export type Tone = "neutral" | "purple" | "blue" | "green" | "amber" | "danger";

export const STOP_TONE: Record<StopStatus, Tone> = {
  pending: "neutral",
  en_route: "purple",
  arrived: "amber",
  delivered: "green",
  returned: "danger",
  cancelled: "neutral",
};

export function stopLabel(s: StopStatus): string {
  return { pending: "Pending", en_route: "En route", arrived: "Arrived", delivered: "Delivered", returned: "Returned", cancelled: "Cancelled" }[s];
}

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
