import type {
  PendingInteractionCreate,
  PendingInteractionResolution,
} from "@bb/domain";
import type {
  HostDaemonInteractiveRequestResponse,
} from "@bb/host-daemon-contract";

const DELIVERED_INTERACTIVE_REQUEST_TOMBSTONE_TTL_MS = 5 * 60 * 1000;

export interface InteractiveResolveCommandInput {
  interactionId: string;
  providerId: string;
  providerRequestId: string;
  providerThreadId: string;
  resolution: PendingInteractionResolution;
  threadId: string;
}

export interface InteractiveRequestRegistrationFailure {
  error: Error;
  request: PendingInteractionCreate;
}

export interface InteractiveRequestRegistryOptions {
  onRegistrationFailure?: (
    failure: InteractiveRequestRegistrationFailure,
  ) => void;
  registerRequest: (
    request: PendingInteractionCreate,
  ) => Promise<HostDaemonInteractiveRequestResponse>;
}

export interface InterruptInteractiveThreadsArgs {
  providerId: string;
  reason: string;
  threadIds: readonly string[];
}

interface PendingInteractiveRequestEntry {
  interactionId: string | null;
  promise: Promise<PendingInteractionResolution>;
  reject: (error: Error) => void;
  resolve: (resolution: PendingInteractionResolution) => void;
  request: PendingInteractionCreate;
}

interface DeliveredInteractiveRequestTombstone {
  timeout: ReturnType<typeof setTimeout>;
}

export class InteractiveRequestRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InteractiveRequestRegistryError";
  }
}

function buildInteractiveRequestKey(
  request: Pick<
    PendingInteractionCreate,
    "providerId" | "providerRequestId" | "providerThreadId" | "threadId"
  >,
): string {
  return [
    request.threadId,
    request.providerId,
    request.providerThreadId,
    request.providerRequestId,
  ].join("\0");
}

function buildDeliveredTombstoneKey(
  request: Pick<
    InteractiveResolveCommandInput,
    "interactionId" | "providerId" | "providerRequestId" | "providerThreadId" | "threadId"
  >,
): string {
  return [
    request.interactionId,
    request.threadId,
    request.providerId,
    request.providerThreadId,
    request.providerRequestId,
  ].join("\0");
}

export class InteractiveRequestRegistry {
  private readonly deliveredTombstones = new Map<
    string,
    DeliveredInteractiveRequestTombstone
  >();
  private readonly pendingEntries = new Map<string, PendingInteractiveRequestEntry>();

  constructor(private readonly options: InteractiveRequestRegistryOptions) {}

  async registerAndWait(
    request: PendingInteractionCreate,
  ): Promise<PendingInteractionResolution> {
    const key = buildInteractiveRequestKey(request);
    const existing = this.pendingEntries.get(key);
    if (existing) {
      return existing.promise;
    }

    let resolveEntry: (resolution: PendingInteractionResolution) => void = () => {};
    let rejectEntry: (error: Error) => void = () => {};
    const promise = new Promise<PendingInteractionResolution>((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });
    const entry: PendingInteractiveRequestEntry = {
      interactionId: null,
      promise,
      reject: (error) => rejectEntry(error),
      resolve: (resolution) => resolveEntry(resolution),
      request,
    };
    this.pendingEntries.set(key, entry);

    try {
      const response = await this.options.registerRequest(request);
      if (response.outcome === "rejected") {
        this.pendingEntries.delete(key);
        entry.reject(new Error(response.reason));
        return promise;
      }

      entry.interactionId = response.interactionId;
      if (
        response.status !== "pending"
        && response.status !== "resolving"
      ) {
        this.pendingEntries.delete(key);
        entry.reject(
          new Error(
            `Pending interaction ${response.interactionId} is already ${response.status}`,
          ),
        );
      }
    } catch (error) {
      this.pendingEntries.delete(key);
      const registrationError = error instanceof Error
        ? error
        : new Error(String(error));
      this.options.onRegistrationFailure?.({
        error: registrationError,
        request,
      });
      entry.reject(registrationError);
    }

    return promise;
  }

  resolve(request: InteractiveResolveCommandInput): void {
    const key = buildInteractiveRequestKey(request);
    const tombstoneKey = buildDeliveredTombstoneKey(request);
    if (this.deliveredTombstones.has(tombstoneKey)) {
      return;
    }

    const entry = this.pendingEntries.get(key);
    if (!entry) {
      throw new InteractiveRequestRegistryError(
        "stale_interactive_request",
        `Interactive request ${request.interactionId} is no longer awaiting a provider response`,
      );
    }
    if (
      entry.interactionId !== null
      && entry.interactionId !== request.interactionId
    ) {
      throw new InteractiveRequestRegistryError(
        "interactive_request_mismatch",
        `Interactive request ${request.interactionId} does not match registered interaction ${entry.interactionId}`,
      );
    }

    this.pendingEntries.delete(key);
    this.addDeliveredTombstone(tombstoneKey);
    entry.resolve(request.resolution);
  }

  interruptThreads(args: InterruptInteractiveThreadsArgs): void {
    const threadIds = new Set(args.threadIds);
    for (const [key, entry] of this.pendingEntries) {
      if (
        entry.request.providerId !== args.providerId
        || !threadIds.has(entry.request.threadId)
      ) {
        continue;
      }

      this.pendingEntries.delete(key);
      entry.reject(new Error(args.reason));
    }
  }

  private addDeliveredTombstone(key: string): void {
    const existing = this.deliveredTombstones.get(key);
    if (existing) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => {
      this.deliveredTombstones.delete(key);
    }, DELIVERED_INTERACTIVE_REQUEST_TOMBSTONE_TTL_MS);
    timeout.unref();
    this.deliveredTombstones.set(key, { timeout });
  }
}
