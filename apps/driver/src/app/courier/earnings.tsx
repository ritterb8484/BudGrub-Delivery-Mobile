import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "@/courier/api";
import type { Earnings } from "@/courier/types";
import { Callout, Card, KeyValue, Row, Screen, Text } from "@/courier/ui";
import { money } from "@/courier/format";

/** Earnings (BUD-145): today / this week / this month split into delivery pay, tips and bonuses, with line items. */
export default function EarningsScreen() {
  const settlements = useQuery({ queryKey: ["courier-settlements"], queryFn: api.settlements });
  const [e, setE] = useState<Earnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.earnings().then(setE).catch((x: Error) => setError(x.message)); }, []);
  if (error) return <Screen><Callout tone="danger" title="Could not load">{error}</Callout></Screen>;
  if (!e) return <Screen><Text tone="text3">Loading…</Text></Screen>;
  const block = (label: string, t: Earnings["today"]) => (
    <Card key={label} style={{ flex: 1, minWidth: 150 }}>
      <Text kind="eyebrow" tone="text3">{label}</Text>
      <Text kind="h1">{money(t.totalCents)}</Text>
      <KeyValue k="Delivery pay" v={money(t.payCents)} />
      <KeyValue k="Tips" v={money(t.tipCents)} />
      <KeyValue k="Bonuses" v={money(t.bonusCents)} />
      <KeyValue k="Deliveries" v={String(t.deliveries)} />
    </Card>
  );
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <Text kind="h1" accessibilityRole="header">Earnings</Text>
        <Row style={{ alignItems: "stretch" }}>{block("Today", e.today)}{block("This week", e.week)}</Row>
        {block("This month", e.month)}
        <Card>
          <Text kind="title">Settlements</Text>
          {settlements.error && <Text tone="danger">{settlements.error.message}</Text>}
          {settlements.data?.map(row => <KeyValue key={row.id} k={`${row.state === "paid" ? "Paid" : "Approved"} · ${new Date(row.paidAt ?? row.cutoffAt).toLocaleDateString()}`} v={money(row.cents)} />)}
          {settlements.data?.length === 0 && <Text tone="text2">Approved and paid settlements appear here.</Text>}
        </Card>
        <Card>
          <Text kind="title">Line items</Text>
          {e.lines.map((l) => <KeyValue key={l.id} k={`${new Date(l.at).toLocaleDateString([], { month: "short", day: "numeric" })} · ${l.kind}${l.orderNumber ? ` · ${l.orderNumber}` : ""}${l.vendor ? ` · ${l.vendor}` : ""}${l.note && !l.orderNumber ? ` · ${l.note}` : ""}`} v={money(l.cents)} />)}
          {!e.lines.length && <Text kind="small" tone="text3">Nothing earned yet this month.</Text>}
        </Card>
      </ScrollView>
    </Screen>
  );
}
