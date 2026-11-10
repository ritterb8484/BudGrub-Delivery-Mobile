import tokens from "@budgrub/design-tokens/tokens.json";
import type { Tone } from "@/lib/format";

/**
 * Theme built from packages/design-tokens/tokens.json (no CSS on native). Colour names match the web Tailwind theme
 * so `text-text-3` on the web is `color.text3` here.
 */
const c = tokens.color;

export const color = {
  bg: c.bg,
  surface: c.surface,
  surface2: c["surface-2"],
  surface3: c["surface-3"],
  border: c.border,
  borderStrong: c["border-strong"],
  text: c.text,
  text2: c["text-2"],
  text3: c["text-3"],
  onAccent: c["on-accent"],
  purple: c.purple,
  purpleSoft: c["purple-soft"],
  purpleBorder: c["purple-border"],
  blue: c.blue,
  blueSoft: c["blue-soft"],
  blueBorder: c["blue-border"],
  green: c.green,
  greenSoft: c["green-soft"],
  greenBorder: c["green-border"],
  amber: c.amber,
  amberSoft: c["amber-soft"],
  amberBorder: c["amber-border"],
  danger: c.danger,
  dangerSoft: c["danger-soft"],
  dangerBorder: c["danger-border"],
} as const;

/** Lane colours: cannabis purple, food blue. */
export const lane = { cannabis: color.purple, food: color.blue } as const;

export const radius = tokens.radius;
export const space = tokens.space;
export const font = {
  size: tokens.type.size,
  weight: tokens.type.weight as { regular: "400"; medium: "500"; bold: "700" },
  mono: tokens.type.family.mono,
};

export const toneColors: Record<Tone, { fg: string; bg: string; border: string }> = {
  neutral: { fg: color.text2, bg: color.surface2, border: color.border },
  purple: { fg: color.purple, bg: color.purpleSoft, border: color.purpleBorder },
  blue: { fg: color.blue, bg: color.blueSoft, border: color.blueBorder },
  green: { fg: color.green, bg: color.greenSoft, border: color.greenBorder },
  amber: { fg: color.amber, bg: color.amberSoft, border: color.amberBorder },
  danger: { fg: color.danger, bg: color.dangerSoft, border: color.dangerBorder },
};

/** Minimum touch target (44 pt), matching the web console's min-h-11. */
export const TOUCH = 44;
