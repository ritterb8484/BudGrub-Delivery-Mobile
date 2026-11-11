import { useMutation } from "@tanstack/react-query";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { AppState, Image, View } from "react-native";
import { api } from "@/api/client";
import type { ChecklistItem, Trip } from "@/api/types";
import { RouteMap } from "@/components/RouteMap";
import { useToast } from "@/components/toast";
import { Btn, Callout, CheckRow, Divider, Field, Input, Panel, Row, Select, StatusPill, T } from "@/components/ui";
import { clock, money, parseCents, plural } from "@/lib/format";
import { manifestLines, summarise } from "@/load/manifest";
import { permissionSnapshot } from "@/location/permissions";
import { startTracking } from "@/location/task";
import { color, radius, space } from "@/theme";
import { takeEvidencePhoto } from "./photo";
import { accept, clearTripLocal, manifestChanged, submitLoad, useTripLocal } from "./state";

const DECLINE_REASONS = [
  { value: "vehicle", label: "Vehicle problem" },
  { value: "hours", label: "Outside my shift hours" },
  { value: "safety", label: "Safety concern on this route" },
  { value: "other", label: "Other" },
] as const;

/**
 * Planned trip: offer review → accept or decline (BUD-77) → load scan and sealed-load attestation (BUD-83) → shift
 * checklist → depart. Mirrors PlannedTrip in apps/admin/src/pages/DriverTrip.tsx and adds the native-only steps.
 *
 * The API locks the manifest at departure, so an offered trip normally has no lock yet. What the agent accepted and
 * scanned is tied to the plan version instead: an amended plan asks for a new review and a new scan.
 */
