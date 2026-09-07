import {
  buildBridgeEventScript,
  parsePageToShellMessage,
  type BridgeResponse,
  type NativeScreen,
  type PageToShellMessage,
  type ShellToPageEvent,
} from "@bb/mobile-bridge";
import { useCallback, useMemo, useRef } from "react";
import { Linking, Platform, Share } from "react-native";
import type { WebView, WebViewMessageEvent } from "react-native-webview";
import { haptic } from "@/lib/haptics";
import { buildBridgeSharePayload, isExternallyOpenable } from "@/lib/shell";
import { updateAppBadgeCount } from "@/notifications/AppBadgeSync";

export interface ShellBridgeCallbacks {
  onReady(path: string): void;
  onPath(path: string): void;
  onOpenNative(screen: NativeScreen): void;
}

export interface ShellBridge {
  onMessage(event: WebViewMessageEvent): void;
  send(event: ShellToPageEvent): void;
}

export function useShellBridge(
  webViewRef: React.RefObject<WebView | null>,
  callbacks: ShellBridgeCallbacks,
): ShellBridge {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const send = useCallback(
    (event: ShellToPageEvent) => {
      webViewRef.current?.injectJavaScript(buildBridgeEventScript(event));
    },
    [webViewRef],
  );

  const respond = useCallback(
    (id: string, response: BridgeResponse) => {
      send({ type: "response", id, response });
    },
    [send],
  );

  const handle = useCallback(
    async (message: PageToShellMessage): Promise<void> => {
      switch (message.type) {
        case "ready":
          callbacksRef.current.onReady(message.path);
          return;
        case "title":
          callbacksRef.current.onPath(message.path);
          return;
        case "haptic":
          haptic(message.kind);
          return;
        case "badge":
          updateAppBadgeCount(message.count);
          return;
        case "open-native":
          callbacksRef.current.onOpenNative(message.screen);
          return;
        case "open-external": {
          if (!isExternallyOpenable(message.url)) return;
          await Linking.openURL(message.url).catch(() => undefined);
          return;
        }
        case "request": {
          if (message.request.kind === "share") {
            const payload = buildBridgeSharePayload(
              Platform.OS,
              message.request.payload,
            );
            try {
              const result = await Share.share(
                payload.content,
                payload.options,
              );
              respond(message.id, {
                ok: true,
                result: { shared: result.action !== Share.dismissedAction },
              });
            } catch (error) {
              respond(message.id, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          return;
        }
      }
    },
    [respond],
  );

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const parsed = parsePageToShellMessage(event.nativeEvent.data);
      if (!parsed.ok) {
        if (__DEV__)
          console.warn("shell bridge dropped a message", parsed.reason);
        return;
      }
      if (__DEV__) console.log("shell bridge", JSON.stringify(parsed.message));
      void handle(parsed.message);
    },
    [handle],
  );

  return useMemo(() => ({ onMessage, send }), [onMessage, send]);
}
