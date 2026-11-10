import { router, Stack } from "expo-router";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/auth/AuthProvider";
import { SyncBar } from "@/components/SyncBar";
import { messageOf } from "@/components/toast";
import { Btn, Callout, Empty, Loading, Panel, Row, T } from "@/components/ui";
import { clock, plural } from "@/lib/format";
import { color, space } from "@/theme";
import { ActiveTrip } from "@/trip/ActiveTrip";
import { DwellPrompt } from "@/trip/DwellPrompt";
import { TripOffer } from "@/trip/TripOffer";
import { useDriverTrips, useRefreshDriver } from "@/trip/useDriverTrips";

/**
 * Cannabis delivery mode home: the assigned trip (offer → load → depart) or the trip in progress, with sync status,
 * incident reporting and recent trips. Same structure as DriverTrip in apps/admin/src/pages/DriverTrip.tsx.
 */
export default function TripHome() {
  const auth = useAuth();
  const q = useDriverTrips();
  const refresh = useRefreshDriver();

  const header = (
    <Stack.Screen
      options={{
        headerRight: () => (
          <Pressable accessibilityRole="button" hitSlop={12} onPress={() => router.push("/account")}>
            <T tone="text2">Account</T>
          </Pressable>
        ),
      }}
    />
  );

  if (q.isLoading) return <>{header}<Loading label="Loading your trip…" /></>;
  // Only when there is nothing to show: a failed background refresh must not take the trip off the screen.
  if (!q.data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: color.bg, padding: space[4], gap: space[4] }}>
        {header}
        <Callout tone="danger" title="Could not load your trip">{messageOf(q.error)}</Callout>
        <Btn onPress={() => q.refetch()}>Try again</Btn>
      </SafeAreaView>
    );
  }

  const { recent, checklist, agent, metrcDegraded } = q.data.data;
  const trip = q.trip;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={["bottom", "left", "right"]}>
      {header}
      <ScrollView contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }} refreshControl={<RefreshControl tintColor={color.purple} refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
        <T tone="text2" size="sm">
          {agent.name} · agent card {agent.agentCardNumber ?? "not on file"}{agent.agentCardExpires ? ` · expires ${agent.agentCardExpires.slice(0, 10)}` : ""}
        </T>
        <SyncBar fromCache={q.fromCache} cachedAt={q.cachedAt} />
        {agent.problems.length > 0 ? <Callout tone="danger" title="You cannot be assigned a trip yet">{`${agent.problems.join(". ")}. Ask your dispatcher to update your record.`}</Callout> : null}
        {metrcDegraded ? <Callout tone="danger" title="Metrc is degraded">Deliveries are being recorded locally and queued. Your dispatcher records the manual manifest and departs the trip; hand-overs work as usual.</Callout> : null}
        {q.error && !q.fromCache ? <Callout tone="amber" title="Could not refresh your trip">{`${messageOf(q.error)} Showing the last version loaded; pull down to try again.`}</Callout> : null}
        {auth.offline || q.fromCache ? <Callout tone="amber" title="Offline">Showing the trip saved on this device. Scans, calls, ID checks and hand-overs keep working and upload in order when you are back online.</Callout> : null}

        {!trip ? (
          <Empty title="No trip assigned">Your dispatcher builds trips from packed orders. You will get a notification when one is offered; this page also refreshes on its own.</Empty>
        ) : trip.status === "planned" ? (
          <TripOffer trip={trip} checklist={checklist} degraded={metrcDegraded} onRefresh={refresh} />
        ) : (
          <ActiveTrip trip={trip} onRefresh={refresh} fromCache={q.fromCache} />
        )}

        <Btn tone="danger" onPress={() => router.push("/incident")}>Report an incident</Btn>

        {recent.length > 0 ? (
          <Panel title="Recent trips">
            {recent.map((t) => (
              <Row key={t.id} style={{ justifyContent: "space-between" }}>
                <T size="sm" style={{ flex: 1 }}>
                  <T bold size="sm">{t.number}</T> · {plural(t.stops.length, "stop")} · {t.stops.filter((s) => s.status === "delivered").length} delivered · {t.stops.filter((s) => s.status === "returned").length} returned
                </T>
                <T size="sm" tone="text3">{t.completedAt ? clock(t.completedAt) : t.status}</T>
              </Row>
            ))}
          </Panel>
        ) : null}
        <View />
      </ScrollView>
      {trip?.status === "departed" ? <DwellPrompt tripId={trip.id} /> : null}
    </SafeAreaView>
  );
}