export function TripOffer({ trip, checklist, degraded, onRefresh }: { trip: Trip; checklist: ChecklistItem[]; degraded: boolean; onRefresh: () => void }) {
  const toast = useToast();
  const local = useTripLocal(trip);
  const lines = useMemo(() => manifestLines(trip), [trip]);
  const load = local.session ? summarise(local.session, lines) : null;
  const overCap = trip.capFlowerEquivG != null && trip.flowerEquivG > trip.capFlowerEquivG;
  const overValue = trip.capValueCents != null && trip.valueCents != null && trip.valueCents > trip.capValueCents;
  const locked = Boolean(trip.manifestLockedAt);
  const changed = manifestChanged(local.acceptance, trip);
  const accepted = Boolean(local.acceptance) && !changed;

  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState<(typeof DECLINE_REASONS)[number]["value"]>("vehicle");
  const [declineNote, setDeclineNote] = useState("");
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [float, setFloat] = useState("");
  const [att, setAtt] = useState({ sealed: false, notVisible: false, lockbox: false });
  const [photo, setPhoto] = useState<{ mime: string; dataBase64: string; previewUri: string } | null>(null);
  const [alwaysLocation, setAlwaysLocation] = useState<boolean | null>(null);

  // Re-read on every return to this screen or to the app: the permission is fixed on another screen or in Settings.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      const read = () => void permissionSnapshot().then((p) => live && setAlwaysLocation(p.background));
      read();
      const sub = AppState.addEventListener("change", (st) => {
        if (st === "active") read();
      });
      return () => {
        live = false;
        sub.remove();
      };
    }, []),
  );

  const cashTrip = trip.cashExpectedCents > 0;
  const floatCents = float.trim() === "" ? 0 : parseCents(float);

  const decline = useMutation({
    mutationFn: () => api.decline(trip.id, declineReason === "other" ? declineNote.trim() : `${DECLINE_REASONS.find((r) => r.value === declineReason)!.label}${declineNote.trim() ? `: ${declineNote.trim()}` : ""}`),
    onSuccess: async () => {
      await clearTripLocal();
      toast.ok(`${trip.number} declined. It is back in the dispatch pool.`);
      onRefresh();
    },
    onError: toast.fail,
  });

  const attest = useMutation({
    mutationFn: async () => {
      if (!local.session) throw new Error("Scan the load first.");
      const e = await submitLoad(trip, local.session, att, photo ? { mime: photo.mime, dataBase64: photo.dataBase64 } : null);
      await local.reload();
      return e;
    },
    onSuccess: (e) => {
      if (e.status === "acked") toast.ok("Load attestation confirmed by the server.");
      else if (e.status === "rejected") toast.fail(new Error(e.lastError ?? "The server rejected the load."));
      else toast.ok("Attestation saved. It uploads when you have signal; departure waits for it.");
      setPhoto(null);
      onRefresh();
    },
    onError: toast.fail,
  });

  const depart = useMutation({
    mutationFn: async () => {
      if (floatCents === null) throw new Error("Enter the float as an amount, for example 40.00.");
      const t = await api.depart(trip.id, answers, cashTrip ? floatCents : 0);
      // The trip has departed on the server whatever happens next; the trip screen retries and warns if the trace
      // cannot start, so a tracking error must not be reported as a failed departure.
      await startTracking({ ...trip, ...t }).catch(() => false);
      return t;
    },
    onSuccess: () => {
      toast.ok("Manifest locked. Drive safely.");
      onRefresh();
    },
    onError: toast.fail,
  });

  const loadRejected = local.loadEvent?.status === "rejected";
  // Server confirmation: our queued load event was acknowledged, or the refetched trip carries the attestation
  // (the server clears it when the manifest is re-issued).
  const loadConfirmed = !loadRejected && (local.loadEvent?.status === "acked" || Boolean(trip.load?.attestedAt));
  const checklistDone = checklist.every((c) => answers[c.key]);
  const photoNeeded = Boolean(trip.loadPhotoRequired);

  const blockers = [
    load && !load.complete && load.blockedReason,
    !load && "Scan every package on the manifest.",
    !loadConfirmed && (local.attestation ? "Waiting for the server to confirm the load attestation." : "Attest the sealed load."),
    !checklistDone && "Complete the shift-start checklist.",
    cashTrip && floatCents === null && "Enter the float as an amount, for example 40.00.",
    alwaysLocation === false && "Allow \"Always\" location to start a cannabis shift.",
  ].filter(Boolean) as string[];

  return (
    <View style={{ gap: space[4] }}>
      <Panel title={`${trip.number} · ${plural(trip.stops.length, "stop")}`} right={<StatusPill tone={locked ? "green" : "neutral"}>{locked ? `Manifest locked ${clock(trip.manifestLockedAt)}` : `Plan v${trip.planVersion} · locks at departure`}</StatusPill>}>
        <T tone="text2">{trip.vehicle.label}{trip.cashExpectedCents ? ` · ${money(trip.cashExpectedCents)} cash to collect` : ""}{trip.valueCents != null ? ` · ${money(trip.valueCents)} retail` : ""}</T>
        <CapMeter label="Flower-equivalent" value={trip.flowerEquivG} cap={trip.capFlowerEquivG ?? null} unit="g" />
        {trip.capValueCents != null && trip.valueCents != null ? <CapMeter label="Value" value={trip.valueCents / 100} cap={trip.capValueCents / 100} unit="$" /> : null}
        {trip.plannedRoute ? <T size="sm" tone="text3">Route: {trip.plannedRoute}</T> : null}
      </Panel>

      {overCap || overValue ? <Callout tone="danger" title="Over the per-trip cap">This trip cannot be accepted. Ask dispatch to split it.</Callout> : null}
      {changed ? <Callout tone="danger" title="Manifest changed">The dispensary changed this trip after you accepted it (plan v{trip.planVersion}{trip.manifestLockedAt !== local.acceptance?.manifestLockedAt ? ", manifest re-issued" : ""}). Review every stop again and accept; you will need to rescan the load.</Callout> : null}

      <RouteMap trip={trip} />

      <Panel title="Manifest">
        {trip.stops.map((s, idx) => (
          <View key={s.orderId} style={{ gap: 2 }}>
            {idx > 0 ? <Divider /> : null}
            <Row style={{ justifyContent: "space-between" }}>
              <T bold size="md">{s.seq}. {s.recipientFirstName ?? s.recipient.split(" ")[0]} · {s.orderNumber}</T>
              <T bold>{money(s.totalCents)}</T>
            </Row>
            <T tone="text2">{s.address.line1}{s.address.line2 ? `, ${s.address.line2}` : ""}, {s.address.city} {s.address.zip}</T>
            <T size="sm" tone="text3">{s.windowLabel}{s.eta ? ` · ETA ${clock(s.eta)}` : ""} · {s.paymentMethod === "cash" ? "Cash" : "Paid by bank"}</T>
            {s.items.map((i, k) => (
              <Row key={k} style={{ justifyContent: "space-between" }}>
                <T size="sm" style={{ flex: 1 }}>{i.name} × {i.qty}{i.weightG != null ? ` · ${i.weightG} g` : ""}</T>
                <T size="xs" mono tone="text3">{i.metrcTag ?? "no tag"}</T>
              </Row>
            ))}
          </View>
        ))}
      </Panel>

      {!accepted ? (
        <Panel title={changed ? "Review the changed trip" : "Accept this trip?"}>
          <T tone="text2">You may travel only between the dispensary and the stops above, in this order.</T>
          <Btn tone="purple" disabled={overCap || overValue} onPress={async () => { await clearTripLocal(); await accept(trip); await local.reload(); }}>
            {changed ? "I reviewed the changes · accept" : "Accept trip"}
          </Btn>
          {!declining ? (
            <Btn tone="danger" onPress={() => setDeclining(true)}>Decline…</Btn>
          ) : (
            <View style={{ gap: space[2] }}>
              <Field label="Why are you declining?"><Select value={declineReason} options={[...DECLINE_REASONS]} onChange={setDeclineReason} /></Field>
              <Field label={declineReason === "other" ? "Reason" : "Note (optional)"}><Input value={declineNote} onChangeText={setDeclineNote} placeholder="Recorded on your driver record" /></Field>
              <Row>
                <View style={{ flex: 1 }}><Btn tone="danger" busy={decline.isPending} disabled={declineReason === "other" && declineNote.trim().length < 3} onPress={() => decline.mutate()}>Decline trip</Btn></View>
                <View style={{ flex: 1 }}><Btn onPress={() => setDeclining(false)}>Back</Btn></View>
              </Row>
            </View>
          )}
        </Panel>
      ) : (
        <>
          <Panel title="1 · Scan the load" right={load ? <StatusPill tone={load.complete ? "green" : load.unknownTags.length ? "danger" : "amber"}>{load.loaded.length}/{load.total}</StatusPill> : undefined}>
            <T tone="text2">Scan the Metrc tag on every sealed package as you load it. Only packages on this manifest may go in the vehicle.</T>
            {load?.blockedReason ? <T tone={load.unknownTags.length ? "danger" : "amber"}>{load.blockedReason}</T> : null}
            <Btn tone={load?.complete ? "default" : "purple"} onPress={() => router.push("/trip/scan")}>{load?.complete ? "Review scans" : load ? "Continue scanning" : "Start scanning"}</Btn>
          </Panel>

          {load?.complete ? (
            <Panel title="2 · Sealed-load attestation" right={local.attestation ? <StatusPill tone={loadConfirmed ? "green" : loadRejected ? "danger" : "amber"}>{loadConfirmed ? "Confirmed" : loadRejected ? "Rejected" : "Waiting to sync"}</StatusPill> : undefined}>
              {local.attestation && !loadRejected ? (
                <T tone="text2">Attested at {clock(local.attestation.attestedAt)}.{!loadConfirmed ? " Departure unlocks once the server confirms it." : ""}</T>
              ) : (
                <>
                  {loadRejected ? <Callout tone="danger" title="The server rejected the load">{local.loadEvent?.lastError ?? "Contact the dispensary."}</Callout> : null}
                  <CheckRow checked={att.sealed} onChange={(v) => setAtt({ ...att, sealed: v })}>Every package is sealed and unopened</CheckRow>
                  <CheckRow checked={att.notVisible} onChange={(v) => setAtt({ ...att, notVisible: v })}>No product is visible from outside the vehicle</CheckRow>
                  <CheckRow checked={att.lockbox} onChange={(v) => setAtt({ ...att, lockbox: v })}>All product is in the lockbox or locked cargo area</CheckRow>
                  {photo ? <Image source={{ uri: photo.previewUri }} style={{ height: 140, borderRadius: radius.md }} accessibilityLabel="Sealed load photo" /> : null}
                  <Btn onPress={async () => { try { const p = await takeEvidencePhoto(); if (p) setPhoto(p); } catch (e) { toast.fail(e); } }}>{photo ? "Retake photo" : photoNeeded ? "Take photo of the sealed load (required)" : "Add photo (optional)"}</Btn>
                  <Btn tone="purple" busy={attest.isPending} disabled={!att.sealed || !att.notVisible || !att.lockbox || (photoNeeded && !photo)} onPress={() => attest.mutate()}>Attest sealed load</Btn>
                </>
              )}
            </Panel>
          ) : null}

          <Panel title="3 · Shift-start checklist">
            {checklist.map((c) => <CheckRow key={c.key} checked={!!answers[c.key]} onChange={(v) => setAnswers((a) => ({ ...a, [c.key]: v }))}>{c.label}</CheckRow>)}
            {cashTrip ? (
              <Field label="Float issued by the dispensary ($)" hint="Count the change float you were handed. Change at the door can only come from this float plus cash collected.">
                <Input keyboardType="decimal-pad" value={float} onChangeText={setFloat} placeholder="0.00" />
              </Field>
            ) : null}
            {alwaysLocation === false ? (
              <Callout tone="danger" title="Always location is off">
                <View style={{ gap: space[2] }}>
                  <T tone="text2">The trip is recorded in the background. Allow location “Always” to depart.</T>
                  <Btn size="sm" onPress={() => router.push("/permissions")}>Fix location permission</Btn>
                </View>
              </Callout>
            ) : null}
            <T size="sm" tone="text3">Departing records you and the vehicle on every Metrc sales delivery. Load only the sealed orders listed above.</T>
            {degraded ? (
              <Callout tone="danger" title="Your dispatcher departs this trip">Metrc is degraded, so a manual manifest has to be recorded first. Attest the checklist with your dispatcher.</Callout>
            ) : (
              <>
                {blockers.length ? <View style={{ gap: 2 }}>{blockers.map((b) => <T key={b} size="sm" tone="amber">• {b}</T>)}</View> : null}
                <Btn tone="purple" busy={depart.isPending} disabled={blockers.length > 0} onPress={() => depart.mutate()}>Lock manifest & depart</Btn>
              </>
            )}
          </Panel>
          {!declining ? <Btn tone="danger" onPress={() => setDeclining(true)}>Decline this trip…</Btn> : null}
          {declining ? (
            <Panel title="Decline">
              <Field label="Why are you declining?"><Select value={declineReason} options={[...DECLINE_REASONS]} onChange={setDeclineReason} /></Field>
              <Field label={declineReason === "other" ? "Reason" : "Note (optional)"}><Input value={declineNote} onChangeText={setDeclineNote} placeholder="Recorded on your driver record" /></Field>
              <Row>
                <View style={{ flex: 1 }}><Btn tone="danger" busy={decline.isPending} disabled={declineReason === "other" && declineNote.trim().length < 3} onPress={() => decline.mutate()}>Decline trip</Btn></View>
                <View style={{ flex: 1 }}><Btn onPress={() => setDeclining(false)}>Back</Btn></View>
              </Row>
            </Panel>
          ) : null}
        </>
      )}
    </View>
  );
}

function CapMeter({ label, value, cap, unit }: { label: string; value: number; cap: number | null; unit: "g" | "$" }) {
  const pct = cap ? Math.min(1, value / cap) : 0;
  const over = cap != null && value > cap;
  const fmt = (n: number) => (unit === "$" ? `$${n.toFixed(2)}` : `${Math.round(n * 100) / 100} g`);
  return (
    <View style={{ gap: 4 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <T size="sm" tone="text2">{label}</T>
        <T size="sm" bold tone={over ? "danger" : "text"}>{fmt(value)}{cap != null ? ` of ${fmt(cap)} cap` : ""}</T>
      </Row>
      {cap != null ? (
        <View style={{ height: 6, borderRadius: 3, backgroundColor: color.surface3, overflow: "hidden" }}>
          <View style={{ width: `${pct * 100}%`, height: 6, backgroundColor: over ? color.danger : pct > 0.85 ? color.amber : color.green }} />
        </View>
      ) : null}
    </View>
  );
}
