import { router, useLocalSearchParams } from "expo-router";
import * as Speech from "expo-speech";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { IdCheckResult } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { useToast } from "@/components/toast";
import { Btn, Callout, Empty, Field, Input, Loading, Panel, Row, Screen, T } from "@/components/ui";
import { scanners, type ScannedId } from "@/id/scanner";
import { spokenResult, validateId, type LocalIdResult } from "@/id/validator";
import { color, radius, space } from "@/theme";
import { stopAction } from "@/trip/state";
import { useDriverTrips, useRefreshDriver } from "@/trip/useDriverTrips";
import { eventPaths } from "@/api/client";
import { enqueueAndWait } from "@/sync/engine";
import { tripScope } from "@/sync/queue";

/**
 * BUD-101: scan or enter the ID, validate on device for immediate feedback, then submit the `id-check` stop action,
 * which the server enforces (21+, unexpired, accepted type, name match) and which hand-over requires. The result is
 * read aloud. A failed check offers retry or return; there is no override. Only pass/fail, reasons, document type,
 * last 4 and DOB year stay on the device once the server has the result.
 */
type Phase =
  | { k: "scan" }
  | { k: "review"; id: ScannedId; local: LocalIdResult }
  | { k: "result"; ok: boolean; reasons: IdCheckResult["reasons"]; server: "confirmed" | "queued" | "rejected" };

