import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Image } from "react-native";
import { eventPaths } from "@/api/client";
import { useToast } from "@/components/toast";
import { Btn, Callout, Empty, Field, Input, Panel, Screen, T } from "@/components/ui";
import { clock } from "@/lib/format";
import { currentPosition } from "@/location/task";
import { enqueue } from "@/sync/engine";
import { tripScope } from "@/sync/queue";
import { radius } from "@/theme";
import { resolveDwellPrompt } from "@/trip/DwellPrompt";
import { takeEvidencePhoto } from "@/trip/photo";
import { useDriverTrips } from "@/trip/useDriverTrips";

/** BUD-88: a fuel stop on the trip timeline (location, start/end, optional receipt photo) via POST …/events. */
export default function FuelStop() {
  const p = useLocalSearchParams<{ lat?: string; lng?: string; startedAt?: string; endedAt?: string; fromPrompt?: string }>();
  const { trip } = useDriverTrips();
  const toast = useToast();
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(p.lat && p.lng ? { lat: Number(p.lat), lng: Number(p.lng) } : null);
  const [startedAt] = useState(p.startedAt || new Date().toISOString());
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<{ mime: string; dataBase64: string; previewUri: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pos) void currentPosition().then(setPos);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!trip || trip.status !== "departed") return <Screen><Empty title="No trip in progress">Fuel stops are logged during a trip.</Empty></Screen>;

  const save = async () => {
    setBusy(true);
    try {
      await enqueue({
        scope: tripScope(trip.id),
        kind: "trip_event",
        path: eventPaths.events(trip.id),
        body: {
          kind: "fuel_stop",
          lat: pos?.lat ?? null,
          lng: pos?.lng ?? null,
          startedAt,
          endedAt: p.endedAt || new Date().toISOString(),
          note: note.trim() || null,
          ...(photo ? { photo: { mime: photo.mime, dataBase64: photo.dataBase64 } } : {}),
        },
        meta: { event: "fuel_stop" },
      });
      if (p.fromPrompt) await resolveDwellPrompt();
      toast.ok("Fuel stop logged on the trip.");
      router.back();
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen footer={<Btn tone="purple" busy={busy} onPress={save}>Log fuel stop</Btn>}>
      <Panel title={`${trip.number} · fuel stop`}>
        <T tone="text2">Started {clock(startedAt)}{p.endedAt ? ` · ended ${clock(p.endedAt)}` : " · ends when you save"}</T>
        <T tone="text2">{pos ? `Location ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : "Getting your location…"}</T>
      </Panel>
      <Callout tone="amber" title="Product stays locked">Keep the vehicle locked and the product in the lockbox while you refuel.</Callout>
      <Field label="Note"><Input value={note} onChangeText={setNote} placeholder="Station name (optional)" /></Field>
      {photo ? <Image source={{ uri: photo.previewUri }} style={{ height: 160, borderRadius: radius.md }} accessibilityLabel="Fuel receipt" /> : null}
      <Btn onPress={async () => { try { const ph = await takeEvidencePhoto(); if (ph) setPhoto(ph); } catch (e) { toast.fail(e); } }}>{photo ? "Retake receipt photo" : "Add receipt photo (optional)"}</Btn>
    </Screen>
  );
}
