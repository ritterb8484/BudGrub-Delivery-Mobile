import * as Crypto from "expo-crypto";
import { request } from "@/api/client";
import type { ContactThread, CourierDelivery, CourierHome, Earnings, ShiftRow, StaffDocument } from "./types";

export const newEventId = () => Crypto.randomUUID();

const orderContact = (id: string) => `/admin/orders/${encodeURIComponent(id)}/contact`;
export const deliveryPath = (id: string) => `/admin/courier/deliveries/${encodeURIComponent(id)}`;

export const api = {
  home: () => request<CourierHome>("/admin/courier/home"),
  delivery: (id: string) => request<{ delivery: CourierDelivery }>(deliveryPath(id)).then((r) => r.delivery),
  startShift: (mode: "food") => request<{ shift: ShiftRow }>("/admin/courier/shifts/start", { body: { mode } }),
  endShift: () => request<{ shift: ShiftRow }>("/admin/courier/shifts/end", { body: {} }),
  shifts: () => request<{ shifts: ShiftRow[] }>("/admin/courier/shifts").then((r) => r.shifts),
  earnings: () => request<Earnings>("/admin/courier/earnings"),
  documents: () => request<{ documents: StaffDocument[] }>("/admin/courier/documents").then((r) => r.documents),
  uploadDocument: (body: { kind: string; number: string | null; expires: string | null; file: { mime: string; dataBase64: string } }, key: string) =>
    request<{ document: StaffDocument }>("/admin/courier/documents", { body, headers: { "Idempotency-Key": key } }),
  contact: (id: string) => request<ContactThread>(orderContact(id)),
  call: (id: string) => request<{ callId: number; dial: string }>(`${orderContact(id)}/call`, { body: {} }),
  callOutcome: (id: string, callId: number, outcome: string, durationS?: number) =>
    request(`${orderContact(id)}/calls/${callId}/outcome`, { body: { outcome, durationS } }),
  message: (id: string, body: string) => request(`${orderContact(id)}/messages`, { body: { body } }),
};
