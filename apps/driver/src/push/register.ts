import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import { Platform } from "react-native";
import { api } from "@/api/client";
import { PUSH_TOKEN_KIND } from "@/config";
import { color } from "@/theme";
import { kv, KV } from "@/storage/db";

/**
 * Push registration (BUD-67). Registers on sign-in, deregisters on sign-out, via POST/DELETE /admin/driver/devices.
 * Token kind is configurable (EXPO_PUBLIC_PUSH_TOKEN_KIND): the API currently sends staff pushes through FCM
 * (services/notifications.ts), which needs the native device token; an Expo push token needs the API to send through
 * Expo's push service. See docs/driver-api-changes.md.
 */
export const PUSH_TYPES = ["trip_assigned", "plan_amended", "trip_return", "admin_alert"] as const;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function ensureChannels() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("trips", {
    name: "Trip offers and dispatch changes",
    importance: AndroidImportance.MAX,
    lightColor: color.purple,
    vibrationPattern: [0, 250, 250, 250],
  });
  await Notifications.setNotificationChannelAsync("compliance", {
    name: "Stop prompts and compliance alerts",
    importance: AndroidImportance.HIGH,
  });
}

async function currentToken(): Promise<string | null> {
  if (!Device.isDevice) return null; // simulators/emulators without Play services cannot receive pushes
  if (PUSH_TOKEN_KIND === "expo") {
    const projectId = (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
    if (!projectId) return null;
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  }
  const t = await Notifications.getDevicePushTokenAsync();
  return typeof t.data === "string" ? t.data : null;
}

export async function registerPush(): Promise<string | null> {
  await ensureChannels();
  const perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) return null;
  const token = await currentToken();
  if (!token) return null;
  const platform = Platform.OS === "ios" ? "ios" : "android";
  await api.registerDevice(platform, token);
  await kv.set(KV.pushToken, { platform, token });
  return token;
}

export async function deregisterPush(): Promise<void> {
  const saved = await kv.get<{ platform: "ios" | "android"; token: string }>(KV.pushToken);
  if (!saved) return;
  try {
    await api.deregisterDevice(saved.platform, saved.token);
  } finally {
    await kv.remove(KV.pushToken);
  }
}
