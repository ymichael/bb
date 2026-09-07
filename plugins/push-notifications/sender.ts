import { randomUUID } from "node:crypto";
import type {
  BbPluginApi,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";
import { z } from "zod";
import {
  CLIENT_NOTIFICATION_CHANNEL,
  type ClientNotification,
  type PushSubscription,
} from "./contract.js";
import type { PushSubscriptionStore } from "./subscriptions.js";

type ThreadResponse = PluginThreadEventPayloads["thread.idle"]["thread"];
type PendingInteraction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];
type PushNotificationKind =
  | "pending-interaction"
  | "turn-finished"
  | "thread-error";

const EXPO_PUSH_BATCH_SIZE = 100;
const DEFAULT_COALESCE_MS = 2_000;
const PUSH_TITLE_MAX_LENGTH = 80;
const PUSH_BODY_MAX_LENGTH = 180;
const NETWORK_WARNING_INTERVAL_MS = 60 * 60 * 1_000;
const LAST_OUTCOME_KEY = "last-send-outcome";
const PUSH_KIND_PRIORITY: readonly PushNotificationKind[] = [
  "pending-interaction",
  "thread-error",
  "turn-finished",
];

const expoPushTicketSchema = z.union([
  z.object({ status: z.literal("ok"), id: z.string().optional() }),
  z.object({
    status: z.literal("error"),
    message: z.string().optional(),
    details: z
      .object({ error: z.string().optional() })
      .passthrough()
      .optional(),
  }),
]);
const expoPushResponseSchema = z.object({
  data: z.array(expoPushTicketSchema).optional(),
  errors: z
    .array(
      z.object({ code: z.string().optional(), message: z.string().optional() }),
    )
    .optional(),
});

export const lastSendOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("never") }).strict(),
  z
    .object({
      status: z.literal("sent"),
      at: z.number().int().nonnegative(),
      sentCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      at: z.number().int().nonnegative(),
      reason: z.string().min(1),
    })
    .strict(),
]);

export type LastSendOutcome = z.infer<typeof lastSendOutcomeSchema>;

interface PushNotificationData {
  kind: PushNotificationKind;
  projectId: string;
  serverUrl?: string;
  threadId: string;
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data: PushNotificationData;
  sound: "default";
  channelId: "default";
  priority: "high";
}

export type PushSenderFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    dispatcher: Dispatcher;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface PendingThreadPush {
  bodies: Map<PushNotificationKind, string>;
  eventAt: number;
  kinds: Set<PushNotificationKind>;
  timer: ReturnType<typeof setTimeout>;
}

interface Delivery {
  message: ExpoPushMessage;
  subscription: PushSubscription;
}

interface BatchResult {
  sentCount: number;
  failure: string | null;
}

