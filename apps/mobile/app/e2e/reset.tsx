import { Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { e2eModeEnabled, resetLocalState } from "@/app-shell";
import { Spinner, Text } from "@/ui";

export default function E2eResetRoute() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!e2eModeEnabled) return;
    let cancelled = false;
    resetLocalState()
      .then(() => {
        if (!cancelled) router.dismissTo("/");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!e2eModeEnabled) return <Redirect href="/" />;
  return (
    <View
      className="flex-1 items-center justify-center gap-3 bg-background"
      testID="e2e-reset-screen"
    >
      {error ? (
        <Text tone="destructive">{error}</Text>
      ) : (
        <>
          <Spinner />
          <Text variant="caption">Resetting local state…</Text>
        </>
      )}
    </View>
  );
}
