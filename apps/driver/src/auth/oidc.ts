import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { api } from "@/api/client";
import type { StaffMe } from "@/api/types";
import { AUTH_REDIRECT } from "@/config";

/**
 * Sign-in through the API's Keycloak OIDC flow (authorization code + PKCE, driven server-side), BUD-67:
 *   POST /api/session                      → anonymous session token
 *   POST /api/auth/start { client: driver } → authorize URL (Keycloak, or /api/auth/stub/login with KEYCLOAK_MODE=stub)
 *   auth session browser → budgrub-driver://auth/callback?code&state
 *   POST /api/auth/callback { code, state } → { staff, token }
 * The staff token is kept in the iOS Keychain / Android Keystore via expo-secure-store.
 */
const TOKEN_KEY = "budgrub.staffToken";

export const tokenStore = {
  get: () => SecureStore.getItemAsync(TOKEN_KEY),
  set: (t: string) => SecureStore.setItemAsync(TOKEN_KEY, t, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  clear: () => SecureStore.deleteItemAsync(TOKEN_KEY),
};

export class SignInCancelled extends Error {
  constructor() {
    super("Sign-in was cancelled");
    this.name = "SignInCancelled";
  }
}

export function parseCallback(url: string): { code: string; state: string } | { error: string } {
  const q = url.includes("?") ? url.slice(url.indexOf("?") + 1).split("#")[0] : "";
  const params = new Map(q.split("&").filter(Boolean).map((kv) => kv.split("=").map((s) => decodeURIComponent(s.replace(/\+/g, " "))) as [string, string]));
  const error = params.get("error");
  if (error) return { error: params.get("error_description") ?? error };
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return { error: "The sign-in response was missing its code" };
  return { code, state };
}

export async function signIn(): Promise<{ staff: StaffMe; token: string }> {
  const { token: sessionToken } = await api.session();
  const { url } = await api.authStart(sessionToken);
  const result = await WebBrowser.openAuthSessionAsync(url, AUTH_REDIRECT, { preferEphemeralSession: true });
  if (result.type !== "success") throw new SignInCancelled();
  const parsed = parseCallback(result.url);
  if ("error" in parsed) throw new Error(parsed.error);
  // The caller stores the token once it has decided this account may use the device (see AuthProvider.signIn).
  return api.authCallback(sessionToken, parsed.code, parsed.state);
}
