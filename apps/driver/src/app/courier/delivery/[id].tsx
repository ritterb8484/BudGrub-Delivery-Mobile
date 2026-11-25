import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Linking, Platform, ScrollView, Switch, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import { loadCourierDelivery } from "@/courier/cache";
import { queuedCourierProgress } from "@/courier/progress";
import { ApiError } from "@/api/client";
import { navigationUrls } from "@/nav/deeplink";
import { discardTemporaryPhoto } from "@/trip/photo";
import { recordDeliveryStep } from "@/courier/actions";
import { markReviewed, queue, useSyncStatus } from "@/sync/engine";
import { courierScope } from "@/sync/queue";
import { currentPosition } from "@/location/task";
import { useAuth } from "@/auth/AuthProvider";
import { Button, Callout, Card, Divider, KeyValue, Pill, Row, Screen, Text } from "@/courier/ui";
import { canLeaveAtDoor, money, normalizeCode } from "@/courier/format";
import { announce } from "@/courier/announce";
import { TOUCH, radius, color as theme } from "@/theme";

/**
 * One delivery, step by step (BUD-134, 141): navigate to the kitchen, pickup by code (typed or scanned), navigate to
 * the customer, deliver with a photo (leave at door only when allowed), fail with a reason, flag an issue, contact.
 * Every step is queued locally first and uploaded with its Idempotency-Key (storage.ts).
 */
