import Constants from "expo-constants";
import { router } from "expo-router";
import { useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { Btn, Callout, Panel, Screen, StatusPill, T } from "@/components/ui";
import { API_BASE, VARIANT } from "@/config";
import { useSyncStatus } from "@/sync/engine";

export default function Account() {
  const a = useAuth();
  const sync = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const me = a.me;
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
          <Btn tone={a.mode === "cannabis" ? "purple" : "default"} onPress={async () => { await a.setMode("cannabis"); router.replace("/trip"); }}>Cannabis delivery</Btn>
          <Btn onPress={async () => { await a.setMode("courier"); router.replace("/courier"); }}>Food courier</Btn>
        </Panel>
      ) : null}
      <Panel title="Permissions">
        <Btn onPress={() => router.push("/permissions")}>Review notifications and location</Btn>
      </Panel>
      {sync.pending > 0 ? <Callout tone="amber" title={`${sync.pending} events not synced yet`}>They stay on this device and upload after you sign in again. Do not uninstall the app.</Callout> : null}
      <Btn tone="danger" busy={busy} onPress={async () => { setBusy(true); await a.signOut(); setBusy(false); router.replace("/sign-in"); }}>Sign out</Btn>
      <T size="sm" tone="text3" style={{ textAlign: "center" }}>v{Constants.expoConfig?.version} · {VARIANT} · {API_BASE}</T>
    </Screen>
  );
}
