import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Linking, ScrollView, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { api } from "@/courier/api";
import { Button, Callout, Card, Row, Screen, Text } from "@/courier/ui";
import { TOUCH, radius, color as theme } from "@/theme";

/**
 * Masked call and messaging (BUD-150), shared by courier and cannabis stops: the app only ever sees the proxy number.
 * A call is placed by the phone to the masked number; the outcome is reported back so the order (and, for cannabis,
 * the stop's phone-confirmation log) carries it.
 */
export default function ContactScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const { data: t, error: queryError, refetch } = useQuery({ queryKey: ["courier-contact", orderId], queryFn: () => api.contact(orderId), enabled: Boolean(orderId), refetchInterval: 8000 });
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [call, setCall] = useState<{ callId: number; startedAt: number } | null>(null);
  if (!orderId) return null;
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <Text kind="h1" accessibilityRole="header">Contact · {t?.orderNumber ?? ""}</Text>
        <Text tone="text2">Calls and texts use a masked number and are logged on the order.</Text>
        {error || queryError ? <Callout tone="danger" title="Not available">{error ?? queryError?.message}</Callout> : null}
        <Card>
          {!call ? (
            <Button title="Call customer" hint="Dials a masked number" onPress={async () => { try { const r = await api.call(orderId); setCall({ callId: r.callId, startedAt: Date.now() }); await Linking.openURL(`tel:${r.dial}`); } catch (e) { setError((e as Error).message); } }} />
          ) : (
            <>
              <Text kind="title">How did the call go?</Text>
              <Row>
                {(["completed", "no_answer", "busy", "failed"] as const).map((o) => <Button key={o} title={o.replace("_", " ")} tone={o === "completed" ? "green" : "neutral"} onPress={async () => { try { await api.callOutcome(orderId, call.callId, o, Math.round((Date.now() - call.startedAt) / 1000)); setCall(null); setError(null); await refetch(); } catch (e) { setError((e as Error).message); } }} />)}
              </Row>
            </>
          )}
        </Card>
        <Card>
          <Text kind="title">Messages</Text>
          {t?.messages.map((m) => (
            <View key={m.id} accessible accessibilityLabel={`${m.direction === "to_customer" ? "You" : "Customer"}: ${m.body}`} style={{ alignSelf: m.direction === "to_customer" ? "flex-end" : "flex-start", maxWidth: "85%", backgroundColor: m.direction === "to_customer" ? theme.blue : theme.surface2, borderRadius: radius.md, padding: 10 }}>
              <Text tone={m.direction === "to_customer" ? "onAccent" : "text"}>{m.body}</Text>
              <Text kind="small" tone={m.direction === "to_customer" ? "onAccent" : "text3"}>{new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}{m.direction === "to_customer" ? ` · ${m.status}` : ""}</Text>
            </View>
          ))}
          {!t?.messages.length && <Text kind="small" tone="text3">No messages yet.</Text>}
          <Row>
            <TextInput accessibilityLabel="Message to the customer" value={body} onChangeText={setBody} placeholder="I'm 5 minutes away" placeholderTextColor={theme.text3} style={{ flex: 1, minHeight: TOUCH, borderWidth: 1, borderColor: theme.border, borderRadius: radius.sm, color: theme.text, paddingHorizontal: 12, backgroundColor: theme.surface }} />
            <Button title="Send" disabled={!body.trim()} onPress={async () => { try { await api.message(orderId, body.trim()); setBody(""); setError(null); await refetch(); } catch (e) { setError((e as Error).message); } }} />
          </Row>
        </Card>
        {t?.calls.length ? <Card><Text kind="title">Calls</Text>{t.calls.map((c) => <Text key={c.id} kind="small" tone="text2">{new Date(c.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {c.outcome.replace("_", " ")}{c.durationS != null ? ` · ${c.durationS} s` : ""}</Text>)}</Card> : null}
      </ScrollView>
    </Screen>
  );
}
