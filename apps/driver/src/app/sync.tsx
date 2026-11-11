import { useEffect, useState } from "react";
import { View } from "react-native";
import { Btn, Callout, Divider, Panel, Row, Screen, StatusPill, T } from "@/components/ui";
import { clock } from "@/lib/format";
import { kv, KV } from "@/storage/db";
import { markReviewed, queue, syncNow, useSyncStatus } from "@/sync/engine";
import { tripScope, type QueuedEvent } from "@/sync/queue";

/**
 * BUD-124 sync log: queued count, last sync, and every event of the current trip and incidents with its server
 * outcome — including Metrc completions and incident notifications executed server-side on replay.
 */
function describe(e: QueuedEvent): string {
  const m = e.meta as Record<string, unknown>;
  if (e.kind === "location") return `GPS trace · ${m.count ?? "?"} points`;
  if (e.kind === "stop_action") return `Stop ${String(m.action)}${m.outcome ? ` (${m.outcome})` : ""}`;
  if (e.kind === "load") return `Load scan + attestation · ${m.tags ?? "?"} packages`;
  if (e.kind === "incident") return `Incident · ${String(m.incidentKind).replace(/_/g, " ")}`;
  if (e.kind === "trip_event") return String(m.event ?? "Trip event").replace(/_/g, " ");
  return e.kind;
}

function outcome(e: QueuedEvent): string | null {
  const r = e.response as Record<string, unknown> | null;
  if (!r) return null;
  const number = r.number ?? (r.incident as Record<string, unknown> | undefined)?.number;
  if (typeof number === "string") return `Filed as ${number}`;
  const metrc = (r.metrc ?? (r.stop as Record<string, unknown> | undefined)?.metrc) as { status?: string } | undefined;
  if (metrc?.status) return `Metrc ${metrc.status}`;
  if (r.replayed) return "Already on the server";
  return null;
}

export default function Sync() {
  const s = useSyncStatus();
  const [events, setEvents] = useState<QueuedEvent[]>([]);
  const [showTrace, setShowTrace] = useState(false);

  useEffect(() => {
    void (async () => {
      const active = await kv.get<{ tripId: string }>(KV.activeTrip);
      const accepted = await kv.get<{ tripId: string }>(KV.accepted);
      const tripId = active?.tripId ?? accepted?.tripId;
      const list = [...(tripId ? await queue.list(tripScope(tripId)) : []), ...(await queue.list("incidents"))];
      setEvents(list.sort((a, b) => b.deviceTs.localeCompare(a.deviceTs)));
    })();
  }, [s]);

  const visible = showTrace ? events : events.filter((e) => e.kind !== "location");

  return (
    <Screen footer={<Btn tone="purple" busy={s.syncing} onPress={() => void syncNow()}>Sync now</Btn>}>
      <Row style={{ justifyContent: "space-between" }}>
        <T bold size="lg">{s.pending ? `${s.pending} queued` : "Everything synced"}</T>
        <StatusPill tone={s.online === false ? "amber" : "green"}>{s.online === false ? "Offline" : "Online"}</StatusPill>
      </Row>
      <T tone="text2">Last sync {clock(s.lastSyncAt)}</T>
      {s.lastError ? <Callout tone="amber" title="Last attempt failed">{s.lastError}</Callout> : null}
      {s.rejected.length ? (
        <Callout tone="danger" title={`${s.rejected.length} rejected by the server`}>
          <View style={{ gap: 6 }}>
            {s.rejected.map((e) => (
              <View key={e.id} style={{ gap: 4 }}>
                <T bold>{describe(e)} · {clock(e.deviceTs)}</T>
                <T tone="text2">{e.lastError}</T>
                <Btn size="sm" onPress={() => void markReviewed(e)}>Reviewed, I will tell dispatch</Btn>
              </View>
            ))}
          </View>
        </Callout>
      ) : null}
      <Panel title="Trip events" right={<Btn size="sm" onPress={() => setShowTrace(!showTrace)}>{showTrace ? "Hide GPS" : "Show GPS"}</Btn>}>
        {visible.length === 0 ? <T tone="text3">Nothing recorded yet.</T> : null}
        {visible.map((e, i) => (
          <View key={e.id}>
            {i > 0 ? <Divider /> : null}
            <Row style={{ justifyContent: "space-between" }}>
              <View style={{ flex: 1 }}>
                <T size="md">#{e.sequence} · {describe(e)}</T>
                <T size="sm" tone="text3">{clock(e.deviceTs)}{e.attempts > 1 ? ` · ${e.attempts} attempts` : ""}{outcome(e) ? ` · ${outcome(e)}` : ""}</T>
                {e.status === "pending" && e.lastError ? <T size="sm" tone="amber">{e.lastError}</T> : null}
              </View>
              <StatusPill tone={e.status === "acked" ? "green" : e.status === "rejected" ? "danger" : "amber"}>{e.status === "acked" ? "Synced" : e.status === "rejected" ? "Rejected" : "Queued"}</StatusPill>
            </Row>
          </View>
        ))}
      </Panel>
    </Screen>
  );
}
