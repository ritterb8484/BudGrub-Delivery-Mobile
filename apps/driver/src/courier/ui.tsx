import type { ReactNode } from "react";
import { View, type TextProps, type ViewStyle } from "react-native";
import { Btn, Panel, Row as BaseRow, Screen as BaseScreen, StatusPill, T } from "@/components/ui";
import type { Tone } from "@/lib/format";
import { color } from "@/theme";

export { Callout, Divider } from "@/components/ui";

export function Screen({ children }: { children: ReactNode }) {
  return <BaseScreen scroll={false}>{children}</BaseScreen>;
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <BaseRow wrap style={style}>{children}</BaseRow>;
}

export function Card({ children, lane, style }: { children: ReactNode; lane?: "food" | "cannabis"; style?: ViewStyle }) {
  const borderColor = lane === "food" ? color.blueBorder : lane === "cannabis" ? color.purpleBorder : undefined;
  return <Panel style={{ borderColor, ...style }}>{children}</Panel>;
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <StatusPill tone={tone}>{children}</StatusPill>;
}

export function Text({ children, kind, tone, style, ...accessibility }: Pick<TextProps, "accessibilityRole" | "accessibilityLiveRegion"> & {
  children: ReactNode;
  kind?: "h1" | "h2" | "title" | "eyebrow" | "small";
  tone?: "text" | "text2" | "text3" | "onAccent" | Tone;
  style?: object;
}) {
  const size = kind === "h1" ? "xl" : kind === "h2" || kind === "title" ? "md" : kind ? "sm" : "base";
  return <T {...accessibility} size={size} tone={tone} style={style} bold={Boolean(kind && kind !== "small")}>{children}</T>;
}

export function KeyValue({ k, v }: { k: string; v: ReactNode }) {
  return <BaseRow wrap style={{ justifyContent: "space-between" }}><T tone="text2" style={{ flexShrink: 1 }}>{k}</T><T bold>{v}</T></BaseRow>;
}

export function Button({ title, tone, hint, style, ...props }: Omit<Parameters<typeof Btn>[0], "children" | "tone"> & {
  title: string;
  tone?: "green" | "primary" | "danger" | "neutral";
  hint?: string;
  style?: ViewStyle;
}) {
  const button = <Btn {...props} tone={tone === "neutral" ? "default" : tone} accessibilityHint={hint}>{title}</Btn>;
  return style ? <View style={style}>{button}</View> : button;
}
