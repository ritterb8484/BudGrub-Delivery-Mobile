import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { Loading } from "@/components/ui";
import { kv, KV } from "@/storage/db";

/** Entry gate: sign-in → permission explainers (once) → cannabis trip screen or courier placeholder (BUD-67). */
export default function Gate() {
  const a = useAuth();
  const [seen, setSeen] = useState<boolean | null>(null);
  useEffect(() => {
    void kv.get<boolean>(KV.permissionsSeen).then((v) => setSeen(Boolean(v)));
  }, [a.status]);

  if (a.status === "loading" || seen === null) return <Loading label="Starting…" />;
  if (a.status === "signedOut") return <Redirect href="/sign-in" />;
  if (!seen) return <Redirect href="/permissions" />;
  return <Redirect href={a.mode === "cannabis" ? "/trip" : "/courier"} />;
}
