import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  addPushSubscriptionInputSchema,
  CLIENT_NOTIFICATION_CHANNEL,
  clientChannelSchema,
  DEFAULT_EXPO_PUSH_URL,
  pushNotificationsRpcContract,
  type AddPushSubscriptionInput,
  type ClientNotification,
  type PushSubscriptionSummary,
} from "./contract.js";
import {
  createPushSender,
  type CreatePushSenderArgs,
  type LastSendOutcome,
} from "./sender.js";
import { createPushSubscriptionStore } from "./subscriptions.js";

interface PushNotificationsPluginOptions {
  coalesceMs?: number;
  createId?: () => string;
  fetch?: CreatePushSenderArgs["fetch"];
  now?: () => number;
}

interface StatusView {
  enabled: true;
  subscriptionCount: number;
  mobileEnabled: boolean;
  webEnabled: boolean;
  desktopEnabled: boolean;
  relayUrl: string;
  lastSendOutcome: LastSendOutcome;
}

function parseAddArguments(
  args: readonly string[],
):
  | { ok: true; value: AddPushSubscriptionInput }
  | { ok: false; message: string } {
  if (args.length !== 6) {
    return {
      ok: false,
      message:
        "Usage: bb push-notifications add --token <expo-push-token> --platform <ios|android> --label <device-label>",
    };
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !["--token", "--platform", "--label"].includes(key) ||
      values.has(key)
    ) {
      return {
        ok: false,
        message:
          "Usage: bb push-notifications add --token <expo-push-token> --platform <ios|android> --label <device-label>",
      };
    }
    values.set(key, value);
  }
  const parsed = addPushSubscriptionInputSchema.safeParse({
    expoPushToken: values.get("--token"),
    platform: values.get("--platform"),
    deviceLabel: values.get("--label"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    };
  }
  return { ok: true, value: parsed.data };
}

function formatSubscriptions(
  subscriptions: readonly PushSubscriptionSummary[],
): string {
  if (subscriptions.length === 0) return "No push devices registered";
  return [
    "ID\tDevice\tPlatform\tLast seen\tToken suffix",
    ...subscriptions.map((subscription) =>
      [
        subscription.id,
        subscription.deviceLabel,
        subscription.platform,
        new Date(subscription.lastSeenAt).toISOString(),
        subscription.tokenSuffix,
      ].join("\t"),
    ),
  ].join("\n");
}

function formatLastOutcome(outcome: LastSendOutcome): string {
  if (outcome.status === "never") return "Never";
  if (outcome.status === "sent") {
    return `Sent ${outcome.sentCount} at ${new Date(outcome.at).toISOString()}`;
  }
  return `Failed at ${new Date(outcome.at).toISOString()}: ${outcome.reason}`;
}

