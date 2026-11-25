import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppState, Linking, RefreshControl, ScrollView } from "react-native";
import { Stack, useRouter } from "expo-router";
import * as Notifications from "expo-notifications";
import { api } from "@/courier/api";
import type { CourierDelivery } from "@/courier/types";
import { Button, Callout, Card, KeyValue, Pill, Row, Screen, Text } from "@/courier/ui";
import { money, secondsLeft } from "@/courier/format";
import { announce } from "@/courier/announce";
import { useAuth } from "@/auth/AuthProvider";
import { recordDeliveryStep } from "@/courier/actions";
import { markReviewed, useSyncStatus } from "@/sync/engine";
import { loadCourierHome } from "@/courier/cache";
import { FOOD_DISPATCH_PHONE } from "@/config";
import { currentPosition } from "@/location/task";
import { courierScope } from "@/sync/queue";

/** Courier home (BUD-134, 145): shift, the live delivery, open offers with a countdown, recent history, earnings shortcuts. */
export default function CourierHomeScreen() {
  const router = useRouter();
  const { me, refresh, offline } = useAuth();
  const query = useQuery({ queryKey: ["courier-home", me?.id], queryFn: () => loadCourierHome(me!.id), enabled: Boolean(me), refetchInterval: 10_000 });
  const { data: snapshot, refetch } = query;
  const home = snapshot?.data;
  const cached = Boolean(snapshot?.cached) || offline || query.isError;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const sync = useSyncStatus();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // A push for an offer or a message refreshes the screen at once.
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => void refetch());
    return () => sub.remove();
  }, [refetch]);
  const syncTime = sync.lastSyncAt;
  useEffect(() => { if (syncTime) void refetch(); }, [refetch, syncTime]);
  const firstOffer = cached ? undefined : home?.offers[0];
  const offerAnnouncement = firstOffer ? `New delivery offer from ${firstOffer.kitchens[0]?.vendor.name ?? "a kitchen"}, ${money(firstOffer.payoutCents)}.` : null;
  useEffect(() => { if (offerAnnouncement) void announce(offerAnnouncement); }, [firstOffer?.id, offerAnnouncement]);

  const live = Boolean(home?.current || home?.activeDeliveries?.length);
  useEffect(() => {
    if (!live || cached) return;
    let active = true;
    const report = async () => {
      if (AppState.currentState !== "active") return;
      const point = await currentPosition();
      if (active && point) await api.reportLocation(point).catch(() => undefined);
    };
    void report();
    const timer = setInterval(() => void report(), 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [live, cached]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try { await fn(); await refetch(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const header = <Stack.Screen options={{ headerRight: () => <Button title="Account" tone="neutral" onPress={() => router.push("/account")} /> }} />;
  if (!home || !me) return <Screen>{header}{query.error ? <Callout tone="danger" title="Could not load">{query.error.message}</Callout> : <Text tone="text3">Loading…</Text>}</Screen>;
  const p = home.profile;
  const deliveries = home.activeDeliveries ?? (home.current ? [home.current] : []);
  const foodShift = home.shift?.mode === "food";
  const refusedOffer = sync.rejected.find((event) =>
    event.scope.startsWith(courierScope(me.id, "")) && (event.meta.action === "accept" || event.meta.action === "decline"));
  return (
    <Screen>
      {header}
      <ScrollView contentContainerStyle={{ gap: 16 }} refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void refetch()} />}>
        <Row>
          <Pill tone={p.status === "active" ? "green" : p.status === "pending" ? "blue" : "danger"}>{p.status}</Pill>
          {foodShift && home.shift ? <Pill tone="blue">On shift since {new Date(home.shift.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Pill> : <Pill>Off shift</Pill>}
          {home.rating.count ? <Pill>{home.rating.average?.toFixed(1)}★ · {home.rating.count}</Pill> : null}
        </Row>
        {cached && <Callout tone="amber" title="Working from saved stops">You can open active deliveries. Accepting offers and starting or ending a shift require a connection.</Callout>}
        {FOOD_DISPATCH_PHONE && <Button title="Call food dispatch" tone="neutral" onPress={() => void Linking.openURL(`tel:${FOOD_DISPATCH_PHONE}`).catch(() => setError("Could not open the phone app."))} />}
        {error || query.error ? <Callout tone="danger" title="Could not update">{error ?? query.error?.message}</Callout> : null}
        {sync.pending > 0 && <Callout tone="amber" title="Delivery steps waiting to sync">Keep the app connected to upload them before ending the shift.</Callout>}
        {refusedOffer && <Callout tone="danger" title="Offer response refused">
          <Text>{refusedOffer.lastError ?? "Refresh to see current offers."}</Text>
          <Button title="Dismiss" tone="neutral" onPress={() => void markReviewed(refusedOffer)} />
        </Callout>}
        {p.status !== "active" && <Callout tone={p.status === "inactive" ? "danger" : "neutral"} title={p.status === "inactive" ? "Account inactive" : "Account pending review"}>{p.status === "inactive" ? p.deactivatedReason ?? "Contact company operations." : `Before you can go on shift: ${p.problems.join("; ")}.`}</Callout>}
        {p.status === "active" && !home.shift && <Button title="Start food shift" tone="green" disabled={cached || Boolean(busy)} busy={busy === "shift"} hint="You start receiving delivery offers" onPress={() => act("shift", async () => { await api.startShift("food"); await refresh(); })} />}
        {deliveries.length > 0 && <Text kind="h2">Active batch · {deliveries.length}{home.batchLimit ? ` of ${home.batchLimit}` : ""}</Text>}
        {deliveries.map((d) => <DeliveryCard key={d.id} d={d} onOpen={() => router.push(`/courier/delivery/${d.id}`)} />)}
        {!cached && home.offers.map((o) => (
          <Card key={o.id} lane="food">
            <Row><Text kind="eyebrow" tone="blue">New offer</Text><Text kind="eyebrow" tone="danger">{secondsLeft(o.offer?.expiresAt, now)} s left</Text></Row>
            <Text kind="h2">{o.kitchens.map((k) => k.vendor.name).join(" + ")}</Text>
            <KeyValue k="Pickup window" v={o.windowLabel ?? "ASAP"} />
            <KeyValue k="Deliver to" v={`${o.customer.address.city ?? ""} ${o.customer.address.zip ?? ""}`.trim() || "—"} />
            <KeyValue k="Distance" v={o.distanceKm ? `${o.distanceKm.toFixed(1)} km` : "—"} />
            <KeyValue k="Payout" v={`${money(o.payoutCents)}${o.tipCents ? ` + ${money(o.tipCents)} tip` : ""}`} />
            {o.pairing ? <Text kind="small" tone="text2">Paired with cannabis order {o.pairing.cannabisOrderNumber}: both arrive within {o.pairing.windowMinutes} min. Food never rides in the cannabis vehicle.</Text> : null}
            <Row>
              <Button title="Accept" tone="green" disabled={Boolean(busy) || sync.pending > 0 || !secondsLeft(o.offer?.expiresAt, now)} busy={busy === `accept-${o.id}`} style={{ flex: 1 }} onPress={() => act(`accept-${o.id}`, () => recordDeliveryStep(me.id, o.id, "accept"))} />
              <Button title="Decline" tone="neutral" disabled={Boolean(busy) || sync.pending > 0} busy={busy === `decline-${o.id}`} onPress={() => act(`decline-${o.id}`, () => recordDeliveryStep(me.id, o.id, "decline", { reason: "Declined in app" }))} />
            </Row>
          </Card>
        ))}
        {foodShift && !deliveries.length && !home.offers.length && <Card><Text kind="title">Waiting for offers</Text><Text tone="text2">Offers arrive as a push and appear here with a {home.offerTtlSeconds}-second countdown. Keep location on while you wait.</Text></Card>}
        <Row>
          <Button title="Earnings" tone="neutral" onPress={() => router.push("/courier/earnings")} />
          <Button title="Shifts" tone="neutral" onPress={() => router.push("/courier/shifts")} />
          <Button title="Documents" tone="neutral" onPress={() => router.push("/courier/documents")} />
        </Row>
        {foodShift && <Button title="End food shift" tone="neutral" busy={busy === "end"} hint="Finish all deliveries and sync their steps first" disabled={cached || deliveries.length > 0 || sync.pending > 0 || Boolean(busy)} onPress={() => act("end", async () => { await api.endShift(); await refresh(); })} />}
        {home.recent.length > 0 && <Card><Text kind="title">Recent</Text>{home.recent.slice(0, 8).map((d) => <KeyValue key={d.id} k={`${d.orderNumber} · ${d.status}`} v={money(d.payoutCents + d.tipCents)} />)}</Card>}
      </ScrollView>
    </Screen>
  );
}

function DeliveryCard({ d, onOpen }: { d: CourierDelivery; onOpen: () => void }) {
  return (
    <Card lane="food">
      <Text kind="eyebrow" tone="blue">Current delivery · {d.status.replace("_", " ")}</Text>
      <Text kind="h2">{d.orderNumber}</Text>
      <KeyValue k="Kitchen" v={d.kitchens.map((k) => `${k.vendor.name} (${k.status})`).join(", ")} />
      <KeyValue k="Customer" v={d.customer.firstName} />
      <Button title="Open delivery" onPress={onOpen} />
    </Card>
  );
}
