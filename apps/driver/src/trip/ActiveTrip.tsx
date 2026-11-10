import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, Platform, View } from "react-native";
import { api } from "@/api/client";
import type { Trip } from "@/api/types";
import { RouteMap } from "@/components/RouteMap";
import { useToast } from "@/components/toast";
import { Btn, Callout, Field, Input, Panel, Row, StatusPill, T } from "@/components/ui";
import { clock, dollarsToCents, money, plural, STOP_TONE, stopLabel } from "@/lib/format";
import { currentPosition, startTracking, stopTracking } from "@/location/task";
import { navigationUrls } from "@/nav/deeplink";
import { queue, syncNow, tripQueueClear, useSyncStatus } from "@/sync/engine";
import { tripScope } from "@/sync/queue";
import { color, radius, space } from "@/theme";
import { clearTripLocal } from "./state";
import { StopCard } from "./StopCard";

async function openNavigation(lat: number, lng: number, label: string) {
  for (const url of navigationUrls({ lat, lng, label }, Platform.OS === "ios" ? "ios" : "android")) {
    try {
      await Linking.openURL(url);
      return;
    } catch {
      /* try the next app */
    }
  }
}

/** Departed trip (mirrors ActiveTrip in apps/admin/src/pages/DriverTrip.tsx, plus navigation, trace and sync gating). */
export function ActiveTrip({ trip, onRefresh, fromCache }: { trip: Trip; onRefresh: () => void; fromCache: boolean }) {
  const toast = useToast();
  const sync = useSyncStatus();
  const open = trip.stops.filter((s) => !["delivered", "returned", "cancelled"].includes(s.status));
  const active = open.find((s) => s.status !== "pending") ?? open[0] ?? null;
  const drawer = trip.floatAvailableCents;
  const [returned, setReturned] = useState<string | null>(null);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const [queueState, setQueueState] = useState<{ clear: boolean; pending: number }>({ clear: false, pending: 0 });

  // Resume the background trace if the app was killed mid-trip.
  useEffect(() => {
    if (trip.status === "departed") void startTracking(trip);
    void currentPosition().then(setMe);
  }, [trip.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void tripQueueClear(trip.id).then(setQueueState);
  }, [trip.id, sync]);

  const planPending = trip.planAcknowledgedVersion < trip.planVersion;
  const ack = useMutation({
    mutationFn: () => api.ackPlan(trip.id, trip.planVersion),
    onSuccess: () => {
      toast.ok("Plan acknowledged.");
      onRefresh();
    },
    onError: toast.fail,
  });

  const complete = useMutation({
    mutationFn: async () => {
      await syncNow();
      const q = await tripQueueClear(trip.id);
      if (!q.clear) throw new Error(`${q.pending} event${q.pending === 1 ? " is" : "s are"} still waiting to upload. The trip can close once everything is synced.`);
      const t = await api.complete(trip.id, dollarsToCents(returned ?? (drawer / 100).toFixed(2)));
      await stopTracking();
      await queue.purge(tripScope(trip.id));
      await clearTripLocal();
      return t;
    },
    onSuccess: () => {
      toast.ok(`${trip.number} closed.`);
      onRefresh();
    },
    onError: toast.fail,
  });

  const lockedReason = planPending ? `Dispatch changed your plan (version ${trip.planVersion}). Acknowledge it above before the next stop action.` : null;
  const nextLat = active?.address.lat, nextLng = active?.address.lng;
  const returnLeg = !active && trip.dispensary;

  return (
    <View style={{ gap: space[4] }}>
      {planPending ? (
        <Callout tone="danger" title={`Dispatch changed your plan (version ${trip.planVersion})`}>
          <View style={{ gap: space[2] }}>
            <T tone="text2">The stop order below is the new plan{trip.returnToStore ? "; return to the dispensary after the remaining stops" : ""}. Read it, then acknowledge.</T>
            <Btn tone="danger" busy={ack.isPending} onPress={() => ack.mutate()}>Acknowledge plan v{trip.planVersion}</Btn>
          </View>
        </Callout>
      ) : null}

      <Callout tone="green" title={`${trip.number} · manifest locked at ${clock(trip.manifestLockedAt)}`}>
        {`${trip.vehicle.label} · ${open.length} of ${plural(trip.stops.length, "stop")} remaining · cash on hand ${money(drawer)}${trip.manualManifest ? ` · manual manifest ${trip.manualManifest.reference}` : ""}`}
      </Callout>

      {active ? (
        <>
          <RouteMap trip={trip} nextOnly next={active} me={me} />
          {nextLat != null && nextLng != null ? (
            <Btn tone="purple" disabled={planPending} onPress={() => openNavigation(nextLat, nextLng, `${active.orderNumber} ${active.address.line1}`)}>
              Navigate to stop {active.seq}{active.eta ? ` · ETA ${clock(active.eta)}` : ""}
            </Btn>
          ) : null}
          <StopCard key={active.orderId} s={active} tripId={trip.id} floatCents={drawer} locked={lockedReason} onRefresh={onRefresh} />
        </>
      ) : (
        <Panel title="All stops settled">
          <T tone="text2">Return to the dispensary and hand back the cash. The drawer should hold <T bold>{money(drawer)}</T> (float {money(trip.floatIssuedCents)} plus cash kept, minus change given).</T>
          {returnLeg ? <Btn tone="purple" onPress={() => openNavigation(trip.dispensary!.lat, trip.dispensary!.lng, trip.dispensary!.name)}>Navigate to {trip.dispensary!.name}</Btn> : null}
          <Field label="Cash handed back ($)">
            <Input keyboardType="decimal-pad" value={returned ?? (drawer / 100).toFixed(2)} onChangeText={setReturned} />
          </Field>
          {!queueState.clear ? <Callout tone="amber" title={`${plural(queueState.pending, "event")} still syncing`}>The trip closes once every event has reached the server. Keep the app open with signal.</Callout> : null}
          {fromCache ? <T size="sm" tone="amber">You are offline. Closing the trip needs a connection.</T> : null}
          <Btn tone="green" busy={complete.isPending} disabled={!queueState.clear || fromCache} onPress={() => complete.mutate()}>Complete trip</Btn>
        </Panel>
      )}

      <Row>
        <View style={{ flex: 1 }}><Btn onPress={() => router.push("/trip/fuel-stop")}>Log a fuel stop</Btn></View>
        <View style={{ flex: 1 }}><Btn onPress={() => router.push("/sync")}>{sync.pending ? `${sync.pending} queued` : "Sync log"}</Btn></View>
      </Row>

      <Panel title="Stops">
        {trip.stops.map((s) => (
          <View key={s.orderId} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space[2], borderWidth: 1, borderRadius: radius.sm, padding: space[2], borderColor: active?.orderId === s.orderId ? color.purple : color.border }}>
            <T size="sm" style={{ flex: 1 }}>
              <T bold size="sm">{s.seq}. {s.orderNumber}</T> · {s.recipient} · {s.address.line1}
            </T>
            <StatusPill tone={STOP_TONE[s.status]}>{stopLabel(s.status)}</StatusPill>
          </View>
        ))}
        <T size="sm" tone="text3">Stops run in the order dispatch set. To change the order or skip a stop, call dispatch.</T>
      </Panel>
    </View>
  );
}
