import { router, Stack } from "expo-router";
import { Pressable } from "react-native";
import { useAuth } from "@/auth/AuthProvider";
import { Btn, Callout, Empty, Screen, T } from "@/components/ui";
import { lane } from "@/theme";

/** Food courier mode is E11 (out of scope). The mode switch stays so eligible agents can move between lanes. */
export default function Courier() {
  const a = useAuth();
  return (
    <Screen>
      <Stack.Screen options={{ headerRight: () => <Pressable onPress={() => router.push("/account")}><T tone="text2">Account</T></Pressable> }} />
      <Empty title="Food courier mode">Food deliveries arrive in a later release (E11). You will be notified when courier trips are available.</Empty>
      {a.eligibility.cannabis ? (
        <Btn tone="purple" onPress={async () => { await a.setMode("cannabis"); router.replace("/trip"); }}>Switch to cannabis delivery</Btn>
      ) : (
        <Callout tone="amber" title="Cannabis delivery is not available on your account">
          <T tone="text2">{a.eligibility.problems.join(". ")}. Ask your dispatcher to update your agent record; changes apply the next time you open the app.</T>
        </Callout>
      )}
      <T size="sm" tone="text3" style={{ textAlign: "center", color: lane.food }}>Courier lane</T>
    </Screen>
  );
}
