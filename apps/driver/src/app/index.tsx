import { Redirect, router } from "expo-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { Btn, Callout, Loading, Screen } from "@/components/ui";
import { kv, KV } from "@/storage/db";

/** Open the current delivery mode once sign-in and first-run permissions are complete. */
export default function Gate() {
  const a = useAuth();
  const [seen, setSeen] = useState<boolean | null>(null);
  useEffect(() => {
    void kv.get<boolean>(KV.permissionsSeen).then((v) => setSeen(Boolean(v)));
  }, [a.status]);

  if (a.status === "loading" || seen === null) return <Loading label="Starting…" />;
  if (a.status === "signedOut") return <Redirect href="/sign-in" />;
  if (!a.mode) return <Screen><Callout title="No delivery access">{a.eligibility.problems.join(". ") || "Ask your administrator to enable delivery access."}</Callout><Btn onPress={() => router.push("/account")}>Account</Btn></Screen>;
  if (!seen) return <Redirect href="/permissions" />;
  return <Redirect href={a.mode === "cannabis" ? "/trip" : "/courier"} />;
}