export default function IdCheck() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const { trip, rules, isLoading } = useDriverTrips();
  const { me } = useAuth();
  const refresh = useRefreshDriver();
  const toast = useToast();
  const [adapter, setAdapter] = useState(scanners[0].id);
  const [phase, setPhase] = useState<Phase>({ k: "scan" });
  const [busy, setBusy] = useState(false);
  const [returnReason, setReturnReason] = useState("");

  const stop = trip?.stops.find((s) => s.orderId === orderId);
  useEffect(() => () => void Speech.stop(), []);

  if (isLoading) return <Loading />;
  if (!trip || !stop) return <Screen><Empty title="Stop not found">Go back to your trip.</Empty></Screen>;

  const speak = (r: { ok: boolean; reasons: IdCheckResult["reasons"] }) => Speech.speak(spokenResult(r, stop.recipient), { language: "en-US", rate: 0.95 });

  const onScanned = (id: ScannedId) => {
    const local = validateId({ name: id.name, dob: id.dob, idType: id.idType, expires: id.expires, last4: id.last4 }, stop.recipient, rules);
    setPhase({ k: "review", id, local });
    if (!local.needsNameConfirmation) speak(local);
    else Speech.speak(`Name on the ID is close to ${stop.recipient}. Confirm it is the same person.`, { language: "en-US" });
  };

  const submit = async (id: ScannedId, local: LocalIdResult) => {
    setBusy(true);
    try {
      const e = await enqueueAndWait({
        scope: tripScope(trip.id),
        kind: "stop_action",
        path: eventPaths.stopAction(trip.id, stop.orderId, "id-check"),
        body: { name: id.name, dob: id.dob, idType: id.idType, last4: id.last4, expires: id.expires, nameConfirmed: local.nameMatch === "close" && local.ok, source: id.source },
        meta: { orderId: stop.orderId, action: "id-check", localOk: local.ok, idType: id.idType, last4: id.last4, dobYear: Number(id.dob.slice(0, 4)), agent: me?.id ?? null },
      });
      let result: Phase;
      if (e.status === "acked") {
        const server = (e.response as { idCheck?: IdCheckResult | null } | null)?.idCheck;
        result = { k: "result", ok: server ? server.ok : local.ok, reasons: server ? server.reasons : local.reasons, server: "confirmed" };
      } else if (e.status === "rejected") {
        const body = e.response as { idCheck?: IdCheckResult; message?: string } | null;
        result = { k: "result", ok: false, reasons: body?.idCheck?.reasons ?? [{ code: "SERVER_REJECTED", message: e.lastError ?? "The server rejected the check." }], server: "rejected" };
      } else {
        result = { k: "result", ok: local.ok, reasons: local.reasons, server: "queued" };
      }
      setPhase(result);
      if (result.k === "result") speak(result);
      refresh();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  };

  const doReturn = async (reasons: IdCheckResult["reasons"]) => {
    const reason = returnReason.trim() || `ID check failed: ${reasons.map((r) => r.message).join(" ")}`;
    await stopAction(trip.id, stop.orderId, "return", { reason });
    toast.ok(`${stop.orderNumber} will be returned to the dispensary.`);
    router.back();
  };

  const Adapter = scanners.find((s) => s.id === adapter)!.Component;

  return (
    <Screen>
      <Panel title={`Stop ${stop.seq} · ${stop.orderNumber}`}>
        <T tone="text2">Government photo ID, {rules.minAge}+, not expired, and the name must match <T bold>{stop.recipient}</T>. Nobody else may receive the order.</T>
      </Panel>

      {phase.k === "scan" ? (
        <>
          <Row>
            {scanners.map((s) => (
              <View key={s.id} style={{ flex: 1 }}>
                <Btn size="sm" tone={adapter === s.id ? "purple" : "default"} onPress={() => setAdapter(s.id)}>{s.label}</Btn>
              </View>
            ))}
          </Row>
          <Adapter idTypes={rules.acceptedTypes} recipient={stop.recipient} onResult={onScanned} />
        </>
      ) : null}

      {phase.k === "review" ? (
        <Panel title="Check the details">
          <T size="md">{phase.id.name}</T>
          <T tone="text2">{phase.id.idType.replace(/_/g, " ")} · born {phase.id.dob.slice(0, 4)} · {phase.local.age ?? "?"} years · expires {phase.id.expires ?? "—"}{phase.id.last4 ? ` · …${phase.id.last4}` : ""}</T>
          {phase.local.needsNameConfirmation ? (
            <Callout tone="amber" title="Name is a close match">
              <View style={{ gap: space[2] }}>
                <T tone="text2">The ID says “{phase.id.name}”; the order is for “{stop.recipient}”. Check the photo and confirm this is the same person.</T>
                <Btn tone="primary" busy={busy} onPress={() => { const local = validateId(phase.id, stop.recipient, rules, { nameConfirmed: true }); void submit(phase.id, local); }}>Same person · minor spelling difference</Btn>
                <Btn tone="danger" busy={busy} onPress={() => void submit(phase.id, { ...phase.local, ok: false, needsNameConfirmation: false, nameMatch: "mismatch", reasons: [{ code: "NAME_MISMATCH", message: `Name on ID does not match ${stop.recipient}.` }] })}>Not the same person</Btn>
              </View>
            </Callout>
          ) : (
            <>
              <Callout tone={phase.local.ok ? "green" : "danger"} title={phase.local.ok ? "Checks pass on this device" : "Do not hand over"}>
                {phase.local.ok ? "Submit to record the check. The server confirms it before hand-over." : <View>{phase.local.reasons.map((r) => <T key={r.code} tone="text2">{r.message}</T>)}</View>}
              </Callout>
              <Btn tone="primary" busy={busy} onPress={() => void submit(phase.id, phase.local)}>{phase.local.ok ? "Submit ID check" : "Record failed check"}</Btn>
            </>
          )}
          <Btn onPress={() => setPhase({ k: "scan" })}>Rescan</Btn>
        </Panel>
      ) : null}

      {phase.k === "result" ? (
        <>
          <View accessibilityLiveRegion="assertive" style={{ borderRadius: radius.lg, borderWidth: 1, padding: space[4], gap: space[2], borderColor: phase.ok ? color.greenBorder : color.dangerBorder, backgroundColor: phase.ok ? color.greenSoft : color.dangerSoft }}>
            <T bold size="2xl" tone={phase.ok ? "green" : "danger"}>{phase.ok ? "ID verified" : "Do not hand over"}</T>
            {phase.ok ? <T size="md">Hand over the sealed order to {stop.recipient}.</T> : phase.reasons.map((r) => <T key={r.code} size="md">{r.message}</T>)}
            <T size="sm" tone="text3">
              {phase.server === "confirmed" ? "Confirmed by the server." : phase.server === "queued" ? "Saved offline. The server confirms it when you have signal, and hand-over is checked again there." : "Rejected by the server."}
            </T>
          </View>
          <Btn onPress={() => speak(phase)}>Read result again</Btn>
          {phase.ok ? (
            <Btn tone="green" onPress={() => router.back()}>Continue to hand-over</Btn>
          ) : (
            <Panel title="What next?">
              <Btn tone="primary" onPress={() => setPhase({ k: "scan" })}>Retry with another ID</Btn>
              <Field label="Return reason"><Input value={returnReason} onChangeText={setReturnReason} placeholder="ID did not match · under 21 · expired ID" /></Field>
              <Btn tone="danger" onPress={() => void doReturn(phase.reasons)}>Return this order to the dispensary</Btn>
            </Panel>
          )}
        </>
      ) : null}
    </Screen>
  );
}
