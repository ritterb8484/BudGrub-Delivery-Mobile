import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, ApiError, auth, NetworkError } from "@/api/client";
import type { StaffMe } from "@/api/types";
import { deregisterPush, registerPush } from "@/push/register";
import { kv, KV } from "@/storage/db";
import { eligibility, type Eligibility } from "./eligibility";
import { signIn as oidcSignIn, tokenStore } from "./oidc";

export type Mode = "cannabis" | "courier";

interface AuthState {
  status: "loading" | "signedOut" | "signedIn";
  me: StaffMe | null;
  eligibility: Eligibility;
  mode: Mode;
  /** Last /admin/me refresh failed for lack of connectivity: the cached staff record is shown. */
  offline: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  setMode: (m: Mode) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);
const ME_KEY = "auth.me";

/**
 * Session state (BUD-67): the staff record is refreshed on launch and every foreground, so role or agent-record
 * changes made by an admin take effect without a reinstall. Any 401 (token revoked, user suspended) signs out locally.
 * Cannabis mode is offered only when `eligibility().cannabis`; otherwise the courier placeholder is shown.
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
    await kv.remove(ME_KEY);
    qc.clear();
    setMe(null);
    setStatus("signedOut");
  }, [qc]);

  const refresh = useCallback(async () => {
    if (!auth.getToken()) return;
    try {
      const fresh = await api.me();
      setMe(fresh);
      setOffline(false);
      await kv.set(ME_KEY, fresh);
    } catch (e) {
      if (e instanceof NetworkError) setOffline(true);
      else if (e instanceof ApiError && e.status === 401) await dropToSignIn();
      else throw e;
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
    auth.setToken(out.token);
    setMe(out.staff);
    await kv.set(ME_KEY, out.staff);
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
    setModeState(m);
    await kv.set(KV.mode, m);
  }, []);

  const value = useMemo<AuthState>(() => {
    const el = eligibility(me);
    return { status, me, eligibility: el, mode: el.cannabis ? mode : "courier", offline, signIn, signOut, refresh, setMode };
  }, [status, me, mode, offline, signIn, signOut, refresh, setMode]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
