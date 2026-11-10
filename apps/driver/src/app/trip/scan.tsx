import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, StyleSheet, Vibration, View } from "react-native";
import { Btn, Callout, Divider, Empty, Field, Input, Loading, Panel, Row, Screen, StatusPill, T } from "@/components/ui";
import { manifestLines, newSession, scanTag, sessionIsStale, summarise, type LoadSession, type ScanOutcome } from "@/load/manifest";
import { kv, KV } from "@/storage/db";
import { color, radius, space } from "@/theme";
import { saveLoadSession } from "@/trip/state";
import { useDriverTrips } from "@/trip/useDriverTrips";

/**
 * BUD-83 load scan: every Metrc tag against the manifest. Mismatch, duplicate and unknown-package screens block until
 * acknowledged; an unknown package keeps departure blocked until the load is rescanned or the manifest re-issued.
 * The camera reports the same code many times a second, so a tag counts as a new scan only after the camera has
 * stopped seeing it for a moment.
 */
const SAME_CODE_GAP_MS = 2_500;

export default function LoadScan() {
  const { trip, isLoading } = useDriverTrips();
  const [perm, requestPerm] = useCameraPermissions();
  const [session, setSession] = useState<LoadSession | null>(null);
  const [blocking, setBlocking] = useState<ScanOutcome | null>(null);
  const [last, setLast] = useState<ScanOutcome | null>(null);
  const [manual, setManual] = useState("");
  const seen = useRef<{ tag: string; at: number } | null>(null);

  const lines = useMemo(() => (trip ? manifestLines(trip) : []), [trip]);
  useEffect(() => {
    if (!trip) return;
    void kv.get<LoadSession>(KV.loadSession).then((s) => setSession(s && !sessionIsStale(s, trip) ? s : newSession(trip)));
  }, [trip?.id, trip?.manifestLockedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || !session) return <Loading />;
  if (!trip || trip.status !== "planned") return <Screen><Empty title="No trip to load">Loading is done before departure.</Empty></Screen>;

  const summary = summarise(session, lines);

  const record = (raw: string) => {
    const r = scanTag(session, lines, raw, new Date().toISOString());
    setSession(r.session);
    void saveLoadSession(r.session);
    setLast(r.outcome);
    if (r.outcome.kind === "matched") Vibration.vibrate(40);
    else {
      Vibration.vibrate([0, 200, 100, 200]);
      setBlocking(r.outcome);
    }
  };

  const onScan = (e: BarcodeScanningResult) => {
    if (blocking) return;
    const tag = e.data.trim();
    const now = Date.now();
    const prev = seen.current;
    seen.current = { tag, at: now };
    if (prev && prev.tag === tag && now - prev.at < SAME_CODE_GAP_MS) return;
    record(tag);
  };

  const rescan = async () => {
    const s = newSession(trip);
    setSession(s);
    await saveLoadSession(s);
    setBlocking(null);
    setLast(null);
    seen.current = null;
  };

  return (
    <Screen footer={<Btn tone={summary.complete ? "green" : "default"} onPress={() => router.back()}>{summary.complete ? "All packages scanned · continue" : "Back to the trip"}</Btn>}>
      <Row style={{ justifyContent: "space-between" }}>
        <T bold size="lg">{summary.loaded.length} of {summary.total} loaded</T>
        <StatusPill tone={summary.complete ? "green" : summary.unknownTags.length ? "danger" : "amber"}>{summary.complete ? "Complete" : summary.unknownTags.length ? "Blocked" : "In progress"}</StatusPill>
      </Row>

      {!perm ? <Loading label="Checking camera…" /> : !perm.granted ? (
        <Callout tone="amber" title="Camera needed">
          <View style={{ gap: space[2] }}>
            <T tone="text2">Allow the camera to scan Metrc tags.</T>
            <Btn size="sm" onPress={requestPerm}>Allow camera</Btn>
          </View>
        </Callout>
      ) : (
        <View style={st.camera}>
          <CameraView style={StyleSheet.absoluteFill} facing="back" active={!blocking} barcodeScannerSettings={{ barcodeTypes: ["code128", "qr", "datamatrix", "code39"] }} onBarcodeScanned={onScan} />
          <View pointerEvents="none" style={st.reticle} />
        </View>
      )}

      {last ? (
        <Callout tone={last.kind === "matched" ? "green" : "danger"} title={last.kind === "matched" ? `Loaded · ${last.line.orderNumber}` : last.kind === "duplicate" ? "Already scanned" : "Not on the manifest"}>
          {last.kind === "unknown" ? last.tag : `${last.line.name} × ${last.line.qty}`}
        </Callout>
      ) : null}

      {summary.unknownTags.length ? (
        <Callout tone="danger" title="Departure blocked: package not on the manifest">
          <View style={{ gap: space[2] }}>
            <T tone="text2">Remove the package, contact the dispensary, then rescan the whole load. If the dispensary re-issues the manifest, the scan starts over automatically.</T>
            <Btn size="sm" tone="danger" onPress={rescan}>Rescan the load from the start</Btn>
          </View>
        </Callout>
      ) : null}

      <Panel title="Damaged label?">
        <Field label="Type the Metrc tag" hint="Still matched against the manifest.">
          <Input autoCapitalize="characters" autoCorrect={false} value={manual} onChangeText={setManual} placeholder="1A4…" />
        </Field>
        <Btn size="sm" disabled={manual.trim().length < 8} onPress={() => { record(manual); setManual(""); }}>Add tag</Btn>
      </Panel>

      <Panel title="Manifest lines">
        {lines.map((l, i) => {
          const done = summary.loaded.includes(l);
          return (
            <View key={l.tag}>
              {i > 0 ? <Divider /> : null}
              <Row style={{ justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <T size="md">{l.name} × {l.qty}</T>
                  <T size="xs" mono tone="text3">{l.orderNumber} · {l.tag}</T>
                </View>
                <StatusPill tone={done ? "green" : "neutral"}>{done ? "Loaded" : "Missing"}</StatusPill>
              </Row>
            </View>
          );
        })}
        {summary.missing.length && !summary.unknownTags.length ? <T size="sm" tone="text3">Cannot find a package? Do not depart. Contact the dispensary so they can re-issue the manifest.</T> : null}
      </Panel>

      <Modal visible={!!blocking} transparent animationType="fade" onRequestClose={() => undefined}>
        {blocking ? (
        <View style={st.overlay} accessibilityViewIsModal>
          <View style={st.sheet}>
            <T bold size="xl" tone="danger">{blocking.kind === "duplicate" ? "Duplicate scan" : "Package not on this manifest"}</T>
            <T tone="text2" size="md">
              {blocking.kind === "duplicate"
                ? `${blocking.line.name} (${blocking.line.orderNumber}) is already loaded. Check you have not got two of the same package.`
                : `Tag ${blocking.kind === "unknown" ? blocking.tag : ""} is not on ${trip.number}. Do not load it. Contact the dispensary.`}
            </T>
            {blocking.kind === "unknown" ? <Btn tone="danger" onPress={rescan}>Removed it · rescan the load</Btn> : null}
            <Btn onPress={() => { setBlocking(null); seen.current = null; }}>{blocking.kind === "unknown" ? "Contact dispensary first" : "OK, continue scanning"}</Btn>
          </View>
        </View>
        ) : null}
      </Modal>
    </Screen>
  );
}

const st = StyleSheet.create({
  camera: { height: 260, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "#000", borderWidth: 1, borderColor: color.border },
  reticle: { position: "absolute", left: "12%", right: "12%", top: "30%", bottom: "30%", borderWidth: 2, borderColor: color.purple, borderRadius: radius.md },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.75)", justifyContent: "center", padding: space[4] },
  sheet: { backgroundColor: color.surface, borderColor: color.dangerBorder, borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[3] },
});
