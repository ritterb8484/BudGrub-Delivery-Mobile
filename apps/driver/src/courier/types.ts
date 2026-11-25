export interface CourierProfile {
  status: "pending" | "active" | "inactive"; phone: string | null;
  vehicle: { make: string | null; model: string | null; plate: string | null; color: string | null };
  license: { number: string | null; expires: string | null }; insurance: { carrier: string | null; expires: string | null };
  backgroundCheck: { status: string; providerRef: string | null; checkedAt: string | null };
  activatedAt: string | null; deactivatedAt: string | null; deactivatedReason: string | null; onShift: boolean; problems: string[];
}
export type DeliveryStatus = "offered" | "accepted" | "at_vendor" | "picked_up" | "en_route" | "arrived" | "delivered" | "failed" | "cancelled";
export interface CourierPickup { label: string; address: string; instructions: string; lat: number | null; lng: number | null }
export interface CourierDelivery {
  id: string; orderId: string; orderNumber: string; status: DeliveryStatus; orderStatus: string; lane: string;
  offer: { expiresAt: string | null; secondsLeft: number | null } | null;
  payoutCents: number; tipCents: number; tipUpdatedAt: string | null; distanceKm: number | null;
  kitchens: { ticketId: string; vendor: { id: string; name: string; slug: string; kind: string }; pickup?: CourierPickup | null; status: string; prepEtaMinutes: number | null; readyAt: string | null; pickedUpAt: string | null; held: boolean }[];
  items: { id: string; name: string; qty: number; vendor: string | null; allergens: string[]; perishable: boolean }[];
  customer: { firstName: string; address: { line1: string | null; line2: string | null; city: string | null; zip: string | null; lat: number | null; lng: number | null; instructions: string | null }; note: string | null; leaveAtDoorAllowed: boolean };
  pairing: { cannabisOrderNumber: string | null; cannabisEtaAt: string | null; windowMinutes: number; outcome: string; plannedReleaseAt: string | null } | null;
  staging?: { lat: number | null; lng: number | null; until: string; reason: string; stagedAt: string | null; released: boolean } | null;
  windowLabel: string | null; placedAt: string; paymentMethod: string;
  times: { offeredAt: string | null; acceptedAt: string | null; atVendorAt: string | null; pickedUpAt: string | null; enRouteAt: string | null; arrivedAt: string | null; deliveredAt: string | null; failedAt: string | null };
  proof: { url: string | null; note: string | null; leftAtDoor: boolean; lat: number | null; lng: number | null } | null;
  failReason: string | null; rating: number | null; issues: { id: string; kind: string; note: string | null; at: string }[];
}
export interface CourierHome { profile: CourierProfile; shift: { id: string; mode: string; startedAt: string } | null; activeDeliveries: CourierDelivery[]; current: CourierDelivery | null; offers: CourierDelivery[]; recent: CourierDelivery[]; rating: { average: number | null; count: number }; offerTtlSeconds: number; batchLimit?: number }
export interface EarningsTotals { payCents: number; tipCents: number; bonusCents: number; totalCents: number; deliveries: number }
export interface Earnings { today: EarningsTotals; week: EarningsTotals; month: EarningsTotals; lines: { id: number; kind: "pay" | "tip" | "bonus" | "adjustment"; cents: number; note: string | null; at: string; deliveryId: string | null; orderNumber: string | null; vendor: string | null }[] }
export interface ShiftRow { id: string; mode: string; startedAt: string; endedAt: string | null; deliveries?: number; incidents?: number; earnedCents?: number }
export interface StaffDocument { id: string; kind: string; label: string; number: string | null; expires: string | null; status: "pending" | "approved" | "rejected" | "expired"; reviewNote: string | null; reviewedAt: string | null; createdAt: string; daysToExpiry: number | null; url: string }
export interface ContactThread {
  orderNumber: string; session: { id: string; status: "open" | "closed"; dial: string | null; openedAt: string; closedAt: string | null } | null;
  messages: { id: number; direction: "to_customer" | "to_staff"; body: string; status: string; at: string }[];
  calls: { id: number; direction: string; startedAt: string; endedAt: string | null; durationS: number | null; outcome: string }[];
}

export interface CourierSettlement { id: string; cents: number; cutoffAt: string; state: "approved" | "paid"; paidAt: string | null; paymentReference: string | null }
