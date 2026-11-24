import { AccessibilityInfo } from "react-native";
import * as Speech from "expo-speech";

/**
 * Spoken and screen-reader announcements (BUD-154, BUD-101): results the driver must hear without looking at the
 * screen (ID-scan pass/fail with the reason, offer countdown, pickup confirmation). Announcements go to VoiceOver /
 * TalkBack when one is running, and are spoken aloud through text-to-speech otherwise.
 */
export async function announce(text: string, opts: { speak?: boolean } = {}) {
  AccessibilityInfo.announceForAccessibility(text);
  const reader = await AccessibilityInfo.isScreenReaderEnabled().catch(() => false);
  if (!reader && opts.speak !== false) Speech.speak(text, { language: "en-US", rate: 1.0 });
}
