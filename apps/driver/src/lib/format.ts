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

export function dollarsToCents(v: string): number {
  return Math.round(Number(v || 0) * 100);
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
