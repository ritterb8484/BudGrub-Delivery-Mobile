import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "@/api/client";
import { color, radius, space, toneColors } from "@/theme";
import { T } from "./ui";

interface Toast {
  ok: (msg: string) => void;
  fail: (err: unknown) => void;
}
const Ctx = createContext<Toast>({ ok: () => undefined, fail: () => undefined });

export function messageOf(err: unknown): string {
  if (err instanceof NetworkError) return `${err.message}. This needs a connection; try again when you have signal.`;
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; tone: "green" | "danger" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string, tone: "green" | "danger") => {
    if (timer.current) clearTimeout(timer.current);
    setMsg({ text, tone });
    AccessibilityInfo.announceForAccessibility(text);
    timer.current = setTimeout(() => setMsg(null), tone === "danger" ? 6000 : 3500);
  }, []);
  const value = useMemo<Toast>(() => ({ ok: (m) => show(m, "green"), fail: (e) => show(messageOf(e), "danger") }), [show]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {msg ? (
        <SafeAreaView pointerEvents="none" style={StyleSheet.absoluteFill} edges={["top"]}>
          <View style={[s.toast, { backgroundColor: toneColors[msg.tone].bg, borderColor: toneColors[msg.tone].border }]}>
            <T bold tone={msg.tone} size="md">{msg.text}</T>
          </View>
        </SafeAreaView>
      ) : null}
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);

const s = StyleSheet.create({
  toast: { margin: space[3], padding: space[3], borderWidth: 1, borderRadius: radius.md, shadowColor: color.bg, shadowOpacity: 0.6, shadowRadius: 12, elevation: 6 },
});
