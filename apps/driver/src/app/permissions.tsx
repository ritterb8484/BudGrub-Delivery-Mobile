import { router } from "expo-router";
import { useEffect, useState } from "react";
import { AppState, Linking, View } from "react-native";
import { useToast } from "@/components/toast";
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
  const toast = useToast();
  const [snap, setSnap] = useState<PermissionSnapshot | null>(null);
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  /** Steps where the system prompt was requested and the permission is still off: the OS will not ask again. */
  const [refused, setRefused] = useState<Record<string, boolean>>({});

  // Also re-read when the driver comes back from the Settings app.
  useEffect(() => {
    let live = true;
    const read = () => void permissionSnapshot().then((s) => live && setSnap(s));
    read();
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") read();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  const step = STEPS[i];
  const granted = snap?.[step?.key ?? "notifications"] ?? false;
  const needsForegroundFirst = step?.key === "background" && snap !== null && !snap.foreground;

  const ask = async () => {
    setBusy(true);
    try {
      const ok = await step.request();
      if (step.key === "notifications") void registerPush().catch(() => undefined);
      setSnap(await permissionSnapshot());
      setRefused((r) => ({ ...r, [step.key]: !ok }));
    } catch (e) {
      toast.fail(e);
      setRefused((r) => ({ ...r, [step.key]: true }));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    await kv.set(KV.permissionsSeen, true);
    // Opened from the trip or account screen: go back there. First run: continue through the gate.
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  const next = () => (i < STEPS.length - 1 ? setI(i + 1) : void finish());

  if (!step) return null;
  return (
    <Screen
      footer={
        <>
          {granted ? <Btn tone="purple" onPress={next}>{i < STEPS.length - 1 ? "Next" : "Done"}</Btn> : <Btn tone="purple" busy={busy} disabled={needsForegroundFirst} onPress={ask}>{step.cta}</Btn>}
          {!granted ? <Btn onPress={next}>Not now</Btn> : null}
          {i > 0 ? <Btn onPress={() => setI(i - 1)}>Back</Btn> : null}
        </>
      }
    >
      <T tone="text3" size="sm">Step {i + 1} of {STEPS.length}</T>
      <Panel title={step.title} right={<StatusPill tone={granted ? "green" : "neutral"}>{granted ? "Allowed" : "Not allowed"}</StatusPill>}>
        <T tone="text2" size="md">{step.body}</T>
      </Panel>
      {needsForegroundFirst ? <Callout tone="amber" title="Allow location while using the app first">Tap Back to return to the previous step; the “Always” option is offered after that.</Callout> : null}
      {step.key === "background" && !granted ? (
        <Callout tone="danger" title="Required for cannabis deliveries">
          <View style={{ gap: space[2] }}>
            <T tone="text2">You can use the app without it, but you will not be able to start a cannabis shift.</T>
            <Btn size="sm" onPress={() => void Linking.openSettings()}>Open Settings</Btn>
          </View>
        </Callout>
      ) : !granted && refused[step.key] ? (
        <Callout tone="amber" title="Still not allowed">
          <View style={{ gap: space[2] }}>
            <T tone="text2">If no prompt appeared, your phone has stopped asking. Turn it on for BudGrub Driver in Settings, then come back.</T>
            <Btn size="sm" onPress={() => void Linking.openSettings()}>Open Settings</Btn>
          </View>
        </Callout>
      ) : null}
    </Screen>
  );
}