export default function DeliveryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useAuth();
  const router = useRouter();
  const query = useQuery({ queryKey: ["courier-delivery", me?.id, id], queryFn: () => loadCourierDelivery(me!.id, id), enabled: Boolean(me && id), refetchInterval: 15_000 });
  const { data: snapshot, refetch } = query;
  const serverDelivery = query.error instanceof ApiError && [403, 404].includes(query.error.status) ? undefined : snapshot?.data;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [camPerm, requestCam] = useCameraPermissions();
  const [note, setNote] = useState("");
  const [leave, setLeave] = useState(false);
  const [photo, setPhoto] = useState<{ mime: "image/jpeg" | "image/png"; dataBase64: string } | null>(null);
  const [failReason, setFailReason] = useState("");
  const [override, setOverride] = useState("");
  const sync = useSyncStatus();
  const scope = me ? courierScope(me.id, id) : null;
  const refusal = sync.rejected.find((event) => event.scope === scope);
  const [pendingActions, setPendingActions] = useState<string[]>([]);
  const pending = pendingActions.some(action => action !== "en-route" && action !== "arrive");
  const d = serverDelivery && { ...serverDelivery, status: queuedCourierProgress(serverDelivery.status, pendingActions) };
  const lastSyncAt = sync.lastSyncAt;
  useEffect(() => { if (lastSyncAt) void refetch(); }, [lastSyncAt, refetch]);
  useEffect(() => {
    let mounted = true;
    if (scope) void queue.pending(scope).then((events) => {
      if (mounted) setPendingActions(events.map(event => String(event.meta.action ?? "")));
    });
    return () => { mounted = false; };
  }, [scope, sync.pending, sync.lastSyncAt]);
  useEffect(() => {
    if (refusal?.lastError) void announce(refusal.lastError);
  }, [refusal?.lastError]);

  const step = async (label: string, path: string, body: Record<string, unknown> = {}) => {
    if (!d || !me) return;
    setBusy(label); setError(null);
    try {
      const result = await recordDeliveryStep(me.id, d.id, path, body, sync.online === false || Boolean(snapshot?.cached));
      if (result === "pending") setPendingActions(await queue.pending(courierScope(me.id, d.id)).then(events => events.map(event => String(event.meta.action ?? ""))));
      else await refetch();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const navigate = async (address: string, point?: { label: string; lat: number | null; lng: number | null }) => {
    const urls = point?.lat != null && point.lng != null
      ? navigationUrls({ label: point.label, lat: point.lat, lng: point.lng }, Platform.OS === "ios" ? "ios" : "android")
      : [`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`];
    for (const url of urls) {
      try { await Linking.openURL(url); return; } catch { /* try the next maps provider */ }
    }
    setError("Could not open directions. Use the address shown here.");
  };
  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setError("Camera permission is needed for the proof photo."); return; }
    const r = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.5, mediaTypes: ["images"] });
    const asset = r.canceled ? null : r.assets[0];
    if (asset?.base64) {
      setPhoto({ mime: asset.mimeType === "image/png" ? "image/png" : "image/jpeg", dataBase64: asset.base64 });
      discardTemporaryPhoto(asset.uri);
    }
  };

  if (!d) return <Screen>{query.error ? <Callout tone="danger" title="Could not load">{query.error.message}</Callout> : <Text tone="text3">Loading…</Text>}</Screen>;
  const address = [d.customer.address.line1, d.customer.address.line2, d.customer.address.city, d.customer.address.zip].filter(Boolean).join(", ");
  const kitchensLeft = d.kitchens.filter((k) => !["picked_up", "cancelled", "rejected"].includes(k.status));
  const staging = d.staging && !d.staging.released ? d.staging : null;
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <Row><Pill tone="blue">{d.status.replace("_", " ")}</Pill><Pill>{d.orderNumber}</Pill>{d.rating ? <Pill tone="green">{d.rating}★</Pill> : null}</Row>
        {error ? <Callout tone="danger" title="Not accepted">{error}</Callout> : null}
        {snapshot?.cached && <Callout tone="amber" title="Saved delivery">The address and pickup directions are available offline. A saved step takes effect when the server confirms it.</Callout>}
        {pendingActions.length > 0 && <Callout tone="amber" title="Delivery steps saved on this phone">The app will upload them in order when your connection returns.</Callout>}
        {refusal ? (
          <Callout tone="danger" title="A step you took earlier was not accepted">
            {refusal.lastError ?? "Review the delivery and retry the step."}
            <Button title="Dismiss" tone="neutral" hint="Hides this message" onPress={() => void markReviewed(refusal)} />
          </Callout>
        ) : null}

        <Card>
          <Text kind="h2">Order</Text>
          {d.items.map((i) => <KeyValue key={i.id} k={`${i.qty} × ${i.name}${i.vendor ? ` · ${i.vendor}` : ""}`} v={i.allergens.length ? `allergens: ${i.allergens.join(", ")}` : i.perishable ? "keep cold" : ""} />)}
          {d.customer.note ? <><Divider /><Text kind="small" tone="text2">Customer note: {d.customer.note}</Text></> : null}
          {d.customer.address.instructions ? <Text kind="small" tone="text2">Address instructions: {d.customer.address.instructions}</Text> : null}
          <KeyValue k="Payout" v={`${money(d.payoutCents)}${d.tipCents ? ` + ${money(d.tipCents)} tip` : ""}`} />
          {d.pairing ? <Text kind="small" tone="text2">Paired with cannabis order {d.pairing.cannabisOrderNumber}; aim to arrive within {d.pairing.windowMinutes} min of it.</Text> : null}
        </Card>

        {(d.status === "accepted" || d.status === "at_vendor") && (
          <Card lane="food">
            <Text kind="h2">1 · Pick up at {kitchensLeft.map((k) => k.vendor.name).join(" and ")}</Text>
            {kitchensLeft.map(k => <Card key={k.ticketId}>
              <Text kind="title">{k.pickup?.label ?? k.vendor.name}{k.vendor.kind === "convenience" ? " · convenience" : ""}</Text>
              {k.pickup ? <>
                <Text>{k.pickup.address}</Text>
                <Text tone="text2">{k.pickup.instructions}</Text>
                <Button title="Navigate to pickup" tone="neutral" onPress={() => navigate(k.pickup!.address, k.pickup!)} />
              </> : <Text tone="text2">Exact pickup directions are unavailable. Contact dispatch for this location.</Text>}
            </Card>)}
            {kitchensLeft.map((k) => <KeyValue key={k.ticketId} k={k.vendor.name} v={k.held ? "held for the cannabis trip" : k.status === "ready" ? "ready" : `preparing${k.prepEtaMinutes ? ` · ~${k.prepEtaMinutes} min` : ""}`} />)}
            <Row>
              {d.status === "accepted" && <Button title="I'm at the kitchen" disabled={pending || Boolean(busy)} busy={busy === "arrive-vendor"} onPress={() => step("arrive-vendor", "arrive-vendor")} />}
            </Row>
            <Text kind="title">Pickup code from the kitchen</Text>
            <Row>
              <TextInput accessibilityLabel="Pickup code" accessibilityHint="Four digits shown by the kitchen" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} placeholder="0000" placeholderTextColor={theme.text3}
                style={{ flex: 1, minHeight: TOUCH, borderWidth: 1, borderColor: theme.border, borderRadius: radius.sm, color: theme.text, paddingHorizontal: 12, fontSize: 22, letterSpacing: 6, backgroundColor: theme.surface }} />
              <Button title="Scan" tone="neutral" onPress={async () => { if (!camPerm?.granted) await requestCam(); setScanning(true); }} />
            </Row>
            {scanning && camPerm?.granted && (
              <View style={{ height: 220, borderRadius: radius.md, overflow: "hidden" }} accessible accessibilityLabel="Camera viewfinder, point at the kitchen's code">
                <CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ["qr", "code128"] }} onBarcodeScanned={(b) => { const c = normalizeCode(b.data); if (c) { setCode(c); setScanning(false); announce(`Code ${c.split("").join(" ")} scanned`); } }} />
              </View>
            )}
            <Button title="Confirm pickup" tone="green" busy={busy === "pickup"} disabled={pending || Boolean(busy) || !normalizeCode(code)} hint="The code is checked by the server against the kitchen's ticket" onPress={() => step("pickup", "pickup", { code: normalizeCode(code) })} />
          </Card>
        )}

        {d.status === "picked_up" && (
          <Card lane="food">
            <Text kind="h2">2 · Head to {d.customer.firstName}</Text>
            <Text tone="text2">{address}</Text>
            <Row><Button title="Navigate" tone="neutral" onPress={() => navigate(address)} /><Button title="On my way" disabled={pending || Boolean(busy)} busy={busy === "en-route"} onPress={() => step("en-route", "en-route")} /></Row>
          </Card>
        )}

        {staging && ["picked_up", "en_route", "arrived"].includes(d.status) && <Callout tone="amber" title="Wait at the staging point">
          <Text>{staging.reason || "Wait for dispatch to release this paired delivery."}</Text>
          {staging.lat != null && staging.lng != null && <Button title="Navigate to staging" onPress={() => navigate("", { label: "Staging point", lat: staging.lat, lng: staging.lng })} />}
          {!staging.stagedAt && <Button title="At the staging point" disabled={pending || Boolean(busy) || snapshot?.cached} onPress={async () => {
            const point = await currentPosition();
            if (point) await step("staged", "staged", point);
            else setError("Location is required to check in at staging.");
          }} />}
          <TextInput accessibilityLabel="Reason for delivering before release" value={override} onChangeText={setOverride} placeholder="Reason for delivering before release" placeholderTextColor={theme.text3} style={{ color: theme.text, minHeight: TOUCH }} />
        </Callout>}

        {(d.status === "en_route" || d.status === "arrived") && (
          <Card lane="food">
            <Text kind="h2">3 · Deliver to {d.customer.firstName}</Text>
            <Text tone="text2">{address}</Text>
            <Row><Button title="Navigate" tone="neutral" onPress={() => navigate(address)} />{d.status === "en_route" && <Button title="I've arrived" disabled={pending || Boolean(busy)} busy={busy === "arrive"} onPress={() => step("arrive", "arrive")} />}</Row>
            <Divider />
            <Text kind="title">Proof of delivery (required)</Text>
            <Row><Button title={photo ? "Retake photo" : "Take photo"} tone="neutral" onPress={takePhoto} />{photo ? <Pill tone="green">Photo attached</Pill> : null}</Row>
            <Row>
              <Switch accessibilityLabel="Leave at the door" value={leave} disabled={!canLeaveAtDoor(d)} onValueChange={setLeave} />
              <Text tone={canLeaveAtDoor(d) ? "text" : "text3"} style={{ flex: 1 }}>{canLeaveAtDoor(d) ? "Leave at the door (customer allowed it)" : "Hand over in person: the customer did not allow leaving it at the door"}</Text>
            </Row>
            <TextInput accessibilityLabel="Drop-off note" value={note} onChangeText={setNote} placeholder="Where you left it, who took it" placeholderTextColor={theme.text3} style={{ minHeight: TOUCH, borderWidth: 1, borderColor: theme.border, borderRadius: radius.sm, color: theme.text, paddingHorizontal: 12, backgroundColor: theme.surface }} />
            <Button title="Mark delivered" tone="green" busy={busy === "deliver"} disabled={pending || Boolean(busy) || !photo || Boolean(staging && override.trim().length < 5)} hint="Sends the photo, your position and the time" onPress={async () => { const pos = await currentPosition(); await step("deliver", "deliver", { photo, note: note || null, leaveAtDoor: leave, lat: pos?.lat ?? null, lng: pos?.lng ?? null, ...(staging ? { overrideReason: override.trim() } : {}) }); }} />
          </Card>
        )}

        {["accepted", "at_vendor", "picked_up", "en_route", "arrived"].includes(d.status) && (
          <Card>
            <Text kind="title">Problems</Text>
            <Row>
              <Button title="Call or text customer" tone="neutral" onPress={() => router.push(`/courier/contact/${d.orderId}`)} />
              <Button title="Missing items" tone="neutral" disabled={pending || Boolean(busy)} busy={busy === "issue-missing"} onPress={() => step("issue-missing", "issue", { kind: "missing_items" })} />
              <Button title="Wrong order" tone="neutral" disabled={pending || Boolean(busy)} busy={busy === "issue-wrong"} onPress={() => step("issue-wrong", "issue", { kind: "wrong_order" })} />
            </Row>
            <TextInput accessibilityLabel="Reason the delivery cannot be completed" value={failReason} onChangeText={setFailReason} placeholder="Why the delivery cannot be completed" placeholderTextColor={theme.text3} style={{ minHeight: TOUCH, borderWidth: 1, borderColor: theme.border, borderRadius: radius.sm, color: theme.text, paddingHorizontal: 12, backgroundColor: theme.surface }} />
            <Button title="Cannot deliver" tone="danger" busy={busy === "fail"} disabled={pending || Boolean(busy) || failReason.trim().length < 3} hint="Cancels and refunds the order" onPress={() => step("fail", "fail", { reason: failReason.trim() })} />
          </Card>
        )}

        {(d.status === "delivered" || d.status === "failed" || d.status === "cancelled") && (
          <Card>
            <Text kind="h2">{d.status === "delivered" ? "Delivered" : "Not delivered"}</Text>
            {d.proof ? <KeyValue k="Proof" v={`${d.proof.leftAtDoor ? "left at door" : "handed over"}${d.proof.note ? ` · ${d.proof.note}` : ""}`} /> : null}
            {d.failReason ? <KeyValue k="Reason" v={d.failReason} /> : null}
            <KeyValue k="Earned" v={`${money(d.payoutCents)}${d.tipCents ? ` + ${money(d.tipCents)} tip` : ""}`} />
            {d.issues.map((i) => <KeyValue key={i.id} k="Issue flagged" v={i.kind.replace("_", " ")} />)}
            <Button title="Back to courier home" tone="neutral" onPress={() => router.replace("/courier")} />
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}
