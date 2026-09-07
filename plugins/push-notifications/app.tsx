import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import {
  CLIENT_NOTIFICATION_CHANNEL,
  type pushNotificationsRpcContract,
} from "./contract.js";
import {
  clientChannel,
  createClientDelivery,
  notificationPermission,
} from "./client.js";

function NotificationDelivery() {
  const navigate = useBbNavigate();
  const { values } = useSettings();
  const delivery = useRef<ReturnType<typeof createClientDelivery> | null>(null);
  useEffect(() => {
    const next = createClientDelivery((id) => navigate.toThread(id));
    delivery.current = next;
    return () => {
      delivery.current = null;
      next.dispose();
    };
  }, [navigate]);
  useRealtime(CLIENT_NOTIFICATION_CHANNEL, (payload) => {
    const channel = clientChannel();
    const enabled = channel !== null && values?.[`${channel}Enabled`] === true;
    void delivery.current?.deliver(payload, enabled).catch(() => undefined);
  });
  return null;
}

function NotificationSettings() {
  const rpc = useRpc<typeof pushNotificationsRpcContract>();
  const { values } = useSettings();
  const channel = clientChannel();
  const [permission, setPermission] = useState(notificationPermission);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => setPermission(notificationPermission());
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  if (channel === null) return null;
  const enabled = values?.[`${channel}Enabled`] === true;
  const status =
    permission === "unsupported"
      ? "System notifications are unavailable here. Use a supported browser over HTTPS or localhost."
      : permission === "denied"
        ? "Notifications are blocked. Allow them in your browser or system notification settings, then return here."
        : permission === "granted"
          ? "Notifications allowed. Your system notification settings also apply."
          : "Allow notifications on this device to receive thread updates.";

  async function requestPermission() {
    setBusy(true);
    setMessage(null);
    try {
      setPermission(await Notification.requestPermission());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function testNotification() {
    if (channel === null) return;
    setBusy(true);
    setMessage(null);
    try {
      await rpc.call("notifications.test", { channel });
      setMessage(
        `Test sent to connected ${channel} clients with notification permission.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">
        {channel === "desktop" ? "This desktop app" : "This browser"}
      </h3>
      <p className="text-muted-foreground" role="status">
        {status}
      </p>
      {permission === "default" ? (
        <button
          type="button"
          className="rounded-md border border-border px-3 py-2 disabled:opacity-50"
          disabled={busy || !enabled}
          onClick={() => void requestPermission()}
        >
          Allow notifications
        </button>
      ) : null}
      {permission === "granted" ? (
        <button
          type="button"
          className="rounded-md border border-border px-3 py-2 disabled:opacity-50"
          disabled={busy || !enabled}
          onClick={() => void testNotification()}
        >
          Send test notification
        </button>
      ) : null}
      {!enabled ? (
        <p className="text-muted-foreground">
          Enable {channel} notifications above to receive updates.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Channel settings apply to this bb server. Each browser needs permission.
        Click a notification to open its thread.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "delivery",
    component: NotificationDelivery,
  });
  app.slots.settingsSection({ id: "device", component: NotificationSettings });
});
