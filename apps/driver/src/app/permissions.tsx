import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { Btn, Callout, Panel, Screen, StatusPill, T } from "@/components/ui";
import { permissionSnapshot, requestBackground, requestForeground, requestNotifications, type PermissionSnapshot } from "@/location/permissions";
import { registerPush } from "@/push/register";
import { kv, KV } from "@/storage/db";
import { space } from "@/theme";

/**
 * Pre-permission explainers (BUD-67): notifications, foreground location, then "Always" location. Each system prompt
 * is preceded by why it is needed. A cannabis shift cannot start without Always location; the trip screen enforces that.
 */
const STEPS = [
  {
    key: "notifications" as const,
    title: "Trip offers and dispatch changes",
    body: "Dispatch sends trip offers, changes to your stop order and return-to-store instructions as notifications. You must acknowledge plan changes before your next stop.",
    cta: "Allow notifications",
    request: requestNotifications,
  },
  {
    key: "foreground" as const,
    title: "Navigate to your next stop",
    body: "Your location shows the next stop on the map and hands directions to Apple Maps or Google Maps.",
    cta: "Allow location while using the app",
    request: requestForeground,
  },
  {
    key: "background" as const,
    title: "Record the trip in the background",
    body: "Nevada rules require a GPS record of every delivery trip, including fuel and any unplanned stops. BudGrub records your route every 10–15 seconds only while a trip is in progress, even with the screen off. Choose \"Always\" (iOS) or \"Allow all the time\" (Android).",
    cta: "Allow location always",
    request: requestBackground,
  },
];

export default function Permissions() {
  const [snap, setSnap] = useState<PermissionSnapshot | null>(null);
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);

  const reload = async () => setSnap(await permissionSnapshot());
  useEffect(() => {
    void permissionSnapshot().then(setSnap);
  }, []);

  const step = STEPS[i];
  const granted = snap?.[step?.key ?? "notifications"] ?? false;

  const ask = async () => {
    setBusy(true);
    try {
      await step.request();
      if (step.key === "notifications") void registerPush().catch(() => undefined);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    await kv.set(KV.permissionsSeen, true);
    router.replace("/");
  };

  if (!step) return null;
  return (
    <Screen
      footer={
        <>
          {granted ? <Btn tone="purple" onPress={() => (i < STEPS.length - 1 ? setI(i + 1) : finish())}>{i < STEPS.length - 1 ? "Next" : "Done"}</Btn> : <Btn tone="purple" busy={busy} onPress={ask}>{step.cta}</Btn>}
          {!granted ? <Btn onPress={() => (i < STEPS.length - 1 ? setI(i + 1) : finish())}>Not now</Btn> : null}
        </>
      }
    >
      <T tone="text3" size="sm">Step {i + 1} of {STEPS.length}</T>
      <Panel title={step.title} right={<StatusPill tone={granted ? "green" : "neutral"}>{granted ? "Allowed" : "Not allowed"}</StatusPill>}>
        <T tone="text2" size="md">{step.body}</T>
      </Panel>
      {step.key === "background" && snap && !snap.foreground ? <Callout tone="amber" title="Allow location while using the app first">Go back one step; the “Always” option is offered after that.</Callout> : null}
      {step.key === "background" && !granted ? (
        <Callout tone="danger" title="Required for cannabis deliveries">
          <View style={{ gap: space[2] }}>
            <T tone="text2">You can use the app without it, but you will not be able to start a cannabis shift.</T>
            <Btn size="sm" onPress={() => Linking.openSettings()}>Open Settings</Btn>
          </View>
        </Callout>
      ) : null}
    </Screen>
  );
}
