Get a notification when an agent asks a question, finishes a turn, or stops on an error. Choose mobile, web, and desktop delivery independently in Settings → Push notifications.

## Delivery

Mobile devices receive push messages through Expo, including when the app is closed. Web browsers and the desktop app receive system notifications over bb’s live connection while a tab or app window remains open. Web delivery requires HTTPS (or localhost), browser notification permission, and a browser that supports the Notification constructor. Closing all bb tabs stops web delivery; quitting the desktop app stops desktop delivery. Mobile WebViews use mobile push only.

Click a notification to open its thread. Events arriving together are combined, with pending questions taking priority. Read, archived, deleted, and hidden threads are suppressed. Multiple tabs or windows of the same origin and client type deduplicate delivery when browser storage and Web Locks are available.

## Settings

- `mobileEnabled` / **Mobile notifications**: send to registered phones and tablets. Default: true.
- `webEnabled` / **Web notifications**: notify connected browsers with permission. Default: true.
- `desktopEnabled` / **Desktop notifications**: notify running desktop clients. Default: true.
- `expoPushUrl` / **Expo push relay URL**: mobile relay endpoint. Defaults to `https://exp.host/--/api/v2/push/send`.

Channel switches apply to this server and save immediately. Browser permission is granted separately on each device with **Allow notifications**. If blocked, change the browser or operating system notification settings. **Send test notification** sends to all connected, permitted clients of the current type. A successful test request confirms broadcast, not OS display; system settings and Focus modes can suppress banners.

## CLI and SDK

- `bb push-notifications list [--json]`: registered mobile devices, with redacted tokens.
- `bb push-notifications add --token <expo-push-token> --platform <ios|android> --label <device-label>`: register or refresh a mobile device.
- `bb push-notifications remove <id>`: remove a mobile device.
- `bb push-notifications status [--json]`: channel switches, mobile relay, subscription count, and last mobile send result.
- `bb push-notifications test <web|desktop>`: broadcast a test to connected clients of that type. Fails if the channel is disabled.
- `bb plugin config push-notifications set <mobileEnabled|webEnabled|desktopEnabled> <true|false>`: change a channel.

Agents can use the SDK’s plugin settings API for the same switches and `sdk.plugins.callRpc({ pluginId: "push-notifications", method: "notifications.test", input: { channel: "web" }, outputSchema: z.object({ ok: z.literal(true) }) })` to send a test. RPC input is validated by `pushNotificationsRpcContract`. Permission requests still require a click in the target client.
