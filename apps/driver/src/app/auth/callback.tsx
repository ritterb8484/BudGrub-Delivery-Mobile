import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { Loading } from "@/components/ui";

/**
 * Landing route for budgrub-driver://auth/callback. The auth session browser normally intercepts the redirect and
 * hands it to signIn(); if the OS opens the app through the deep link instead, return to the gate.
 */
export default function AuthCallback() {
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDone(true), 400);
    return () => clearTimeout(t);
  }, []);
  return done ? <Redirect href="/" /> : <Loading label="Signing in…" />;
}
