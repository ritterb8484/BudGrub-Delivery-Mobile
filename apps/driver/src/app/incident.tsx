import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { eventPaths } from "@/api/client";
import type { IncidentInput } from "@/api/types";
import { useToast } from "@/components/toast";
import { Btn, Callout, Field, Input, Screen, Select, T } from "@/components/ui";
import { clock } from "@/lib/format";
import { currentPosition } from "@/location/task";
import { enqueue } from "@/sync/engine";
import { resolveDwellPrompt } from "@/trip/DwellPrompt";
import { useDriverTrips } from "@/trip/useDriverTrips";

/**
 * Crash, theft/loss or unauthorized stop (POST /admin/incidents, routes/admin/compliance.ts), same fields and time
 * limits as the web console. Queued so a report made without coverage is filed — and dispatch and compliance notified
 * server-side — on replay; the outcome (incident number) shows in the sync log.
 */
type Kind = IncidentInput["kind"];
const KINDS: { value: Kind; label: string }[] = [
  { value: "crash", label: "Vehicle crash" },
  { value: "theft_loss", label: "Theft or loss of product" },
  { value: "unauthorized_stop", label: "Unauthorized stop" },
  { value: "other", label: "Other" },
];

export default function Incident() {
  const p = useLocalSearchParams<{ kind?: Kind; lat?: string; lng?: string; startedAt?: string; durationSec?: string; fromPrompt?: string }>();
  const { trip } = useDriverTrips();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>(p.kind ?? "crash");
  const [description, setDescription] = useState(
    p.kind === "unauthorized_stop" && p.startedAt ? `Stopped off route for about ${Math.round(Number(p.durationSec ?? 0) / 60)} min from ${clock(p.startedAt)}. Reason: ` : "",
  );
  const [location, setLocation] = useState("");
  const [packages, setPackages] = useState("");
  const [police, setPolice] = useState("");
  const [injuries, setInjuries] = useState<"no" | "yes">("no");
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(p.lat && p.lng ? { lat: Number(p.lat), lng: Number(p.lng) } : null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pos) void currentPosition().then(setPos);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setBusy(true);
    try {
      const body: IncidentInput = {
        kind,
        description: description.trim(),
        location: location.trim() || (pos ? `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : null),
        packages: packages.split(",").map((s) => s.trim()).filter(Boolean),
        policeReportNumber: police.trim() || null,
        injuries: kind === "crash" ? injuries === "yes" : undefined,
        tripId: trip?.id ?? null,
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        startedAt: p.startedAt ?? null,
        durationSec: p.durationSec ? Number(p.durationSec) : null,
      };
      await enqueue({ scope: "incidents", kind: "incident", path: eventPaths.incidents(), body: body as unknown as Record<string, unknown>, sequenced: false, meta: { event: "incident", incidentKind: kind, tripId: trip?.id ?? null } });
      if (p.fromPrompt) await resolveDwellPrompt();
      toast.ok("Incident saved. Dispatch and compliance are notified as soon as it reaches the server.");
      router.back();
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen footer={<Btn tone="danger" busy={busy} disabled={description.trim().length < 5} onPress={submit}>Submit incident</Btn>}>
      <T size="sm" tone="text3">
        A crash must reach the Board within 12 hours; theft or loss immediately. Reporting here starts that clock and alerts your dispensary.{!trip ? " You are not on a trip; the report is filed without one." : ""}
      </T>
      {kind === "theft_loss" ? <Callout tone="danger" title="Theft or loss: report now">If anyone is in danger, call 911 first.</Callout> : null}
      <Field label="What happened"><Select value={kind} options={KINDS} onChange={setKind} /></Field>
      <Field label="Description"><Input multiline value={description} onChangeText={setDescription} placeholder="Where, when, what, who was involved" /></Field>
      <Field label="Location" hint={pos ? `GPS ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} is attached.` : undefined}><Input value={location} onChangeText={setLocation} placeholder="Cross streets or address" /></Field>
      {kind === "crash" ? <Field label="Anyone injured?"><Select value={injuries} options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]} onChange={setInjuries} /></Field> : null}
      {kind === "theft_loss" ? (
        <>
          <Field label="Packages affected (Metrc tags, comma-separated)"><Input value={packages} onChangeText={setPackages} autoCapitalize="characters" /></Field>
          <Field label="Police report number"><Input value={police} onChangeText={setPolice} /></Field>
        </>
      ) : null}
    </Screen>
  );
}
