import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { api } from "@/api/client";
import type { PhoneOutcome, TripStop } from "@/api/types";
import { useToast } from "@/components/toast";
import { Btn, Callout, Field, Input, Panel, Row, Select, StatusPill, T } from "@/components/ui";
import { clock, dollarsToCents, money, STOP_TONE, stopLabel } from "@/lib/format";
import { toneColors, radius, space } from "@/theme";
import { stopAction } from "./state";

const OUTCOMES: { value: PhoneOutcome; label: string }[] = [
  { value: "confirmed", label: "Customer confirmed they are home" },
  { value: "no_answer", label: "No answer" },
  { value: "voicemail", label: "Left voicemail" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "declined", label: "Customer declined delivery" },
];

/**
 * One stop: en route → arrived → phone confirmation → ID check → hand-over (cash) or return. Same flow, copy and cash
 * rules as StopCard in apps/admin/src/pages/DriverTrip.tsx; actions go through the offline queue (BUD-124) and the
 * server re-validates each one. `locked` blocks every stop action until a plan amendment is acknowledged (BUD-88).
 */
export function StopCard({ s, tripId, floatCents, locked, onRefresh }: { s: TripStop; tripId: string; floatCents: number; locked: string | null; onRefresh: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<"none" | "phone" | "deliver" | "return">("none");
  const [outcome, setOutcome] = useState<PhoneOutcome>("confirmed");
  const [note, setNote] = useState("");
  const [received, setReceived] = useState((s.totalCents / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [link, setLink] = useState<{ url: string; sentTo: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const paidAtDoor = s.settledMethod === "aeropay_door" || s.payLink?.status === "paid";
  const isCash = s.paymentMethod === "cash" && !paidAtDoor;
  const ready = Boolean(s.phoneConfirmedAt && s.idVerifiedAt);
  const receivedCents = dollarsToCents(received);
  const change = receivedCents - s.totalCents;
  const changeProblem = receivedCents < s.totalCents ? `Short by ${money(s.totalCents - receivedCents)}` : change > floatCents ? `Change ${money(change)} exceeds the ${money(floatCents)} you can make change from` : null;

  const go = async (action: Parameters<typeof stopAction>[2], body: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      await stopAction(tripId, s.orderId, action, body, meta);
      setMode("none");
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const offerLink = useMutation({
    mutationFn: () => api.payLink(tripId, s.orderId),
    onSuccess: (l) => {
      setLink({ url: l.url, sentTo: l.sentTo });
      toast.ok(l.sentTo ? `Link texted to ${l.sentTo}.` : "Link ready; show the customer the URL.");
      onRefresh();
    },
    onError: toast.fail,
  });

  // While a link is pending, poll faster so the paid state reaches the driver within a few seconds.
  useEffect(() => {
    if (s.payLink?.status !== "pending") return;
    const h = setInterval(onRefresh, 4_000);
    return () => clearInterval(h);
  }, [s.payLink?.status, onRefresh]);

  const ok = toneColors.green, idle = toneColors.neutral;
  const off = Boolean(locked) || busy;

  return (
    <Panel title={`Stop ${s.seq} · ${s.orderNumber}`} right={<StatusPill tone={STOP_TONE[s.status]}>{stopLabel(s.status)}</StatusPill>}>
      <T bold size="lg">{s.recipient}</T>
      <T tone="text2" size="md">{s.address.line1}{s.address.line2 ? `, ${s.address.line2}` : ""}, {s.address.city} {s.address.zip}</T>
      {s.address.instructions ? <T size="sm" tone="text3">{s.address.instructions}</T> : null}
      <T size="md" bold tone={paidAtDoor || isCash ? "green" : "text2"}>
        {paidAtDoor ? `Paid by bank at the door · ${money(s.totalCents)} · no cash due` : isCash ? `Collect ${money(s.totalCents)} in cash` : `Paid by bank transfer · ${money(s.totalCents)}`} · {s.windowLabel}
      </T>
      {s.items.map((i, idx) => (
        <Row key={idx} style={{ justifyContent: "space-between" }}>
          <T size="sm">{i.name} × {i.qty}</T>
          <T size="xs" mono tone="text3">…{i.metrcTag?.slice(-8)}</T>
        </Row>
      ))}
      <Row>
        <View style={{ flex: 1, borderWidth: 1, borderRadius: radius.sm, padding: space[2], borderColor: s.phoneConfirmedAt ? ok.border : idle.border, backgroundColor: s.phoneConfirmedAt ? ok.bg : "transparent" }}>
          <T size="sm" tone={s.phoneConfirmedAt ? "green" : "text2"}>☎ {s.phoneConfirmedAt ? `Confirmed ${clock(s.phoneConfirmedAt)}` : `${s.phoneAttempts.length} call attempt(s)`}</T>
        </View>
        <View style={{ flex: 1, borderWidth: 1, borderRadius: radius.sm, padding: space[2], borderColor: s.idVerifiedAt ? ok.border : idle.border, backgroundColor: s.idVerifiedAt ? ok.bg : "transparent" }}>
          <T size="sm" tone={s.idVerifiedAt ? "green" : "text2"}>ID {s.idVerifiedAt ? `verified ${clock(s.idVerifiedAt)}` : s.idChecks.length ? `${s.idChecks.length} failed check(s)` : "not checked"}</T>
        </View>
      </Row>

      {locked ? <Callout tone="danger" title="Stop actions paused">{locked}</Callout> : null}

      {isCash && s.status !== "pending" ? (
        <View style={{ gap: space[2], borderWidth: 1, borderColor: idle.border, borderRadius: radius.md, padding: space[3] }}>
          {s.payLink?.status === "pending" ? (
            <>
              <T bold>Pay by Bank link sent · waiting for the customer</T>
              <T size="sm" tone="text3">Expires {clock(s.payLink.expiresAt)}. {link?.sentTo ? `Texted to ${link.sentTo}.` : ""} Cash is still fine if they prefer.</T>
              {link ? <T size="xs" mono tone="text2">{link.url}</T> : null}
            </>
          ) : (
            <>
              <T tone="text2">Customer would rather not pay cash? Offer Pay by Bank for the exact total; the link is texted to their number on file.</T>
              <Btn tone="purple" size="sm" busy={offerLink.isPending} disabled={off} onPress={() => offerLink.mutate()}>{s.payLink?.status === "expired" || s.payLink?.status === "declined" ? "Send a new Pay by Bank link" : "Offer Pay by Bank"}</Btn>
            </>
          )}
        </View>
      ) : null}

      {mode === "none" ? (
        <View style={{ gap: space[2] }}>
          {s.status === "pending" ? <Btn tone="primary" disabled={off} onPress={() => go("en-route")}>Heading to this stop</Btn> : null}
          {s.status === "en_route" ? <Btn tone="purple" disabled={off} onPress={() => go("arrived")}>I have arrived</Btn> : null}
          {s.status !== "pending" && !s.phoneConfirmedAt ? <Btn disabled={off} onPress={() => setMode("phone")}>Call the customer…</Btn> : null}
          {s.status === "arrived" && !s.idVerifiedAt ? <Btn disabled={off} onPress={() => router.push({ pathname: "/trip/id-check", params: { orderId: s.orderId } })}>Check government ID…</Btn> : null}
          {s.status === "arrived" ? (
            <Btn tone="green" disabled={!ready || off} onPress={() => (isCash ? setMode("deliver") : go("deliver", {}, {}))}>{ready ? "Hand over the order" : "Hand over (call + ID first)"}</Btn>
          ) : null}
          {s.status !== "pending" ? <Btn tone="danger" disabled={off} onPress={() => setMode("return")}>Return to dispensary…</Btn> : null}
        </View>
      ) : null}

      {mode === "phone" ? (
        <View style={{ gap: space[2] }}>
          {s.phone ? <Btn tone="purple" onPress={() => Linking.openURL(`tel:${s.phone}`)}>Call {s.phone}</Btn> : null}
          <Field label="Call outcome"><Select value={outcome} options={OUTCOMES} onChange={setOutcome} /></Field>
          <Field label="Note"><Input value={note} onChangeText={setNote} placeholder="Optional" /></Field>
          <Row>
            <View style={{ flex: 1 }}><Btn tone="primary" disabled={off} onPress={() => go("phone", { outcome, note: note || undefined }, { outcome })}>Log call</Btn></View>
            <View style={{ flex: 1 }}><Btn onPress={() => setMode("none")}>Back</Btn></View>
          </Row>
        </View>
      ) : null}

      {mode === "deliver" ? (
        <View style={{ gap: space[2] }}>
          <Field label="Cash received from the customer ($)" hint={`Order total ${money(s.totalCents)}. You can make change from ${money(floatCents)}.`}>
            <Input keyboardType="decimal-pad" value={received} onChangeText={setReceived} />
          </Field>
          <Callout tone={changeProblem ? "danger" : "green"} title={changeProblem ?? `Change due ${money(Math.max(0, change))}${change === 0 ? " · exact" : ""}`}>
            {changeProblem && change > 0 && receivedCents >= s.totalCents ? "Ask for exact change, offer Pay by Bank, or call dispatch. Never front your own money." : undefined}
          </Callout>
          <Row>
            <View style={{ flex: 1 }}>
              <Btn tone="green" disabled={off || received === "" || Boolean(changeProblem)} onPress={() => go("deliver", { cashReceivedCents: receivedCents }, { cashReceivedCents: receivedCents, changeCents: Math.max(0, change) })}>Confirm hand-over</Btn>
            </View>
            <View style={{ flex: 1 }}><Btn onPress={() => setMode("none")}>Back</Btn></View>
          </Row>
        </View>
      ) : null}

      {mode === "return" ? (
        <View style={{ gap: space[2] }}>
          <Field label="Reason" hint="The order is cancelled, refunded and its packages returned to inventory and Metrc.">
            <Input value={reason} onChangeText={setReason} placeholder="No answer after 3 calls · ID did not match · customer refused" />
          </Field>
          <Row>
            <View style={{ flex: 1 }}><Btn tone="danger" disabled={off || reason.trim().length < 3} onPress={() => go("return", { reason: reason.trim() })}>Return this order</Btn></View>
            <View style={{ flex: 1 }}><Btn onPress={() => setMode("none")}>Back</Btn></View>
          </Row>
        </View>
      ) : null}
    </Panel>
  );
}
