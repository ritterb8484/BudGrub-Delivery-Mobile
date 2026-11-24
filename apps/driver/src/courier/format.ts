export { money } from "@/lib/format";

/** The vendor's four-digit code as typed or scanned: digits only, exactly four; otherwise null. */
export function normalizeCode(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  return d.length === 4 ? d : null;
}

/** Seconds left on an offer, never negative. */
export function secondsLeft(expiresAt: string | null | undefined, now = Date.now()): number {
  if (!expiresAt) return 0;
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
}

/** Leave-at-door is allowed only when the customer allowed it on the order; the server enforces the same rule. */
export const canLeaveAtDoor = (d: { customer: { leaveAtDoorAllowed: boolean } }) => d.customer.leaveAtDoorAllowed;
