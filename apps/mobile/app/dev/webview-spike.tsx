import { Redirect } from "expo-router";
import { e2eModeEnabled } from "@/app-shell";
import { WebViewSpikeScreen } from "@/screens/dev/WebViewSpikeScreen";

export default function WebViewSpikeRoute() {
  if (!e2eModeEnabled) return <Redirect href="/" />;
  return <WebViewSpikeScreen />;
}
