import fs from "node:fs/promises";
import path from "node:path";
import type {
  ParcelAsyncSubscription,
  ParcelWatcherBackend,
} from "../../src/parcel-watcher-backend.js";
import { realParcelWatcher } from "../../src/real-parcel-watcher.js";
import { RESCAN_REQUIRED_MESSAGE } from "../../src/watch-recovery.js";
import type { ParentToChildMessage } from "../../src/parcel-subprocess/messages.js";
import { createParcelChildHandler } from "../../src/parcel-subprocess/parcel-child-handler.js";

const faultRoot = process.env.BB_WATCHER_BENCHMARK_FAULT_ROOT;
const triggerPath = process.env.BB_WATCHER_BENCHMARK_TRIGGER_PATH;

if (!faultRoot || !triggerPath) {
  throw new Error("Watcher recovery benchmark fault paths are required");
}

const canonicalTriggerPath = await fs.realpath(triggerPath);

type TelemetryEvent =
  | "fault-injected"
  | "list-entries-complete"
  | "native-subscribe-ready"
  | "native-subscribe-start"
  | "native-unsubscribe-ready"
  | "native-unsubscribe-start";

function sendTelemetry(
  event: TelemetryEvent,
  rootPath: string,
  entryCount?: number,
): void {
  process.send?.({
    kind: "benchmark-telemetry",
    event,
    rootPath,
    ...(entryCount === undefined ? {} : { entryCount }),
  });
}

let affectedSubscriptionEpoch = 0;
let armedSubscriptionEpoch = 0;

const benchmarkParcel: ParcelWatcherBackend = {
  async subscribe(dir, callback, opts): Promise<ParcelAsyncSubscription> {
    const normalizedDir = path.resolve(dir);
    const isAffected = normalizedDir === path.resolve(faultRoot);
    const subscriptionEpoch = isAffected ? (affectedSubscriptionEpoch += 1) : 0;
    sendTelemetry("native-subscribe-start", normalizedDir);
    const subscription = await realParcelWatcher.subscribe(
      dir,
      (error, events) => {
        const includesTrigger = events.some((event) => {
          const eventPath = path.isAbsolute(event.path)
            ? path.normalize(event.path)
            : path.resolve(dir, event.path);
          return eventPath === canonicalTriggerPath;
        });
        if (!error && isAffected && includesTrigger) {
          if (subscriptionEpoch !== armedSubscriptionEpoch) {
            return;
          }
          armedSubscriptionEpoch = 0;
          sendTelemetry("fault-injected", normalizedDir);
          callback(
            new Error(
              `Events were dropped by the FSEvents client. ${RESCAN_REQUIRED_MESSAGE}.`,
            ),
            [],
          );
          return;
        }
        callback(error, events);
      },
      opts,
    );
    if (isAffected) {
      armedSubscriptionEpoch = subscriptionEpoch;
    }
    sendTelemetry("native-subscribe-ready", normalizedDir);
    return {
      async unsubscribe() {
        sendTelemetry("native-unsubscribe-start", normalizedDir);
        await subscription.unsubscribe();
        sendTelemetry("native-unsubscribe-ready", normalizedDir);
      },
    };
  },
};

const handler = createParcelChildHandler({
  parcel: benchmarkParcel,
  send: (message) => {
    process.send?.(message);
  },
  listEntries: async (dir) => {
    const entries = await fs.readdir(dir);
    sendTelemetry("list-entries-complete", path.resolve(dir), entries.length);
    return entries;
  },
});

process.on("message", (message: unknown) => {
  handler.handleMessage(message as ParentToChildMessage);
});

process.on("disconnect", () => {
  void handler.dispose().finally(() => process.exit(0));
});

process.send?.({ kind: "ready" });
