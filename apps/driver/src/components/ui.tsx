import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Tone } from "@/lib/format";
import { color, font, radius, space, toneColors, TOUCH } from "@/theme";

/** Native counterparts of the web console's components (apps/admin/src/components/ui + @budgrub/ui). */

export function Screen({ children, scroll = true, footer }: { children: ReactNode; scroll?: boolean; footer?: ReactNode }) {
  return (
    <SafeAreaView style={s.screen} edges={["bottom", "left", "right"]}>
      {scroll ? <ScrollView contentContainerStyle={s.screenBody} keyboardShouldPersistTaps="handled">{children}</ScrollView> : <View style={[s.screenBody, { flex: 1 }]}>{children}</View>}
      {footer ? <View style={s.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

export function T({ children, size = "base", tone, bold, mono, style, numberOfLines }: { children: ReactNode; size?: keyof typeof font.size; tone?: "text" | "text2" | "text3" | Tone; bold?: boolean; mono?: boolean; style?: object; numberOfLines?: number }) {
  const fg = !tone || tone === "text" ? color.text : tone === "text2" ? color.text2 : tone === "text3" ? color.text3 : toneColors[tone].fg;
  return (
    <Text numberOfLines={numberOfLines} style={[{ color: fg, fontSize: font.size[size], fontWeight: bold ? font.weight.bold : font.weight.regular, fontFamily: mono ? font.mono : undefined, lineHeight: font.size[size] * 1.35 }, style]}>
      {children}
    </Text>
  );
}

type BtnTone = "default" | "primary" | "purple" | "green" | "danger";
const BTN: Record<BtnTone, { bg: string; fg: string; border: string }> = {
  default: { bg: color.surface2, fg: color.text, border: color.border },
  primary: { bg: color.text, fg: color.onAccent, border: color.text },
  purple: { bg: color.purple, fg: color.onAccent, border: color.purple },
  green: { bg: color.green, fg: color.onAccent, border: color.green },
  danger: { bg: color.dangerSoft, fg: color.danger, border: color.dangerBorder },
};

export function Btn({ children, tone = "default", onPress, disabled, busy, size = "md", accessibilityHint }: { children: ReactNode; tone?: BtnTone; onPress?: () => void; disabled?: boolean; busy?: boolean; size?: "sm" | "md"; accessibilityHint?: string }) {
  const c = BTN[tone];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      accessibilityHint={accessibilityHint}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [s.btn, size === "sm" && s.btnSm, { backgroundColor: c.bg, borderColor: c.border, opacity: off ? 0.45 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color={c.fg} /> : <Text style={{ color: c.fg, fontWeight: font.weight.bold, fontSize: size === "sm" ? font.size.sm : font.size.md, textAlign: "center" }}>{children}</Text>}
    </Pressable>
  );
}

export function Panel({ title, right, children, style }: { title?: string; right?: ReactNode; children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[s.panel, style]}>
      {title || right ? (
        <View style={s.panelHead}>
          {title ? <T bold size="md" style={{ flex: 1 }}>{title}</T> : <View style={{ flex: 1 }} />}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Callout({ tone = "neutral", title, children }: { tone?: Tone; title: string; children?: ReactNode }) {
  const c = toneColors[tone];
  return (
    <View accessibilityRole="alert" style={[s.callout, { backgroundColor: c.bg, borderColor: c.border }]}>
      <T bold size="md" tone={tone}>{title}</T>
      {children ? <View style={{ marginTop: space[1] }}>{typeof children === "string" ? <T tone="text2">{children}</T> : children}</View> : null}
    </View>
  );
}

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const c = toneColors[tone];
  return (
    <View style={[s.pill, { backgroundColor: c.bg, borderColor: c.border }]}>
      <T size="sm" bold tone={tone}>{children}</T>
    </View>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <View style={{ gap: space[1] }}>
      <T size="sm" bold tone="text2">{label}</T>
      {children}
      {hint ? <T size="sm" tone="text3">{hint}</T> : null}
    </View>
  );
}

export function Input(props: TextInputProps) {
  return <TextInput placeholderTextColor={color.text3} {...props} style={[s.input, props.multiline && { minHeight: 88, textAlignVertical: "top", paddingTop: 10 }, props.style]} />;
}

/** Option list in place of <select>: large touch targets, works with screen readers. */
export function Select<V extends string>({ value, options, onChange }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  return (
    <View style={{ gap: space[1] }} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange(o.value)} style={[s.option, on && { borderColor: color.purple, backgroundColor: color.purpleSoft }]}>
            <View style={[s.radio, on && { borderColor: color.purple, backgroundColor: color.purple }]} />
            <T size="md" style={{ flex: 1 }}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => onChange(!checked)} style={[s.option, checked && { borderColor: color.greenBorder, backgroundColor: color.greenSoft }]}>
      <View style={[s.check, checked && { backgroundColor: color.green, borderColor: color.green }]}>{checked ? <Text style={{ color: color.onAccent, fontWeight: "700" }}>✓</Text> : null}</View>
      <T size="md" style={{ flex: 1 }}>{children}</T>
    </Pressable>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={s.empty}>
      <T bold size="lg">{title}</T>
      {children ? <T tone="text3" style={{ textAlign: "center", marginTop: space[2] }}>{children}</T> : null}
    </View>
  );
}

export function Row({ children, gap = 2, style, wrap }: { children: ReactNode; gap?: 1 | 2 | 3 | 4; style?: ViewStyle; wrap?: boolean }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap: space[String(gap) as keyof typeof space], flexWrap: wrap ? "wrap" : "nowrap" }, style]}>{children}</View>;
}

export function Divider() {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: color.border, marginVertical: space[2] }} />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <View style={[s.empty, { flex: 1, justifyContent: "center" }]}>
      <ActivityIndicator color={color.purple} />
      <T tone="text3" style={{ marginTop: space[2] }}>{label}</T>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  screenBody: { padding: space[4], gap: space[4], paddingBottom: space[8] },
  footer: { padding: space[4], borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border, backgroundColor: color.surface, gap: space[2] },
  btn: { minHeight: TOUCH + 4, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space[4], alignItems: "center", justifyContent: "center" },
  btnSm: { minHeight: 36, paddingHorizontal: space[3] },
  panel: { backgroundColor: color.surface, borderColor: color.border, borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[2] },
  panelHead: { flexDirection: "row", alignItems: "center", gap: space[2], marginBottom: space[1] },
  callout: { borderWidth: 1, borderRadius: radius.md, padding: space[3] },
  pill: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space[2], paddingVertical: 2, alignSelf: "flex-start" },
  input: { minHeight: TOUCH, borderWidth: 1, borderColor: color.border, borderRadius: radius.md, backgroundColor: color.surface2, color: color.text, paddingHorizontal: space[3], fontSize: font.size.md },
  option: { minHeight: TOUCH, flexDirection: "row", alignItems: "center", gap: space[3], borderWidth: 1, borderColor: color.border, borderRadius: radius.md, backgroundColor: color.surface2, paddingHorizontal: space[3], paddingVertical: space[2] },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: color.borderStrong },
  check: { width: 22, height: 22, borderRadius: radius.sm, borderWidth: 2, borderColor: color.borderStrong, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", padding: space[8] },
});
