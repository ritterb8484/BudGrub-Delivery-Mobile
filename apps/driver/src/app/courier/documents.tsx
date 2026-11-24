import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Linking, ScrollView, TextInput } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { api, newEventId } from "@/courier/api";
import { Button, Callout, Card, KeyValue, Pill, Row, Screen, Text } from "@/courier/ui";
import { API_BASE } from "@/config";
import { TOUCH, radius, color as theme } from "@/theme";
import { useAuth } from "@/auth/AuthProvider";

const KINDS = [["drivers_license", "Driver's license"], ["insurance", "Insurance card"], ["vehicle_registration", "Vehicle registration"], ["agent_card", "Agent registration card"]] as const;

/** Onboarding documents (BUD-145): camera or library photo, number and expiry; status from company ops; expiry reminders arrive as push. */
export default function DocumentsScreen() {
  const { me } = useAuth();
  const { data: docs, error: queryError, refetch } = useQuery({ queryKey: ["courier-documents"], queryFn: api.documents });
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>("drivers_license");
  const [number, setNumber] = useState("");
  const [expires, setExpires] = useState("");
  const [file, setFile] = useState<{ mime: string; dataBase64: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (camera: boolean) => {
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setError("Permission is needed to attach the document."); return; }
    const r = camera ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: ["images"] }) : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6, mediaTypes: ["images"] });
    if (!r.canceled && r.assets[0]?.base64) setFile({ mime: r.assets[0].mimeType === "image/png" ? "image/png" : "image/jpeg", dataBase64: r.assets[0].base64 });
  };
  const upload = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try { await api.uploadDocument({ kind, number: number || null, expires: /^\d{4}-\d{2}-\d{2}$/.test(expires) ? expires : null, file }, newEventId()); setFile(null); setNumber(""); setExpires(""); await refetch(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const input = { minHeight: TOUCH, borderWidth: 1, borderColor: theme.border, borderRadius: radius.sm, color: theme.text, paddingHorizontal: 12, backgroundColor: theme.surface };
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <Text kind="h1" accessibilityRole="header">Documents</Text>
        <Text tone="text2">Company operations reviews each upload. Reminders arrive 30 and 7 days before anything expires; an expired licence or insurance pauses deliveries.</Text>
        {error || queryError ? <Callout tone="danger" title="Document error">{error ?? queryError?.message}</Callout> : null}
        <Card>
          <Text kind="title">Upload</Text>
          <Row>{KINDS.filter(([k]) => k !== "agent_card" || me?.role === "driver").map(([k, label]) => <Button key={k} title={label} tone={kind === k ? "primary" : "neutral"} onPress={() => setKind(k)} />)}</Row>
          <TextInput accessibilityLabel="Document number" value={number} onChangeText={setNumber} placeholder="Number (optional)" placeholderTextColor={theme.text3} style={input} />
          <TextInput accessibilityLabel="Expiry date, year-month-day" value={expires} onChangeText={setExpires} placeholder="Expires (YYYY-MM-DD)" placeholderTextColor={theme.text3} style={input} />
          <Row><Button title="Camera" tone="neutral" onPress={() => pick(true)} /><Button title="Library" tone="neutral" onPress={() => pick(false)} />{file ? <Pill tone="green">Photo attached</Pill> : null}</Row>
          <Button title="Upload" busy={busy} disabled={!file} onPress={upload} />
        </Card>
        {docs?.map((d) => (
          <Card key={d.id}>
            <Row><Text kind="title">{d.label}</Text><Pill tone={d.status === "approved" ? "green" : d.status === "pending" ? "blue" : "danger"}>{d.status}</Pill></Row>
            <KeyValue k="Number" v={d.number ?? "—"} />
            <KeyValue k="Expires" v={d.expires ? `${d.expires}${d.daysToExpiry != null ? ` (${d.daysToExpiry} days)` : ""}` : "—"} />
            {d.reviewNote ? <Text kind="small" tone="text2">{d.reviewNote}</Text> : null}
            <Button title="View" tone="neutral" hint="Opens a link that expires in a few minutes" onPress={() => Linking.openURL(new URL(d.url, API_BASE).toString())} />
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}
