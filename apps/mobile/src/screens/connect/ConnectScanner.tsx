import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import {
  parseConnectPairingPayload,
  type ConnectPairingInput,
} from "@/data/connect";
import { Button, GROUPED_CARD_RADIUS, Text } from "@/ui";

interface ConnectScannerProps {
  onScanned: (input: ConnectPairingInput) => void;
  active: boolean;
}

const CARD_STYLE = {
  borderRadius: GROUPED_CARD_RADIUS,
  borderCurve: "continuous" as const,
};

export function ConnectScanner({ onScanned, active }: ConnectScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [lastIgnored, setLastIgnored] = useState<string | null>(null);
  const handledRef = useRef(false);
  useEffect(() => {
    if (active) handledRef.current = false;
  }, [active]);

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View
        className="items-center gap-3 bg-surface-grouped-cell px-4 py-6"
        style={CARD_STYLE}
        testID="connect-scanner-permission"
      >
        <Text variant="bodyLarge" className="text-center">
          bb needs the camera to scan the pairing QR code.
        </Text>
        {permission.canAskAgain ? (
          <Button onPress={() => void requestPermission()} icon="Eye">
            Allow camera
          </Button>
        ) : (
          <Button
            variant="outline"
            onPress={() => void Linking.openSettings()}
            icon="Settings"
          >
            Open Settings
          </Button>
        )}
      </View>
    );
  }

  return (
    <View className="gap-2">
      <View
        className="overflow-hidden bg-surface-grouped-cell"
        style={[CARD_STYLE, { height: 240 }]}
        testID="connect-scanner"
      >
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={
            active
              ? ({ data }) => {
                  if (handledRef.current) return;
                  const parsed = parseConnectPairingPayload(data);
                  if (!parsed) {
                    setLastIgnored(data.slice(0, 40));
                    return;
                  }
                  handledRef.current = true;
                  setLastIgnored(null);
                  onScanned(parsed);
                }
              : undefined
          }
        />
      </View>
      <Text variant="footnote" tone="muted" className="px-4">
        {lastIgnored
          ? `Not a bb pairing code: ${lastIgnored}`
          : "Point the camera at the QR code from bb Settings → Remote access → Add mobile device."}
      </Text>
    </View>
  );
}
