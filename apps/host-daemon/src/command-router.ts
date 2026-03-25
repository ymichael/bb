import type {
  HostDaemonCommandEnvelope,
  HostDaemonCommandResultReport,
} from "@bb/host-daemon-contract";
import {
  dispatchCommand,
  getErrorCode,
  type CommandDispatchOptions,
} from "./command-dispatch.js";
import type { HostDaemonLogger } from "./logger.js";
import { RuntimeManager } from "./runtime-manager.js";

type RoutedCommandResult = Omit<HostDaemonCommandResultReport, "sessionId">;

export interface CommandRouterOptions {
  runtimeManager: RuntimeManager;
  reportResult?: (result: RoutedCommandResult) => Promise<void>;
  resolveThreadRuntime?: CommandDispatchOptions["resolveThreadRuntime"];
  listModels?: CommandDispatchOptions["listModels"];
  logger: Pick<HostDaemonLogger, "warn">;
  now?: () => number;
  initialCursor?: number;
}

export class CommandRouter {
  private readonly reportResult;
  private readonly logger;
  private readonly now;
  private readonly environmentLanes = new Map<string, Promise<unknown>>();
  private readonly completedResults = new Map<number, RoutedCommandResult>();
  private lastReportedCursor = 0;
  private reportingPromise: Promise<void> = Promise.resolve();

  constructor(private readonly options: CommandRouterOptions) {
    this.reportResult = options.reportResult ?? (async () => undefined);
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.lastReportedCursor = options.initialCursor ?? 0;
  }

  async handleCommands(commands: HostDaemonCommandEnvelope[]): Promise<void> {
    const tasks = commands.map((command) => this.dispatchEnvelope(command));
    await Promise.all(tasks);
    await this.reportingPromise;
  }

  private async dispatchEnvelope(
    envelope: HostDaemonCommandEnvelope,
  ): Promise<void> {
    let task: Promise<RoutedCommandResult>;
    if (this.requiresWorkspaceLane(envelope.command.type)) {
      const environmentId = envelope.command.environmentId;
      if (!environmentId) {
        throw new Error(
          `Command ${envelope.command.type} is missing environmentId`,
        );
      }
      task = this.runInEnvironmentLane(
        environmentId,
        () => this.executeCommand(envelope),
      );
    } else {
      task = this.executeCommand(envelope);
    }

    const result = await task;
    if (envelope.command.type === "environment.destroy" && result.ok) {
      this.environmentLanes.delete(envelope.command.environmentId);
    }
    this.recordCompletedResult(envelope.cursor, result);
    this.reportingPromise = this.reportingPromise
      .then(() => this.flushCompleted())
      .catch((error) => {
        this.logger.warn(
          { err: error },
          "failed to report command results, will retry on next completion",
        );
      });
    await this.reportingPromise;
  }

  private recordCompletedResult(
    cursor: number,
    result: RoutedCommandResult,
  ): void {
    const pendingCount = this.completedResults.size;
    if (cursor > this.lastReportedCursor + pendingCount + 1) {
      this.logger.warn(
        {
          cursor,
          lastReportedCursor: this.lastReportedCursor,
        },
        "gap detected in command cursor sequence",
      );
    }
    this.completedResults.set(cursor, result);
  }

  private async flushCompleted(): Promise<void> {
    while (this.completedResults.has(this.lastReportedCursor + 1)) {
      const nextCursor = this.lastReportedCursor + 1;
      const result = this.completedResults.get(nextCursor);
      if (!result) {
        break;
      }
      await this.reportResult(result);
      this.completedResults.delete(nextCursor);
      this.lastReportedCursor = nextCursor;
    }
  }

  private runInEnvironmentLane<T>(
    environmentId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.environmentLanes.get(environmentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.environmentLanes.set(
      environmentId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async executeCommand(
    envelope: HostDaemonCommandEnvelope,
  ): Promise<RoutedCommandResult> {
    const baseResult = {
      commandId: envelope.id,
      cursor: envelope.cursor,
      type: envelope.command.type,
    } as const;

    try {
      const result = await dispatchCommand(envelope.command, {
        runtimeManager: this.options.runtimeManager,
        resolveThreadRuntime: this.options.resolveThreadRuntime,
        listModels: this.options.listModels,
      });
      return {
        ...baseResult,
        completedAt: this.now(),
        ok: true as const,
        result,
      };
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          commandId: envelope.id,
          cursor: envelope.cursor,
          type: envelope.command.type,
        },
        "command execution failed",
      );
      return {
        ...baseResult,
        completedAt: this.now(),
        ok: false as const,
        errorCode: getErrorCode(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private requiresWorkspaceLane(type: HostDaemonCommandEnvelope["command"]["type"]): boolean {
    return (
      type === "environment.provision" ||
      type === "environment.destroy" ||
      type.startsWith("workspace.")
    );
  }
}
