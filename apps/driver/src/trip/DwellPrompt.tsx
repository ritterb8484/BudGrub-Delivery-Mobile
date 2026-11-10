import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { Btn, T } from "@/components/ui";
import { clock } from "@/lib/format";
import type { DwellPrompt as Prompt } from "@/location/task";
import { kv, KV } from "@/storage/db";
import { color, radius, space } from "@/theme";

/**
 * BUD-88: the background task flags an off-route dwell; the agent must say what it was. A fuel stop is logged on the
 * trip timeline; anything else is an unauthorized stop reported as an incident.
 */
export function DwellPrompt({ tripId }: { tripId: string }) {
  const [p, setP] = useState<Prompt | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () =>
      kv.get<Prompt>(KV.dwellPrompt).then((v) => {
        if (!live) return;
        setP(v && v.tripId === tripId && !v.resolved ? v : null);
        setNow(Date.now());
      });
    void read();
    const h = setInterval(read, 5_000);
    return () => {
      live = false;
      clearInterval(h);
    };
  }, [tripId]);

  if (!p) return null;
  const mins = Math.max(1, Math.round(((p.endedAt ?? now) - p.startedAt) / 60_000));
  const params = { lat: String(p.lat), lng: String(p.lng), startedAt: new Date(p.startedAt).toISOString(), endedAt: p.endedAt ? new Date(p.endedAt).toISOString() : "", durationSec: String(mins * 60), fromPrompt: "1" };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => undefined}>
      <View style={s.overlay}>
        <View style={s.sheet} accessibilityViewIsModal>
          <T bold size="xl" tone="amber">Stopped off route</T>
          <T tone="text2" size="md">You have been stationary for {mins} min since {clock(new Date(p.startedAt).toISOString())}, outside the dispensary and your planned stops. Every stop on a delivery trip must be recorded.</T>
          <Btn tone="purple" onPress={() => router.push({ pathname: "/trip/fuel-stop", params })}>Fuel stop</Btn>
          <Btn tone="danger" onPress={() => router.push({ pathname: "/incident", params: { ...params, kind: "unauthorized_stop" } })}>Report unauthorized stop</Btn>
        </View>
      </View>
    </Modal>
  );
}

export async function resolveDwellPrompt() {
  const p = await kv.get<Prompt>(KV.dwellPrompt);
  if (p) await kv.set(KV.dwellPrompt, { ...p, resolved: true });
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.75)", justifyContent: "center", padding: space[4] },
  sheet: { backgroundColor: color.surface, borderColor: color.amberBorder, borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[3] },
});
