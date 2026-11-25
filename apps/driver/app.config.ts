import type { ConfigContext, ExpoConfig } from "expo/config";
import tokens from "@budgrub/design-tokens/tokens.json";

/**
 * BudGrub driver app config. One codebase, three EAS profiles (eas.json sets APP_VARIANT):
 *   development → com.budgrub.driver.dev   "BudGrub Driver (Dev)"
 *   staging     → com.budgrub.driver.staging "BudGrub Driver (Staging)"
 *   production  → com.budgrub.driver
 * The API base comes from EXPO_PUBLIC_API_BASE (set per profile in eas.json or in .env locally).
 * Secrets (Google Maps key, EAS project id) come from EAS environment variables, never from the repo.
 */
const VARIANT = (process.env.APP_VARIANT ?? "development") as "development" | "staging" | "production";
const SUFFIX = VARIANT === "production" ? "" : VARIANT === "staging" ? ".staging" : ".dev";
const NAME_SUFFIX = VARIANT === "production" ? "" : VARIANT === "staging" ? " (Staging)" : " (Dev)";
const AUTH_SCHEME = VARIANT === "staging" ? "budgrub-driver-staging" : "budgrub-driver";

// expo-camera and expo-image-picker both write NSCameraUsageDescription and the last plugin wins, so they must carry
// the same text, and it has to cover every use of the camera.
const CAMERA_PURPOSE =
  "BudGrub scans pickup codes, package tags, and ID barcodes. The camera also captures proof of delivery, onboarding documents, sealed loads, and fuel receipts. Customer ID images are never captured.";
if (VARIANT !== "development") {
  const api = process.env.EXPO_PUBLIC_API_BASE;
  if (!api || !/^https:\/\/[^/]+\/api\/?$/.test(api)) throw new Error("Set EXPO_PUBLIC_API_BASE to the HTTPS BudGrub API ending in /api.");
  if (!process.env.EAS_PROJECT_ID) throw new Error("Set EAS_PROJECT_ID for push and updates.");
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: `BudGrub Driver${NAME_SUFFIX}`,
  slug: "budgrub-driver",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  backgroundColor: tokens.color.bg,
  // Registered with the API as the third OIDC client: budgrub-driver://auth/callback
  scheme: AUTH_SCHEME,
  platforms: ["ios", "android"],
  runtimeVersion: { policy: "fingerprint" },
  updates: process.env.EAS_PROJECT_ID ? { url: `https://u.expo.dev/${process.env.EAS_PROJECT_ID}` } : undefined,
  ios: {
    bundleIdentifier: `com.budgrub.driver${SUFFIX}`,
    supportsTablet: false,
    infoPlist: {
      UIBackgroundModes: ["location", "fetch", "remote-notification"],
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: `com.budgrub.driver${SUFFIX}`,
    allowBackup: false,
    googleServicesFile: process.env.ANDROID_GOOGLE_SERVICES_JSON || undefined,
    adaptiveIcon: {
      backgroundColor: tokens.color.bg,
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    permissions: [
      "ACCESS_COARSE_LOCATION",
      "ACCESS_FINE_LOCATION",
      "ACCESS_BACKGROUND_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
      "CAMERA",
      "POST_NOTIFICATIONS",
    ],
    // Nothing is read from or written to shared storage, and no audio is recorded (ID images are never captured).
    blockedPermissions: ["android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE", "android.permission.RECORD_AUDIO"],
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-web-browser",
    ["expo-sqlite", { useSQLCipher: true }],
    [
      "expo-location",
      {
        locationAlwaysAndWhenInUsePermission:
          "BudGrub records your route during a cannabis delivery trip, including when the app is in the background, as Nevada delivery rules require.",
        locationWhenInUsePermission: "BudGrub uses your location to navigate to your next stop and record the trip.",
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: CAMERA_PURPOSE,
        microphonePermission: false,
        recordAudioAndroid: false,
        barcodeScannerEnabled: true,
      },
    ],
    [
      "expo-image-picker",
      {
        cameraPermission: CAMERA_PURPOSE,
        photosPermission: "BudGrub lets you attach an existing photo of your courier onboarding document.",
        microphonePermission: false,
      },
    ],
    ["expo-notifications", { color: tokens.color.purple, defaultChannel: "trips" }],
    // A blank entry in .env is the same as no key.
    ["react-native-maps", { androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY || undefined }],
  ],
  experiments: { typedRoutes: true },
  extra: {
    variant: VARIANT,
    authRedirect: `${AUTH_SCHEME}://auth/callback`,
    eas: process.env.EAS_PROJECT_ID ? { projectId: process.env.EAS_PROJECT_ID } : undefined,
  },
});