function formatStatus(status: StatusView): string {
  return [
    `Enabled: ${status.enabled}`,
    `Mobile: ${status.mobileEnabled}`,
    `Web: ${status.webEnabled}`,
    `Desktop: ${status.desktopEnabled}`,
    `Subscriptions: ${status.subscriptionCount}`,
    `Relay URL: ${status.relayUrl}`,
    `Last send: ${formatLastOutcome(status.lastSendOutcome)}`,
  ].join("\n");
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function createPushNotificationsPlugin(
  options: PushNotificationsPluginOptions = {},
) {
  return async function pushNotificationsPlugin(
    bb: BbPluginApi,
  ): Promise<void> {
    const settings = bb.settings.define({
      mobileEnabled: {
        type: "boolean",
        label: "Mobile notifications",
        description:
          "Send push messages to your registered phones and tablets.",
        default: true,
      },
      webEnabled: {
        type: "boolean",
        label: "Web notifications",
        description:
          "Show system notifications while bb is open in a browser. Each browser needs notification permission.",
        default: true,
      },
      desktopEnabled: {
        type: "boolean",
        label: "Desktop notifications",
        description:
          "Show system notifications while the bb desktop app is running.",
        default: true,
      },
      expoPushUrl: {
        type: "string",
        label: "Expo push relay URL",
        description: "The Expo push relay endpoint used for mobile delivery.",
        default: DEFAULT_EXPO_PUSH_URL,
        experimental_schema: z.string().url(),
      },
    });
    const subscriptions = createPushSubscriptionStore(bb, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.createId === undefined ? {} : { createId: options.createId }),
    });
    const sender = createPushSender({
      bb,
      subscriptions,
      getDeliverySettings: () => settings.get(),
      getExpoPushUrl: async () => (await settings.get()).expoPushUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.coalesceMs === undefined
        ? {}
        : { coalesceMs: options.coalesceMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    async function status(): Promise<StatusView> {
      const [{ expoPushUrl, mobileEnabled, webEnabled, desktopEnabled }, rows] =
        await Promise.all([settings.get(), subscriptions.list()]);
      return {
        enabled: true,
        subscriptionCount: rows.length,
        mobileEnabled,
        webEnabled,
        desktopEnabled,
        relayUrl: expoPushUrl,
        lastSendOutcome: sender.getLastOutcome(),
      };
    }

    async function sendTest(channel: "web" | "desktop") {
      const config = await settings.get();
      if (!(channel === "web" ? config.webEnabled : config.desktopEnabled)) {
        throw new Error(`${channel} notifications are disabled`);
      }
      bb.realtime.publish(CLIENT_NOTIFICATION_CHANNEL, {
        id: randomUUID(),
        title: "bb notifications are working",
        body: "You’ll be notified when a thread needs your attention.",
        threadId: null,
        channels: [channel],
      } satisfies ClientNotification);
      return { ok: true as const };
    }

    bb.rpc.register(pushNotificationsRpcContract, {
      "notifications.test": ({ channel }) => sendTest(channel),
      "pushSubscriptions.list": async () => ({
        subscriptions: await subscriptions.listSummaries(),
      }),
      "pushSubscriptions.add": (input) => subscriptions.add(input),
      "pushSubscriptions.remove": async ({ id }) => {
        if (!(await subscriptions.remove(id))) {
          throw new Error(`Push subscription not found: ${id}`);
        }
        return { ok: true as const };
      },
    });

    bb.cli.register({
      name: "push-notifications",
      summary: "Manage mobile, web, and desktop notifications",
      commands: [
        {
          name: "test",
          summary:
            "Send a test to connected web or desktop clients with permission",
          usage: "bb push-notifications test <web|desktop>",
        },
        {
          name: "list",
          summary: "List registered push devices",
          usage: "bb push-notifications list [--json]",
        },
        {
          name: "add",
          summary: "Register or refresh an Expo push device",
          usage:
            "bb push-notifications add --token <expo-push-token> --platform <ios|android> --label <device-label>",
        },
        {
          name: "remove",
          summary: "Remove a registered push device",
          usage: "bb push-notifications remove <id>",
        },
        {
          name: "status",
          summary: "Show push delivery status",
          usage: "bb push-notifications status [--json]",
        },
      ],
      async run(argv) {
        const [command, ...args] = argv;
        if (command === "test" && args.length === 1) {
          const channel = clientChannelSchema.safeParse(args[0]);
          if (!channel.success)
            return { exitCode: 1, stderr: "Use web or desktop" };
          try {
            await sendTest(channel.data);
            return {
              exitCode: 0,
              stdout: `Test sent to connected ${channel.data} clients with notification permission`,
            };
          } catch (error) {
            return {
              exitCode: 1,
              stderr: error instanceof Error ? error.message : String(error),
            };
          }
        }
        if (
          command === "list" &&
          (args.length === 0 || (args.length === 1 && args[0] === "--json"))
        ) {
          const rows = await subscriptions.listSummaries();
          return {
            exitCode: 0,
            stdout:
              args[0] === "--json"
                ? JSON.stringify({ subscriptions: rows })
                : formatSubscriptions(rows),
          };
        }
        if (command === "add") {
          const parsed = parseAddArguments(args);
          if (!parsed.ok) return { exitCode: 1, stderr: parsed.message };
          const result = await subscriptions.add(parsed.value);
          return {
            exitCode: 0,
            stdout: `${result.created ? "Registered" : "Refreshed"} push device ${result.id}`,
          };
        }
        if (command === "remove" && args.length === 1) {
          const id = args[0] ?? "";
          if (!(await subscriptions.remove(id))) {
            return {
              exitCode: 1,
              stderr: `Push subscription not found: ${id}`,
            };
          }
          return { exitCode: 0, stdout: `Removed push device ${id}` };
        }
        if (
          command === "status" &&
          (args.length === 0 || (args.length === 1 && args[0] === "--json"))
        ) {
          const view = await status();
          return {
            exitCode: 0,
            stdout:
              args[0] === "--json" ? JSON.stringify(view) : formatStatus(view),
          };
        }
        return {
          exitCode: 1,
          stderr:
            "Usage: bb push-notifications <list|add|remove|status|test> [options]",
        };
      },
    });

    bb.events.on("interaction.pending", (payload) => {
      sender.onInteractionPending(payload);
    });
    bb.events.on("thread.idle", (payload) => {
      sender.onThreadIdle(payload);
    });
    bb.events.on("thread.failed", (payload) => {
      sender.onThreadFailed(payload);
    });
    bb.background.service("push-sender", {
      async start(signal) {
        await sender.start();
        try {
          await waitForAbort(signal);
        } finally {
          await sender.stop();
        }
      },
    });
  };
}

export default createPushNotificationsPlugin();
