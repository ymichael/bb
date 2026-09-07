import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  pushSubscriptionSchema,
  type AddPushSubscriptionInput,
  type PushSubscription,
  type PushSubscriptionSummary,
} from "./contract.js";

const SUBSCRIPTION_KEY_PREFIX = "subscription:";

export interface PushSubscriptionStore {
  add(input: AddPushSubscriptionInput): Promise<{ id: string; created: boolean }>;
  list(): Promise<PushSubscription[]>;
  listSummaries(): Promise<PushSubscriptionSummary[]>;
  remove(id: string): Promise<boolean>;
}

export function createPushSubscriptionStore(
  bb: BbPluginApi,
  options: { now?: () => number; createId?: () => string } = {},
): PushSubscriptionStore {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  let mutationQueue: Promise<void> = Promise.resolve();

  async function readAll(): Promise<PushSubscription[]> {
    const keys = await bb.storage.kv.list(SUBSCRIPTION_KEY_PREFIX);
    const subscriptions: PushSubscription[] = [];
    for (const key of keys) {
      const parsed = pushSubscriptionSchema.safeParse(
        await bb.storage.kv.get<unknown>(key),
      );
      if (!parsed.success) {
        bb.log.warn(
          `Ignored invalid push subscription row ${key.slice(SUBSCRIPTION_KEY_PREFIX.length)}`,
        );
        continue;
      }
      subscriptions.push(parsed.data);
    }
    return subscriptions.sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
  }

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    add(input) {
      return mutate(async () => {
        const subscriptions = await readAll();
        const existing = subscriptions.find(
          (subscription) =>
            subscription.expoPushToken === input.expoPushToken,
        );
        const timestamp = now();
        if (existing) {
          const updated: PushSubscription = {
            ...existing,
            deviceLabel: input.deviceLabel,
            platform: input.platform,
            lastSeenAt: Math.max(timestamp, existing.lastSeenAt),
          };
          await bb.storage.kv.set(
            `${SUBSCRIPTION_KEY_PREFIX}${existing.id}`,
            updated,
          );
          return { id: existing.id, created: false };
        }
        const id = createId();
        const created: PushSubscription = {
          id,
          expoPushToken: input.expoPushToken,
          platform: input.platform,
          deviceLabel: input.deviceLabel,
          createdAt: timestamp,
          lastSeenAt: timestamp,
        };
        await bb.storage.kv.set(`${SUBSCRIPTION_KEY_PREFIX}${id}`, created);
        return { id, created: true };
      });
    },
    async list() {
      await mutationQueue;
      return readAll();
    },
    async listSummaries() {
      await mutationQueue;
      const subscriptions = await readAll();
      return subscriptions.map(({ expoPushToken, ...subscription }) => ({
        ...subscription,
        tokenSuffix: expoPushToken.slice(-6),
      }));
    },
    remove(id) {
      return mutate(async () => {
        const existing = (await readAll()).some(
          (subscription) => subscription.id === id,
        );
        if (!existing) return false;
        await bb.storage.kv.delete(`${SUBSCRIPTION_KEY_PREFIX}${id}`);
        return true;
      });
    },
  };
}
