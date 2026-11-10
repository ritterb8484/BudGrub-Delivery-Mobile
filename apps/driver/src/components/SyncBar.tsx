import { router } from "expo-router";
import { Pressable, StyleSheet } from "react-native";
import { clock } from "@/lib/format";
import { useSyncStatus } from "@/sync/engine";
import { color, radius, space, toneColors } from "@/theme";
import { Row, T } from "./ui";

/** BUD-124: queued count and last sync, always visible during a trip. Tap for the event log. */
export function SyncBar({ fromCache, cachedAt }: { fromCache?: boolean; cachedAt?: string | null }) {
  const s = useSyncStatus();
  const tone = s.rejected.length ? "danger" : s.pending ? "amber" : "green";
  const c = toneColors[tone];
  const label = s.rejected.length
    ? `${s.rejected.length} event${s.rejected.length === 1 ? "" : "s"} rejected · review`
    : s.pending
      ? `${s.pending} queued${s.online === false ? " · offline" : s.syncing ? " · syncing…" : ""}`
      : "All events synced";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Sync status: ${label}`} onPress={() => router.push("/sync")} style={[st.bar, { backgroundColor: c.bg, borderColor: c.border }]}>
      <Row style={{ justifyContent: "space-between" }}>
        <T bold size="sm" tone={tone}>{label}</T>
        <T size="sm" tone="text3">{fromCache ? `Offline copy from ${clock(cachedAt)}` : `Last sync ${clock(s.lastSyncAt)}`}</T>
      </Row>
    </Pressable>
  );
}

const st = StyleSheet.create({
  bar: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], paddingVertical: space[2], borderColor: color.border },
});
