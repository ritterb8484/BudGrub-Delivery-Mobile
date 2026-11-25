// The background location task must be defined at module scope, before anything renders (headless relaunch).
import { stopTracking } from "@/location/task";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
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
  const lastTap = useRef<string | null>(null);
  const { refresh } = useAuth();
  useEffect(() => {
    if (status !== "signedIn" || mode !== "courier") return;
    void refresh().then(staff => {
      if (staff && staff.activeDeliveryMode !== "cannabis") return stopTracking();
    }).catch(() => undefined);
  }, [mode, refresh, status]);

  useEffect(() => {
    const invalidate = () => {
      void qc.invalidateQueries({ queryKey: DRIVER_KEY });
      void qc.invalidateQueries({ queryKey: ["courier-home"] });
      void qc.invalidateQueries({ queryKey: ["courier-delivery"] });
    };
    const handleTap = (response: Notifications.NotificationResponse) => {
      if (status !== "signedIn" || !mode) return;
      const { request } = response.notification;
      const data = request.content.data as { type?: string; deliveryId?: string };
      if (!data.type || lastTap.current === request.identifier) return;
      lastTap.current = request.identifier;
      void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
      invalidate();
      if (mode === "courier" && data.type.startsWith("courier_")) {
        if (data.deliveryId && data.type !== "courier_offer") router.navigate({ pathname: "/courier/delivery/[id]", params: { id: data.deliveryId } });
        else router.navigate("/courier");
      } else if (mode === "cannabis" && !data.type.startsWith("courier_")) {
        router.navigate("/trip");
      }
    };
    const received = Notifications.addNotificationReceivedListener(invalidate);
    const tapped = Notifications.addNotificationResponseReceivedListener(handleTap);
    let mounted = true;
    if (status === "signedIn" && mode) {
      void Notifications.getLastNotificationResponseAsync().then(r => {
        if (mounted && r) handleTap(r);
      }).catch(() => undefined);
    }
    return () => {
      mounted = false;
      received.remove();
      tapped.remove();
    };
  }, [qc, mode, status]);
  return null;
}

/**
 * Every screen except sign-in needs a session. When the session ends anywhere in the app (sign-out, or a 401 because
 * the token was revoked or the user suspended), the guard removes the signed-in screens from the stack and lands on
 * sign-in, so nothing of the previous session can be reached with the back gesture.
 */
function RootStack() {
  const { status, mode } = useAuth();
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
        <Stack.Protected guard={mode === "courier"}>
          <Stack.Screen name="courier/index" options={{ title: "Food courier", headerBackVisible: false }} />
          <Stack.Screen name="courier/delivery/[id]" options={{ title: "Delivery" }} />
          <Stack.Screen name="courier/contact/[orderId]" options={{ title: "Contact customer" }} />
          <Stack.Screen name="courier/earnings" options={{ title: "Earnings" }} />
          <Stack.Screen name="courier/shifts" options={{ title: "Shift history" }} />
          <Stack.Screen name="courier/documents" options={{ title: "Documents" }} />
        </Stack.Protected>
        <Stack.Protected guard={mode === "cannabis"}>
          <Stack.Screen name="trip/index" options={{ title: "My trip", headerBackVisible: false }} />
          <Stack.Screen name="trip/scan" options={{ title: "Scan the load" }} />
          <Stack.Screen name="trip/id-check" options={{ title: "Check government ID" }} />
          <Stack.Screen name="trip/fuel-stop" options={{ title: "Fuel stop" }} />
          <Stack.Screen name="incident" options={{ title: "Report an incident" }} />
        </Stack.Protected>
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
