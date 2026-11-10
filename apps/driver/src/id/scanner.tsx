import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useRef, useState, type ComponentType } from "react";
import { StyleSheet, View } from "react-native";
import { Btn, Callout, Field, Input, Loading, Row, Select, T } from "@/components/ui";
import { color, radius, space } from "@/theme";
import { AamvaParseError, parseAamva } from "./aamva";
import { formatDateInput } from "./validator";

/**
 * ID scanner adapter (BUD-101). No approved scanner SDK is in the repo yet, so two adapters ship:
 *   - `pdf417`: reads the AAMVA PDF417 barcode on the back of a US driver's licence / state ID with expo-camera.
 *   - `manual`: the same fields the web console's manual check uses (passports, military IDs, damaged barcodes).
 * The approved SDK plugs in as a third adapter with the same contract. Adapters return fields only: no image is
 * captured, stored or uploaded.
 */
export interface ScannedId {
  name: string;
  /** ISO yyyy-mm-dd */
  dob: string;
  idType: string;
  expires: string | null;
  last4: string | null;
  source: "pdf417" | "manual" | string;
}

export interface ScannerProps {
  idTypes: string[];
  recipient: string;
  onResult: (id: ScannedId) => void;
}

export interface ScannerAdapter {
  id: string;
  label: string;
  Component: ComponentType<ScannerProps>;
}

function Pdf417Scanner({ onResult }: ScannerProps) {
  const [perm, request] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  const onScan = (e: BarcodeScanningResult) => {
    if (done.current) return;
    try {
      const p = parseAamva(e.data);
      done.current = true;
      onResult({ name: p.fullName, dob: p.dob, idType: p.documentType, expires: p.expires, last4: p.last4, source: "pdf417" });
    } catch (err) {
      setError(err instanceof AamvaParseError ? `${err.message}. Try again or enter the ID manually.` : "Could not read the barcode.");
    }
  };

  if (!perm) return <Loading label="Checking camera…" />;
  if (!perm.granted) {
    return (
      <Callout tone="amber" title="Camera needed">
        <View style={{ gap: space[2] }}>
          <T tone="text2">Allow the camera to read the barcode on the back of the licence. Nothing is photographed or stored.</T>
          <Btn size="sm" onPress={request}>Allow camera</Btn>
        </View>
      </Callout>
    );
  }
  return (
    <View style={{ gap: space[2] }}>
      <View style={s.camera}>
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["pdf417"] }} onBarcodeScanned={onScan} />
        <View pointerEvents="none" style={s.frame} />
      </View>
      <T size="sm" tone="text3">Hold the back of the licence flat, barcode inside the frame.</T>
      {error ? <T tone="danger">{error}</T> : null}
    </View>
  );
}

function ManualEntry({ idTypes, onResult }: ScannerProps) {
  // The name starts empty on purpose: it must be read off the ID, not carried over from the order, or the name
  // check would pass for whoever is at the door.
  const [f, setF] = useState({ name: "", dob: "", idType: idTypes[0] ?? "drivers_license", last4: "", expires: "" });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  return (
    <View style={{ gap: space[3] }}>
      <Field label="Name on ID" hint="Type it exactly as printed on the ID."><Input value={f.name} onChangeText={(v) => setF({ ...f, name: v })} autoCapitalize="words" autoCorrect={false} /></Field>
      <Row>
        <View style={{ flex: 1 }}><Field label="Date of birth" hint="YYYY-MM-DD"><Input value={f.dob} onChangeText={(v) => setF({ ...f, dob: formatDateInput(v) })} placeholder="1990-04-02" keyboardType="number-pad" maxLength={10} /></Field></View>
        <View style={{ flex: 1 }}><Field label="Expires" hint="YYYY-MM-DD"><Input value={f.expires} onChangeText={(v) => setF({ ...f, expires: formatDateInput(v) })} placeholder="2030-04-02" keyboardType="number-pad" maxLength={10} /></Field></View>
      </Row>
      <Field label="ID type"><Select value={f.idType} options={idTypes.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))} onChange={(v) => setF({ ...f, idType: v })} /></Field>
      <Field label="Last 4 of ID number"><Input value={f.last4} onChangeText={(v) => setF({ ...f, last4: v.replace(/\s/g, "") })} maxLength={4} autoCapitalize="characters" /></Field>
      <Btn tone="primary" disabled={!f.name.trim() || !iso.test(f.dob)} onPress={() => onResult({ name: f.name.trim(), dob: f.dob, idType: f.idType, expires: f.expires || null, last4: f.last4 || null, source: "manual" })}>Check this ID</Btn>
    </View>
  );
}

export const scanners: ScannerAdapter[] = [
  { id: "pdf417", label: "Scan licence barcode", Component: Pdf417Scanner },
  { id: "manual", label: "Enter manually", Component: ManualEntry },
];

const s = StyleSheet.create({
  camera: { height: 240, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "#000", borderWidth: 1, borderColor: color.border },
  frame: { position: "absolute", left: "6%", right: "6%", top: "28%", bottom: "28%", borderWidth: 2, borderColor: color.green, borderRadius: radius.sm },
});
