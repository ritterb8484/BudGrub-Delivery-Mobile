// The background location task must be defined at module scope, before anything renders (headless relaunch).
import "@/location/task";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { ToastProvider } from "@/components/toast";
import { ensureChannels, registerPush } from "@/push/register";
import { startSyncLoop } from "@/sync/engine";
import { color } from "@/theme";
import { DRIVER_KEY } from "@/trip/useDriverTrips";

/** Trip offers, plan amendments and return orders arrive by push (services/notifications.ts templates). */
function PushBridge() {
  const qc = useQueryClient();
  const { status, mode } = useAuth();
  useEffect(() => {
    void ensureChannels();
    if (status === "signedIn") void registerPush().catch(() => undefined);
  }, [status]);
  const canOpenTrip = status === "signedIn" && mode === "cannabis";
  useEffect(() => {
    const received = Notifications.addNotificationReceivedListener((n) => {
      const type = (n.request.content.data as { type?: string } | undefined)?.type;
      if (type && type !== "dwell_prompt") void qc.invalidateQueries({ queryKey: DRIVER_KEY });
    });
    const tapped = Notifications.addNotificationResponseReceivedListener((r) => {
      void qc.invalidateQueries({ queryKey: DRIVER_KEY });
      const type = (r.notification.request.content.data as { type?: string } | undefined)?.type;
      // Only a signed-in cannabis agent has a trip screen; anyone else stays where the gate put them.
      if (type && canOpenTrip) router.navigate("/trip");
    });
    return () => {
      received.remove();
      tapped.remove();
    };
  }, [qc, canOpenTrip]);
  return null;
}

/**
 * Every screen except sign-in needs a session. When the session ends anywhere in the app (sign-out, or a 401 because
 * the token was revoked or the user suspended), the guard removes the signed-in screens from the stack and lands on
 * sign-in, so nothing of the previous session can be reached with the back gesture.
 */
function RootStack() {
  const { status } = useAuth();
  const signedOut = status === "signedOut";
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: color.surface },
        headerTintColor: color.text,
        headerTitleStyle: { fontWeight: "700" },
        contentStyle: { backgroundColor: color.bg },
      }}
    >
      <Stack.Protected guard={!signedOut} redirectTo="/sign-in">
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="permissions" options={{ title: "Before your first shift", headerBackVisible: false }} />
        <Stack.Screen name="courier" options={{ title: "Food courier" }} />
        <Stack.Screen name="trip/index" options={{ title: "My trip", headerBackVisible: false }} />
        <Stack.Screen name="trip/scan" options={{ title: "Scan the load" }} />
        <Stack.Screen name="trip/id-check" options={{ title: "Check government ID" }} />
        <Stack.Screen name="trip/fuel-stop" options={{ title: "Fuel stop" }} />
        <Stack.Screen name="incident" options={{ title: "Report an incident" }} />
        <Stack.Screen name="sync" options={{ title: "Sync" }} />
        <Stack.Screen name="account" options={{ title: "Account" }} />
      </Stack.Protected>
      <Stack.Protected guard={signedOut} redirectTo="/">
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, gcTime: 24 * 60 * 60 * 1000 } } }));
  useEffect(() => startSyncLoop(), []);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AuthProvider>
            <PushBridge />
            <StatusBar style="light" />
            <RootStack />
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
