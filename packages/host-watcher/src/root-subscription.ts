import { calculateExponentialBackoffDelay } from "@bb/domain";
import {
  getParcelWatcherBackend,
  type ParcelAsyncSubscription,
  type ParcelWatcherError,
  type ParcelWatcherEventBatch,
  type ParcelWatcherSubscribeOptions,
} from "./parcel-watcher-backend.js";
import { pathExists } from "./path-exists.js";
import { isRescanRequiredMessage } from "./watch-recovery.js";
import { toWatchErrorMessage } from "./watch-error.js";

export type {
  ParcelWatcherEventBatch,
  ParcelWatcherSubscribeOptions,
} from "./parcel-watcher-backend.js";

interface RootSubscriptionArgs {
  rootPath: string;
  subscribeOptions?: ParcelWatcherSubscribeOptions;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  onEvents: (events: ParcelWatcherEventBatch) => void;
  onReady?: () => void;
  onDroppedEvents: () => void;
  onWatchError: (message: string) => void;
}

export class RootSubscription {
  private disposed = false;
  private subscription: ParcelAsyncSubscription | null = null;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private warned = false;
  private recoveryPending = false;
  private readonly pendingStarts = new Set<Promise<void>>();
  private readonly pendingStops = new Set<Promise<void>>();

  constructor(private readonly args: RootSubscriptionArgs) {}

  start(): void {
    const pendingStart = this.startAsync().finally(() => {
      this.pendingStarts.delete(pendingStart);
    });
    this.pendingStarts.add(pendingStart);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.subscription !== null) {
      const subscription = this.subscription;
      this.subscription = null;
      this.stopSubscription(subscription);
    }
    await Promise.all([...this.pendingStarts]);
    await this.awaitPendingStops();
  }

  private async awaitPendingStops(): Promise<void> {
    while (this.pendingStops.size > 0) {
      await Promise.all([...this.pendingStops]);
    }
  }

  private stopSubscription(subscription: ParcelAsyncSubscription): void {
    const pendingStop = subscription
      .unsubscribe()
      .catch(() => {})
      .finally(() => {
        this.pendingStops.delete(pendingStop);
      });
    this.pendingStops.add(pendingStop);
  }

  private reportWatchError(message: string): void {
    if (this.warned) {
      return;
    }
    this.warned = true;
    this.args.onWatchError(message);
  }

  private scheduleRetry(): void {
    if (
      this.disposed ||
      this.retryTimer !== null ||
      this.subscription !== null
    ) {
      return;
    }
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.start();
      },
      calculateExponentialBackoffDelay({
        attempt: this.retryAttempt,
        baseDelayMs: this.args.retryDelayMs,
        maxDelayMs: this.args.maxRetryDelayMs,
      }),
    );
  }

  private handleRecoverableSubscriptionFailure(): void {
    if (this.subscription !== null) {
      const subscription = this.subscription;
      this.subscription = null;
      this.stopSubscription(subscription);
    }
    this.scheduleRetry();
  }

  private async startAsync(): Promise<void> {
    if (this.disposed || this.subscription !== null) {
      return;
    }

    if (!(await pathExists(this.args.rootPath))) {
      this.reportWatchError(
        `Watched path does not exist yet: ${this.args.rootPath}`,
      );
      this.scheduleRetry();
      return;
    }
    if (this.disposed) {
      return;
    }

    try {
      let recoverableFailureObserved = false;
      let terminalFailureObserved = false;
      const subscription = await getParcelWatcherBackend().subscribe(
        this.args.rootPath,
        (error: ParcelWatcherError, events: ParcelWatcherEventBatch) => {
          if (this.disposed) {
            return;
          }
          if (error) {
            const message = toWatchErrorMessage(error);
            if (isRescanRequiredMessage(message)) {
              recoverableFailureObserved = true;
              this.recoveryPending = true;
              this.args.onDroppedEvents();
              this.handleRecoverableSubscriptionFailure();
              return;
            }
            terminalFailureObserved = true;
            this.reportWatchError(message);
            this.subscription = null;
            return;
          }
          this.args.onEvents(events);
        },
        this.args.subscribeOptions,
      );
      if (this.disposed) {
        if (!terminalFailureObserved) {
          this.stopSubscription(subscription);
        }
        return;
      }
      if (recoverableFailureObserved) {
        this.stopSubscription(subscription);
        return;
      }
      if (terminalFailureObserved) {
        return;
      }
      this.warned = false;
      this.retryAttempt = 0;
      this.subscription = subscription;
      if (this.recoveryPending) {
        this.recoveryPending = false;
        this.args.onDroppedEvents();
      } else {
        this.args.onReady?.();
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.reportWatchError(toWatchErrorMessage(error));
      this.scheduleRetry();
    }
  }
}
