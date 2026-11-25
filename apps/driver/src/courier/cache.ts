import { ApiError, NetworkError } from "@/api/client";
import { kv } from "@/storage/db";
import { api } from "./api";
import type { CourierDelivery, CourierHome } from "./types";

const prefix = (staffId: string) => `cache.food.${staffId}.`;
const deliveryKey = (staffId: string, deliveryId: string) => `${prefix(staffId)}delivery.${deliveryId}`;
const canUseCache = (error: unknown) => error instanceof NetworkError || error instanceof ApiError && error.status >= 500;
const CACHE_MS = 24 * 60 * 60_000;
interface Snapshot<T> { data: T; cached: boolean; at: number }

async function read<T>(key: string) {
  const snapshot = await kv.get<Snapshot<T>>(key);
  if (snapshot && Date.now() - snapshot.at <= CACHE_MS) return { ...snapshot, cached: true };
  if (snapshot) await kv.remove(key);
  return null;
}

export async function loadCourierHome(staffId: string): Promise<Snapshot<CourierHome>> {
  const key = `${prefix(staffId)}home`;
  let home: CourierHome;
  try { home = await api.home(); }
  catch (error) {
    if (canUseCache(error)) {
      const cached = await read<CourierHome>(key);
      if (cached) return cached;
    }
    throw error;
  }
  const at = Date.now();
  const active = home.activeDeliveries ?? (home.current ? [home.current] : []);
  const previous = await read<CourierHome>(key);
  const activeIds = new Set(active.map(item => item.id));
  await Promise.all((previous?.data.activeDeliveries ?? []).filter(item => !activeIds.has(item.id)).map(item => kv.remove(deliveryKey(staffId, item.id))));
  // Only active stops survive restarts. Offers need a live server response.
  await kv.set(key, { data: { ...home, activeDeliveries: active, recent: [], offers: [] }, cached: false, at });
  return { data: home, cached: false, at };
}

export async function loadCourierDelivery(staffId: string, id: string): Promise<Snapshot<CourierDelivery>> {
  const key = deliveryKey(staffId, id);
  let data: CourierDelivery;
  try { data = await api.delivery(id); }
  catch (error) {
    if (canUseCache(error)) {
      const cached = await read<CourierDelivery>(key);
      if (cached) return cached;
      const home = await read<CourierHome>(`${prefix(staffId)}home`);
      const active = home?.data.activeDeliveries.find(item => item.id === id);
      if (active && home) return { data: active, cached: true, at: home.at };
    } else {
      await kv.remove(key);
      if (error instanceof ApiError && error.status === 404) {
        const homeKey = `${prefix(staffId)}home`;
        const home = await read<CourierHome>(homeKey);
        if (home) await kv.set(homeKey, { ...home, data: { ...home.data, current: home.data.current?.id === id ? null : home.data.current, activeDeliveries: home.data.activeDeliveries.filter(item => item.id !== id) } });
      }
    }
    throw error;
  }
  const snapshot = { data, cached: false, at: Date.now() };
  if (["accepted", "at_vendor", "picked_up", "en_route", "arrived"].includes(data.status)) await kv.set(key, snapshot);
  else await kv.remove(key);
  return snapshot;
}
