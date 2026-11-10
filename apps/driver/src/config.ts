import Constants from "expo-constants";
import { Platform } from "react-native";

/** Environment switching (BUD-67): EXPO_PUBLIC_API_BASE per EAS profile (eas.json) or .env locally. */
const raw = (process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000/api").replace(/\/+$/, "");

// The Android emulator reaches the host machine at 10.0.2.2, not localhost.
export const API_BASE = Platform.OS === "android" && __DEV__ ? raw.replace(/\/\/(localhost|127\.0\.0\.1)/, "//10.0.2.2") : raw;

export const VARIANT: "development" | "staging" | "production" = (Constants.expoConfig?.extra?.variant as never) ?? "development";

export const PUSH_TOKEN_KIND: "device" | "expo" = process.env.EXPO_PUBLIC_PUSH_TOKEN_KIND === "expo" ? "expo" : "device";

/** Registered with the API as the `driver` OIDC client (apps/api/src/config.ts client redirect URIs). */
export const AUTH_REDIRECT = "budgrub-driver://auth/callback";
export const AUTH_CLIENT = "driver";

export const LOCATION_TASK = "budgrub-trip-location";

/** BUD-88: 10–15 s trace interval. */
export const LOCATION_INTERVAL_MS = 10_000;
export const LOCATION_BATCH_MS = 15_000;

export const SYNC_INTERVAL_MS = 15_000;
