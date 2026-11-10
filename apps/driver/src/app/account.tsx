import Constants from "expo-constants";
import { router } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { useAuth, type Mode } from "@/auth/AuthProvider";
import { Btn, Callout, Panel, Screen, StatusPill, T } from "@/components/ui";
import { API_BASE, VARIANT } from "@/config";
import { kv, KV } from "@/storage/db";
import { useSyncStatus } from "@/sync/engine";

export default function Account() {
  const a = useAuth();
  const sync = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const me = a.me;

  // Back to the gate with a clean stack, instead of stacking a second trip/courier screen on top of the first.
  const switchMode = async (m: Mode) => {
    await a.setMode(m);
    if (router.canDismiss()) router.dismissAll();
    router.replace("/");
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
      <Panel title={me?.name ?? "Signed in"} right={<StatusPill tone={a.eligibility.cannabis ? "purple" : "blue"}>{a.mode === "cannabis" ? "Cannabis agent" : "Food courier"}</StatusPill>}>
        <T tone="text2">{me?.email ?? ""}</T>
        <T tone="text2">Role {me?.role ?? "—"}{me?.tenant ? ` · ${me.tenant.name}` : ""}</T>
        <T tone="text2">Agent card {me?.agent?.agentCardNumber ?? "not on file"}{me?.agent?.agentCardExpires ? ` · expires ${me.agent.agentCardExpires.slice(0, 10)}` : ""}</T>
        {a.offline ? <T tone="amber" size="sm">Offline: showing the record from your last sign-in.</T> : null}
      </Panel>
      {!a.eligibility.cannabis && a.eligibility.problems.length ? <Callout tone="amber" title="Cannabis mode unavailable">{a.eligibility.problems.join(". ")}.</Callout> : null}
      {a.eligibility.cannabis ? (
        <Panel title="Mode">
          <Btn tone={a.mode === "cannabis" ? "purple" : "default"} onPress={() => void switchMode("cannabis")}>Cannabis delivery</Btn>
          <Btn tone={a.mode === "courier" ? "purple" : "default"} onPress={() => void switchMode("courier")}>Food courier</Btn>
        </Panel>
      ) : null}
      <Panel title="Permissions">
        <Btn onPress={() => router.push("/permissions")}>Review notifications and location</Btn>
      </Panel>
      {sync.pending > 0 ? <Callout tone="amber" title={`${sync.pending} events not synced yet`}>They stay on this device and upload after you sign in again. Do not uninstall the app.</Callout> : null}
      <Btn tone="danger" busy={busy} onPress={() => void signOut()}>Sign out</Btn>
      <T size="sm" tone="text3" style={{ textAlign: "center" }}>v{Constants.expoConfig?.version} · {VARIANT} · {API_BASE}</T>
    </Screen>
  );
}
