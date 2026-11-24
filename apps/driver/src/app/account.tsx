import Constants from "expo-constants";
import { router } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { useAuth, type Mode } from "@/auth/AuthProvider";
import { Btn, Callout, Panel, Screen, StatusPill, T } from "@/components/ui";
import { API_BASE, VARIANT } from "@/config";
import { api as courierApi } from "@/courier/api";
import { kv, KV } from "@/storage/db";
import { useSyncStatus } from "@/sync/engine";

export default function Account() {
  const a = useAuth();
  const sync = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const me = a.me;
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Back to the gate with a clean stack, instead of stacking a second trip/courier screen on top of the first.
  const switchMode = async (m: Mode) => {
    setSwitching(true);
    setError(null);
    try {
      await a.setMode(m);
      if (router.canDismiss()) router.dismissAll();
      router.replace("/");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSwitching(false);
    }
  };

  // The guard in the root layout moves to sign-in when the session ends; no navigation from here.
  const doSignOut = async () => {
    setBusy(true);
    try {
      await a.signOut();
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    const onTrip = Boolean(await kv.get(KV.activeTrip));
    if (!onTrip && sync.pending === 0) return doSignOut();
    Alert.alert(
      onTrip ? "Sign out during a trip?" : "Sign out with unsent events?",
      [
        onTrip ? "Your trip is still in progress and your route keeps being recorded on this phone." : null,
        sync.pending > 0 ? `${sync.pending} event${sync.pending === 1 ? " has" : "s have"} not reached the server and will only upload after you sign in again on this phone.` : null,
      ].filter(Boolean).join(" "),
      [
        { text: "Stay signed in", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void doSignOut() },
      ],
    );
  };

  return (
    <Screen>
      <Panel title={me?.name ?? "Signed in"} right={<StatusPill tone={a.eligibility.cannabis ? "purple" : "blue"}>{a.mode === "cannabis" ? "Cannabis agent" : a.mode === "courier" ? "Food courier" : "No delivery mode"}</StatusPill>}>
        <T tone="text2">{me?.email ?? ""}</T>
        <T tone="text2">Role {me?.role ?? "—"}{me?.tenant ? ` · ${me.tenant.name}` : ""}</T>
        {me?.deliveryAccess ? <T tone="text2">Delivery access: {{ food: "Food Only", cannabis: "Cannabis Only", both: "Both" }[me.deliveryAccess]}</T> : null}
        {me?.role === "driver" && me.deliveryAccess !== "food" ? <T tone="text2">Agent card {me?.agent?.agentCardNumber ?? "not on file"}{me?.agent?.agentCardExpires ? ` · expires ${me.agent.agentCardExpires.slice(0, 10)}` : ""}</T> : null}
        {a.offline ? <T tone="amber" size="sm">Offline: showing the record from your last sign-in.</T> : null}
      </Panel>
      {!a.eligibility.cannabis && a.eligibility.problems.length ? <Callout tone="amber" title="Cannabis mode unavailable">{a.eligibility.problems.join(". ")}.</Callout> : null}
      {error && <Callout tone="danger" title="Could not change delivery mode">{error}</Callout>}
      {a.eligibility.cannabis && a.eligibility.courier ? (
        <Panel title="Mode">
          <Btn tone={a.mode === "cannabis" ? "purple" : "default"} disabled={switching || a.mode === "cannabis"} onPress={() => void switchMode("cannabis")}>Cannabis delivery</Btn>
          <Btn tone={a.mode === "courier" ? "purple" : "default"} disabled={switching || a.mode === "courier"} onPress={() => void switchMode("courier")}>Food courier</Btn>
        </Panel>
      ) : null}
      {me?.deliveryShift === "cannabis" && <Btn disabled={switching || sync.pending > 0} onPress={async () => {
        setSwitching(true);
        setError(null);
        try {
          await courierApi.endShift();
          await a.refresh();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setSwitching(false);
        }
      }}>End cannabis shift</Btn>}
      <Panel title="Permissions">
        <Btn onPress={() => router.push("/permissions")}>Review notifications and location</Btn>
      </Panel>
      {sync.pending > 0 ? <Callout tone="amber" title={`${sync.pending} events not synced yet`}>They stay on this device and upload after you sign in again. Do not uninstall the app.</Callout> : null}
      <Btn tone="danger" busy={busy} onPress={() => void signOut()}>Sign out</Btn>
      <T size="sm" tone="text3" style={{ textAlign: "center" }}>v{Constants.expoConfig?.version} · {VARIANT} · {API_BASE}</T>
    </Screen>
  );
}
