import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, ApiError, auth, NetworkError, rawRequest } from "@/api/client";
import type { StaffMe } from "@/api/types";
import { deregisterPush, registerPush } from "@/push/register";
import { stopTracking } from "@/location/task";
import { kv, KV } from "@/storage/db";
import { queue, refreshStatus } from "@/sync/engine";
import { eligibility, type Eligibility } from "./eligibility";
import { signIn as oidcSignIn, tokenStore } from "./oidc";

export type Mode = "cannabis" | "courier";

interface AuthState {
  status: "loading" | "signedOut" | "signedIn";
  me: StaffMe | null;
  eligibility: Eligibility;
  mode: Mode | null;
  /** Last /admin/me refresh failed for lack of connectivity: the cached staff record is shown. */
  offline: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<StaffMe | null>;
  setMode: (m: Mode) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);
const ME_KEY = "auth.me";
interface LastStaff {
  id: string;
  name: string;
}

/**
 * Session state (BUD-67): the staff record is refreshed on launch and every foreground, so role or agent-record
 * changes made by an admin take effect without a reinstall. Any 401 (token revoked, user suspended) signs out locally.
 * Delivery access and active work come from the server.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [me, setMe] = useState<StaffMe | null>(null);
  const [mode, setModeState] = useState<Mode>("cannabis");
  const [offline, setOffline] = useState(false);
  const signingOut = useRef(false);

  const dropToSignIn = useCallback(async () => {
    auth.setToken(null);
    await tokenStore.clear();
    // The cached trip payload goes too: it is the previous driver's manifest and customer details.
    await Promise.all([kv.remove(ME_KEY), kv.remove(KV.driverTrips), kv.removePrefix("cache.food.")]);
    qc.clear();
    setMe(null);
    setStatus("signedOut");
    void refreshStatus();
  }, [qc]);

  const refresh = useCallback(async () => {
    const token = auth.getToken();
    if (!token) return null;
    try {
      const fresh = await api.me();
      if (auth.getToken() !== token) return null;
      setMe(fresh);
      setOffline(false);
      await kv.set(ME_KEY, fresh);
      await kv.set(KV.lastStaff, { id: fresh.id, name: fresh.name } satisfies LastStaff);
      return fresh;
    } catch (e) {
      if (e instanceof NetworkError) setOffline(true);
      else if (e instanceof ApiError && e.status === 401) await dropToSignIn();
      else throw e;
      return null;
    }
  }, [dropToSignIn]);

  // Launch: restore token, then the staff record (cached copy first so a dead zone at shift start still opens).
  useEffect(() => {
    (async () => {
      const [token, cached, savedMode] = await Promise.all([tokenStore.get(), kv.get<StaffMe>(ME_KEY), kv.get<Mode>(KV.mode)]);
      if (savedMode) setModeState(savedMode);
      if (!token) return setStatus("signedOut");
      auth.setToken(token);
      if (cached) {
        setMe(cached);
        setStatus("signedIn");
      }
      await refresh().catch(() => undefined);
      setStatus((s) => (s === "loading" ? (auth.getToken() ? "signedIn" : "signedOut") : s));
    })();
  }, [refresh]);

  useEffect(() => auth.onUnauthorized(() => void dropToSignIn()), [dropToSignIn]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refresh().catch(() => undefined);
    });
    return () => sub.remove();
  }, [refresh]);

  const signIn = useCallback(async () => {
    const out = await oidcSignIn();
    // The queue uploads with whoever is signed in. Events another driver recorded on this phone would be sent under
    // the wrong account, refused by the server and lost, so that driver has to sync them first.
    const prev = await kv.get<LastStaff>(KV.lastStaff);
    if (prev && prev.id !== out.staff.id) {
      const held = (await queue.pending()).length;
      if (held > 0) {
        await rawRequest("/admin/logout", { method: "POST", body: {}, bearer: out.token }).catch(() => undefined);
        throw new Error(`This phone still holds ${held} unsent trip event${held === 1 ? "" : "s"} recorded by ${prev.name}. ${prev.name} must sign in here and sync first. If that is not possible, contact dispatch.`);
      }
    }
    await tokenStore.set(out.token);
    auth.setToken(out.token);
    setMe(out.staff);
    await kv.set(ME_KEY, out.staff);
    await kv.set(KV.lastStaff, { id: out.staff.id, name: out.staff.name } satisfies LastStaff);
    await refreshStatus();
    setStatus("signedIn");
    await refresh().catch(() => undefined);
    void registerPush().catch(() => undefined);
  }, [refresh]);

  const signOut = useCallback(async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    try {
      await deregisterPush().catch(() => undefined);
      await api.logout().catch(() => undefined);
    } finally {
      signingOut.current = false;
      await dropToSignIn();
    }
  }, [dropToSignIn]);

  const setMode = useCallback(async (m: Mode) => {
    const fresh = await refresh();
    if (!fresh) throw new Error("Connect to BudGrub to switch delivery modes.");
    if (!eligibility(fresh)[m]) throw new Error("This delivery mode is unavailable for your account.");
    const requested = m === "courier" ? "food" : "cannabis";
    if (fresh.activeDeliveryMode && fresh.activeDeliveryMode !== requested) {
      throw new Error(fresh.activeDeliveryMode === "food"
        ? "Finish all food deliveries and end the food shift before switching."
        : "Finish the cannabis trip and end any open cannabis shift before switching.");
    }
    if ((await queue.pending()).length) throw new Error("Sync your outstanding delivery steps before switching.");
    if (m === "courier") {
      await stopTracking();
      await Promise.all([kv.remove(KV.driverTrips), kv.remove(KV.accepted), kv.remove(KV.loadSession)]);
    }
    await kv.set(KV.mode, m);
    setModeState(m);
  }, [refresh]);

  const value = useMemo<AuthState>(() => {
    const el = eligibility(me);
    const activeMode = me?.activeDeliveryMode === "food" ? "courier" : me?.activeDeliveryMode;
    const selected = activeMode && el[activeMode] ? activeMode : el[mode] ? mode : el.cannabis ? "cannabis" : el.courier ? "courier" : null;
    return { status, me, eligibility: el, mode: selected, offline, signIn, signOut, refresh, setMode };
  }, [status, me, mode, offline, signIn, signOut, refresh, setMode]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
