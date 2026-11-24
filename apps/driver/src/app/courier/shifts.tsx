import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "@/courier/api";
import type { ShiftRow } from "@/courier/types";
import { Callout, Card, KeyValue, Pill, Row, Screen, Text } from "@/courier/ui";
import { money } from "@/courier/format";

/** Shift history (BUD-145): mode, start and end, deliveries completed, incidents, earnings per shift. */
export default function ShiftsScreen() {
  const [rows, setRows] = useState<ShiftRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.shifts().then(setRows).catch((x: Error) => setError(x.message)); }, []);
  const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <Text kind="h1" accessibilityRole="header">Shifts</Text>
        {error ? <Callout tone="danger" title="Could not load">{error}</Callout> : null}
        {rows?.map((s) => (
          <Card key={s.id} lane={s.mode === "cannabis" ? "cannabis" : "food"}>
            <Row><Pill tone={s.mode === "cannabis" ? "purple" : "blue"}>{s.mode}</Pill>{!s.endedAt ? <Pill tone="green">open</Pill> : null}</Row>
            <KeyValue k="Started" v={when(s.startedAt)} />
            <KeyValue k="Ended" v={s.endedAt ? when(s.endedAt) : "—"} />
            <KeyValue k="Deliveries" v={String(s.deliveries ?? 0)} />
            <KeyValue k="Incidents" v={String(s.incidents ?? 0)} />
            <KeyValue k="Earned" v={money(s.earnedCents ?? 0)} />
          </Card>
        ))}
        {rows && !rows.length && <Text tone="text3">No shifts yet.</Text>}
      </ScrollView>
    </Screen>
  );
}