export interface PushSender {
  getLastOutcome(): LastSendOutcome;
  onInteractionPending(
    payload: PluginThreadEventPayloads["interaction.pending"],
  ): void;
  onThreadFailed(payload: PluginThreadEventPayloads["thread.failed"]): void;
  onThreadIdle(payload: PluginThreadEventPayloads["thread.idle"]): void;
  settle(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreatePushSenderArgs {
  bb: BbPluginApi;
  subscriptions: PushSubscriptionStore;
  getExpoPushUrl(): Promise<string>;
  getDeliverySettings(): Promise<{
    mobileEnabled: boolean;
    webEnabled: boolean;
    desktopEnabled: boolean;
  }>;
  fetch?: PushSenderFetch;
  coalesceMs?: number;
  now?: () => number;
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function threadDisplayTitle(thread: ThreadResponse): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  if (fallback) return fallback;
  return `Thread ${thread.id.slice(0, 8)}`;
}

function describePendingInteraction(interaction: PendingInteraction): string {
  const payload = interaction.payload;
  if (payload.kind === "user_question") {
    const prompt = firstLine(payload.questions[0]?.prompt ?? "");
    return prompt || "The agent has a question for you";
  }
  if (payload.kind === "approval") {
    const subject = payload.subject;
    if (subject.kind === "command") {
      return `Approve command: ${firstLine(subject.command)}`;
    }
    if (subject.kind === "file_change") return "Approve file changes";
    if (subject.kind === "permission_grant") {
      return subject.toolName
        ? `Grant permissions to ${subject.toolName}`
        : "Grant additional permissions";
    }
    return "Review the plan before the agent continues";
  }
  if ("title" in payload) return payload.title;
  return "Waiting for your input";
}

function pickKind(
  kinds: ReadonlySet<PushNotificationKind>,
): PushNotificationKind | null {
  for (const kind of PUSH_KIND_PRIORITY) {
    if (kinds.has(kind)) return kind;
  }
  return null;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function createPushSender(args: CreatePushSenderArgs): PushSender {
  const {
    bb,
    subscriptions,
    coalesceMs = DEFAULT_COALESCE_MS,
    now = Date.now,
  } = args;
  const fetchImpl = args.fetch ?? undiciFetch;
  const pending = new Map<string, PendingThreadPush>();
  const inFlight = new Set<Promise<void>>();
  let dispatcher: EnvHttpProxyAgent | null = null;
  let lastNetworkWarningAt = Number.NEGATIVE_INFINITY;
  let lastOutcome: LastSendOutcome = { status: "never" };
  let running = false;

  async function setLastOutcome(outcome: LastSendOutcome): Promise<void> {
    lastOutcome = outcome;
    await bb.storage.kv.set(LAST_OUTCOME_KEY, outcome);
  }

  function cancel(threadId: string): void {
    const entry = pending.get(threadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(threadId);
  }

  function schedule(
    threadId: string,
    kind: PushNotificationKind,
    body: string,
  ): void {
    if (!running) return;
    const eventAt = now();
    const existing = pending.get(threadId);
    if (existing) {
      existing.kinds.add(kind);
      existing.bodies.set(kind, body);
      existing.eventAt = Math.max(existing.eventAt, eventAt);
      return;
    }
    const timer = setTimeout(() => {
      const entry = pending.get(threadId);
      pending.delete(threadId);
      if (!entry || !running) return;
      const flush = flushThread(threadId, entry).catch((error: unknown) => {
        bb.log.error(
          `Push notification flush failed for thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      inFlight.add(flush);
      void flush.finally(() => inFlight.delete(flush));
    }, coalesceMs);
    timer.unref?.();
    pending.set(threadId, {
      bodies: new Map([[kind, body]]),
      eventAt,
      kinds: new Set([kind]),
      timer,
    });
  }

  async function resolvePush(
    thread: ThreadResponse,
    entry: PendingThreadPush,
  ): Promise<{ kind: PushNotificationKind; body: string } | null> {
    const kinds = new Set(entry.kinds);
    let interaction: PendingInteraction | null = null;
    if (kinds.has("pending-interaction")) {
      const interactions = await bb.sdk.threads.interactions.list({
        threadId: thread.id,
      });
      interaction =
        interactions.find((candidate) => candidate.status === "pending") ??
        null;
      if (!interaction) kinds.delete("pending-interaction");
    }
    if (kinds.has("turn-finished") && thread.status !== "idle") {
      kinds.delete("turn-finished");
    }
    if (kinds.has("thread-error") && thread.status !== "error") {
      kinds.delete("thread-error");
    }
    const kind = pickKind(kinds);
    if (kind === null) return null;
    if (kind === "pending-interaction") {
      return {
        kind,
        body: interaction
          ? describePendingInteraction(interaction)
          : "Waiting for your input",
      };
    }
    return {
      kind,
      body:
        entry.bodies.get(kind) ??
        (kind === "thread-error"
          ? "The thread hit an error"
          : "Finished and waiting for you"),
    };
  }

  async function flushThread(
    threadId: string,
    entry: PendingThreadPush,
  ): Promise<void> {
    let thread: ThreadResponse;
    try {
      thread = await bb.sdk.threads.get({ threadId });
    } catch {
      return;
    }
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.visibility !== "visible"
    ) {
      return;
    }
    const lastReadAt = thread.lastReadAt ?? 0;
    if (lastReadAt >= thread.latestAttentionAt && lastReadAt >= entry.eventAt) {
      return;
    }
    const resolved = await resolvePush(thread, entry);
    if (resolved === null) return;
    const title = truncate(threadDisplayTitle(thread), PUSH_TITLE_MAX_LENGTH);
    const body = truncate(resolved.body, PUSH_BODY_MAX_LENGTH);
    const config = await args.getDeliverySettings();
    const channels: ClientNotification["channels"] = [];
    if (config.webEnabled) channels.push("web");
    if (config.desktopEnabled) channels.push("desktop");
    if (channels.length > 0) {
      bb.realtime.publish(CLIENT_NOTIFICATION_CHANNEL, {
        id: randomUUID(),
        title,
        body,
        threadId: thread.id,
        channels,
      } satisfies ClientNotification);
    }
    if (!config.mobileEnabled) return;
    const rows = await subscriptions.list();
    if (rows.length === 0) return;
    const serverUrl = bb.server.experimental_appUrl;
    const deliveries: Delivery[] = rows.map((subscription) => ({
      subscription,
      message: {
        to: subscription.expoPushToken,
        title,
        body,
        data: {
          kind: resolved.kind,
          projectId: thread.projectId,
          ...(serverUrl === null ? {} : { serverUrl }),
          threadId: thread.id,
        },
        sound: "default",
        channelId: "default",
        priority: "high",
      },
    }));
    let sentCount = 0;
    let failure: string | null = null;
    for (const batch of chunks(deliveries, EXPO_PUSH_BATCH_SIZE)) {
      const result = await sendBatch(batch);
      sentCount += result.sentCount;
      failure ??= result.failure;
    }
    await setLastOutcome(
      failure === null
        ? { status: "sent", at: now(), sentCount }
        : { status: "failed", at: now(), reason: failure },
    );
  }

  async function sendBatch(batch: readonly Delivery[]): Promise<BatchResult> {
    const activeDispatcher = dispatcher;
    if (activeDispatcher === null) {
      return { sentCount: 0, failure: "sender is stopped" };
    }
    let responseText: string;
    let status: number;
    try {
      const response = await fetchImpl(await args.getExpoPushUrl(), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(batch.map((delivery) => delivery.message)),
        dispatcher: activeDispatcher,
      });
      status = response.status;
      responseText = await response.text();
    } catch {
      const warningAt = now();
      if (warningAt - lastNetworkWarningAt >= NETWORK_WARNING_INTERVAL_MS) {
        lastNetworkWarningAt = warningAt;
        bb.log.warn(
          `Expo push request failed for subscription rows ${batch.map((delivery) => delivery.subscription.id).join(", ")}`,
        );
      }
      return { sentCount: 0, failure: "network request failed" };
    }
    const parsed = expoPushResponseSchema.safeParse(
      (() => {
        try {
          return JSON.parse(responseText) as unknown;
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success) {
      bb.log.warn(
        `Expo push response was not understood for ${batch.length} subscription rows with status ${status}`,
      );
      return { sentCount: 0, failure: "relay returned an invalid response" };
    }
    if (parsed.data.errors && parsed.data.errors.length > 0) {
      const codes = parsed.data.errors.map((error) => error.code ?? "unknown");
      bb.log.warn(
        `Expo push request was rejected with codes ${codes.join(", ")}`,
      );
      return { sentCount: 0, failure: "relay rejected the request" };
    }
    if (parsed.data.data === undefined) {
      bb.log.warn(
        `Expo push response returned no tickets with status ${status}`,
      );
      return { sentCount: 0, failure: "relay returned no tickets" };
    }
    let sentCount = 0;
    let ticketFailure = false;
    for (const [index, ticket] of parsed.data.data.entries()) {
      const delivery = batch[index];
      if (!delivery) continue;
      if (ticket.status === "ok") {
        sentCount += 1;
        continue;
      }
      const errorCode = ticket.details?.error ?? "unknown";
      if (errorCode === "DeviceNotRegistered") {
        await subscriptions.remove(delivery.subscription.id);
        bb.log.info(
          `Removed push subscription row ${delivery.subscription.id}: device is not registered`,
        );
        continue;
      }
      ticketFailure = true;
      bb.log.warn(
        `Expo push ticket reported ${errorCode} for subscription row ${delivery.subscription.id}`,
      );
    }
    return {
      sentCount,
      failure: ticketFailure ? "relay rejected one or more tickets" : null,
    };
  }

  async function settle(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  return {
    getLastOutcome: () => lastOutcome,
    onInteractionPending(payload) {
      schedule(
        payload.thread.id,
        "pending-interaction",
        describePendingInteraction(payload.interaction),
      );
    },
    onThreadFailed({ thread, error }) {
      schedule(
        thread.id,
        "thread-error",
        firstLine(error ?? "") || "The thread hit an error",
      );
    },
    onThreadIdle({ thread, lastAssistantText }) {
      if (thread.parentThreadId !== null || thread.visibility !== "visible") {
        return;
      }
      schedule(
        thread.id,
        "turn-finished",
        firstLine(lastAssistantText ?? "") || "Finished and waiting for you",
      );
    },
    settle,
    async start() {
      if (running) return;
      const stored = lastSendOutcomeSchema.safeParse(
        await bb.storage.kv.get<unknown>(LAST_OUTCOME_KEY),
      );
      if (stored.success) lastOutcome = stored.data;
      dispatcher = new EnvHttpProxyAgent();
      running = true;
    },
    async stop() {
      if (!running) return;
      running = false;
      for (const threadId of [...pending.keys()]) cancel(threadId);
      await settle();
      const activeDispatcher = dispatcher;
      dispatcher = null;
      await activeDispatcher?.close();
    },
  };
}
