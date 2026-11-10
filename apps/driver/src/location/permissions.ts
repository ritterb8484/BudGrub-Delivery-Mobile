import * as Location from "expo-location";
import * as Notifications from "expo-notifications";

export interface PermissionSnapshot {
  notifications: boolean;
  foreground: boolean;
  /** "Always" location: required to start a cannabis shift (BUD-67). */
  background: boolean;
}

export async function permissionSnapshot(): Promise<PermissionSnapshot> {
  const [n, fg, bg] = await Promise.all([Notifications.getPermissionsAsync(), Location.getForegroundPermissionsAsync(), Location.getBackgroundPermissionsAsync()]);
  return { notifications: n.granted, foreground: fg.granted, background: bg.granted };
}

export const requestNotifications = async () => (await Notifications.requestPermissionsAsync()).granted;
export const requestForeground = async () => (await Location.requestForegroundPermissionsAsync()).granted;
/** Must follow a foreground grant; on Android 11+ this opens system settings for "Allow all the time". */
export const requestBackground = async () => (await Location.requestBackgroundPermissionsAsync()).granted;
