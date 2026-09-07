import { Redirect } from "expo-router";
import { useProfiles } from "@/app-shell";
import { Spinner } from "@/ui";
import { View } from "react-native";

export default function HomeRoute() {
  const { status, profiles } = useProfiles();
  if (status !== "ready") {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Spinner />
      </View>
    );
  }
  if (profiles.length === 0) return <Redirect href="/settings/servers/add" />;
  return <Redirect href="/webview" />;
}
