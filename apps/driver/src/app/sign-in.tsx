import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { SignInCancelled } from "@/auth/oidc";
import { useAuth } from "@/auth/AuthProvider";
import { messageOf } from "@/components/toast";
import { Btn, Callout, Screen, T } from "@/components/ui";
import { API_BASE, VARIANT } from "@/config";
import { color, space } from "@/theme";

export default function SignIn() {
  const { signIn } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
      router.replace("/");
    } catch (e) {
      if (!(e instanceof SignInCancelled)) setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, justifyContent: "center", gap: space[4] }}>
        <View style={{ gap: space[1] }}>
          <T size="2xl" bold>BudGrub Driver</T>
          <T tone="text2" size="md">Sign in with your BudGrub staff account. Cannabis deliveries are available to card-holding agents disclosed to the CCB.</T>
        </View>
        {error ? <Callout tone="danger" title="Could not sign in">{error}</Callout> : null}
        <Btn tone="purple" busy={busy} onPress={go}>Sign in</Btn>
        {VARIANT !== "production" ? (
          <T size="sm" tone="text3" style={{ textAlign: "center" }}>
            {VARIANT} · {API_BASE}
            {VARIANT === "development" ? "\nStub identity: Jamal Pierce (stub-jamal)" : ""}
          </T>
        ) : null}
      </View>
      <View style={{ height: 4, backgroundColor: color.purple, borderRadius: 2 }} />
    </Screen>
  );
}
