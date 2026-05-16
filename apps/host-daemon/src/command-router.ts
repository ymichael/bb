import type {
  HostDaemonCommand,
  HostDaemonCommandEnvelope,
  HostDaemonCommandResultReportWithoutSession,
} from "@bb/host-daemon-contract";
import { shouldFlushEventsBeforeReportingCommandResult } from "@bb/host-daemon-contract";
import {
  dispatchCommand,
  getErrorCode,
  type CommandDispatchOptions,
} from "./command-dispatch.js";
import { isExpectedCommandDispatchError } from "./command-dispatch-support.js";
import type { HostDaemonLogger } from "./logger.js";
import { RuntimeManager } from "./runtime-manager.js";

type CommandResultReport = HostDaemonCommandResultReportWithoutSession;

interface PendingCommandResultReport {
  command: HostDaemonCommand;
  result: CommandResultReport;
}

type EnvironmentLaneMode = "read" | "write";

interface EnvironmentLaneState {
  /** All admitted read and write work. Writes wait on this tail. */
  tail: Promise<void>;
  /** Last admitted write. Reads wait on this tail, then join `tail`. */
  writeTail: Promise<void>;
}

export interface CommandRouterOptions {
  dataDir: CommandDispatchOptions["dataDir"];
  fetchProjectAttachment: CommandDispatchOptions["fetchProjectAttachment"];
  fetchRuntimeMaterial: CommandDispatchOptions["fetchRuntimeMaterial"];
  readPersistedRuntimeMaterial: CommandDispatchOptions["readPersistedRuntimeMaterial"];
  persistRuntimeMaterial: CommandDispatchOptions["persistRuntimeMaterial"];
  runtimeManager: RuntimeManager;
  terminalManager?: CommandDispatchOptions["terminalManager"];
  reportResult?: (result: CommandResultReport) => Promise<void>;
  eventSink: CommandDispatchOptions["eventSink"];
  listModels?: CommandDispatchOptions["listModels"];
  resolveInteractiveRequest?: CommandDispatchOptions["resolveInteractiveRequest"];
  recordReplayCaptureThreadMetadata?: CommandDispatchOptions["recordReplayCaptureThreadMetadata"];
  recordReplayCaptureTurnRequest?: CommandDispatchOptions["recordReplayCaptureTurnRequest"];
  replayTasks?: CommandDispatchOptions["replayTasks"];
  threadStorageRootPath: string;
  logger: Pick<HostDaemonLogger, "warn">;
  now?: () => number;
}

export class CommandRouter {
  private readonly reportResult;
  private readonly logger;
  private readonly now;
  private readonly environmentLanes = new Map<string, EnvironmentLaneState>();
  private hostRuntimeMaterialLane: Promise<void> = Promise.resolve();
  // Stale failed reports retry in the background after the current result is
  // reported, so one permanently failing result cannot block newer completions.
  private readonly pendingResults: PendingCommandResultReport[] = [];
  private pendingRetryPromise: Promise<void> | null = null;
  private reportingPromise: Promise<void> = Promise.resolve();

  constructor(private readonly options: CommandRouterOptions) {
    this.reportResult = options.reportResult ?? (async () => undefined);
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  async handleCommands(commands: HostDaemonCommandEnvelope[]): Promise<void> {
    const tasks = commands.map((command) => this.dispatchEnvelope(command));
    await Promise.all(tasks);
    await this.reportingPromise;
  }

  private async dispatchEnvelope(
    envelope: HostDaemonCommandEnvelope,
  ): Promise<void> {
    let task: Promise<CommandResultReport>;
    const environmentLaneMode = this.getEnvironmentLaneMode(envelope.command);
    if (envelope.command.type === "host.sync_runtime_material") {
      task = this.runInHostRuntimeMaterialLane(() =>
        this.executeCommand(envelope),
      );
    } else if (environmentLaneMode && "environmentId" in envelope.command) {
      const { environmentId } = envelope.command;
      if (!environmentId) {
        throw new Error(
          `Command ${envelope.command.type} is missing environmentId`,
        );
      }
      task = this.runInEnvironmentLane(environmentId, environmentLaneMode, () =>
        this.executeCommand(envelope),
      );
    } else {
      task = this.executeCommand(envelope);
    }

    const result = await task;
    const report: PendingCommandResultReport = {
      command: envelope.command,
      result,
    };
    this.reportingPromise = this.reportingPromise
      .then(async () => {
        await this.reportCommandResult(report);
        this.schedulePendingResultRetry();
      })
      .catch((error) => {
        this.pendingResults.push(report);
        this.logger.warn(
          { err: error },
          "failed to report command result, will retry on next completion",
        );
      });
    await this.reportingPromise;
  }

  private runInHostRuntimeMaterialLane<T>(work: () => Promise<T>): Promise<T> {
    const next = this.hostRuntimeMaterialLane.catch(() => undefined).then(work);
    this.hostRuntimeMaterialLane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private schedulePendingResultRetry(): void {
    if (this.pendingResults.length === 0 || this.pendingRetryPromise) {
      return;
    }
    // This intentionally runs outside `reportingPromise`. Recovery may report
    // stale results after a newer result when a previous failure unblocks.
    const retryPromise = this.retryPendingResults().finally(() => {
      if (this.pendingRetryPromise === retryPromise) {
        this.pendingRetryPromise = null;
      }
    });
    this.pendingRetryPromise = retryPromise;
  }

  private async retryPendingResults(): Promise<void> {
    while (this.pendingResults.length > 0) {
      const report = this.pendingResults[0];
      if (!report) {
        return;
      }
      try {
        await this.reportCommandResult(report);
        this.pendingResults.shift();
      } catch (error) {
        this.logger.warn(
          { err: error },
          "failed to report pending command result, will retry on next completion",
        );
        return;
      }
    }
  }

  private async reportCommandResult(
    report: PendingCommandResultReport,
  ): Promise<void> {
    // Commands that can emit thread events before completing keep the old
    // event-before-result ordering. Pure reads and host-local commands skip the
    // router flush so an in-flight event POST cannot deadlock while waiting for
    // a nested command result.
    if (shouldFlushEventsBeforeReportingCommandResult(report.command)) {
      await this.options.eventSink.flush();
    }
    await this.reportResult(report.result);
  }

  private runInEnvironmentLane<T>(
    environmentId: string,
    mode: EnvironmentLaneMode,
    work: () => Promise<T>,
  ): Promise<T> {
    if (mode === "read") {
      return this.runInEnvironmentReadLane(environmentId, work);
    }
    return this.runInEnvironmentWriteLane(environmentId, work);
  }

  private async executeCommand(
    envelope: HostDaemonCommandEnvelope,
  ): Promise<CommandResultReport> {
    const baseReport = {
      commandId: envelope.id,
      type: envelope.command.type,
    };

    try {
      const result = await dispatchCommand(envelope.command, {
        fetchRuntimeMaterial: this.options.fetchRuntimeMaterial,
        fetchProjectAttachment: this.options.fetchProjectAttachment,
        readPersistedRuntimeMaterial: this.options.readPersistedRuntimeMaterial,
        persistRuntimeMaterial: this.options.persistRuntimeMaterial,
        runtimeManager: this.options.runtimeManager,
        terminalManager: this.options.terminalManager,
        dataDir: this.options.dataDir,
        eventSink: this.options.eventSink,
        listModels: this.options.listModels,
        resolveInteractiveRequest: this.options.resolveInteractiveRequest,
        recordReplayCaptureThreadMetadata:
          this.options.recordReplayCaptureThreadMetadata,
        recordReplayCaptureTurnRequest:
          this.options.recordReplayCaptureTurnRequest,
        replayTasks: this.options.replayTasks,
        threadStorageRootPath: this.options.threadStorageRootPath,
      });
      return {
        ...baseReport,
        completedAt: this.now(),
        ok: true,
        result,
      };
    } catch (error) {
      const errorCode = getErrorCode(error);
      if (!isExpectedCommandDispatchError(error)) {
        this.logger.warn(
          {
            err: error,
            commandId: envelope.id,
            type: envelope.command.type,
          },
          "command execution failed",
        );
      }
      return {
        ...baseReport,
        completedAt: this.now(),
        ok: false,
        errorCode,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getOrCreateEnvironmentLane(
    environmentId: string,
  ): EnvironmentLaneState {
    const existing = this.environmentLanes.get(environmentId);
    if (existing) {
      return existing;
    }
    const resolved = Promise.resolve();
    const state: EnvironmentLaneState = {
      tail: resolved,
      writeTail: resolved,
    };
    this.environmentLanes.set(environmentId, state);
    return state;
  }

  private runInEnvironmentReadLane<T>(
    environmentId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const state = this.getOrCreateEnvironmentLane(environmentId);
    const previousWrite = state.writeTail;
    const next = previousWrite.catch(() => undefined).then(work);
    const done = next.then(
      () => undefined,
      () => undefined,
    );
    const previousTail = state.tail;
    // Reads only wait for earlier writes, so adjacent reads can run together.
    // They still join the full tail so later writes wait for every active read.
    const tail = Promise.all([
      previousTail.catch(() => undefined),
      done,
    ]).then(() => undefined);
    state.tail = tail;
    this.deleteEnvironmentLaneWhenIdle(environmentId, state, tail);
    return next;
  }

  private runInEnvironmentWriteLane<T>(
    environmentId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const state = this.getOrCreateEnvironmentLane(environmentId);
    const next = state.tail.catch(() => undefined).then(work);
    const done = next.then(
      () => undefined,
      () => undefined,
    );
    state.tail = done;
    state.writeTail = done;
    this.deleteEnvironmentLaneWhenIdle(environmentId, state, done);
    return next;
  }

  private deleteEnvironmentLaneWhenIdle(
    environmentId: string,
    state: EnvironmentLaneState,
    tail: Promise<void>,
  ): void {
    void tail.then(() => {
      if (
        this.environmentLanes.get(environmentId) === state &&
        state.tail === tail
      ) {
        this.environmentLanes.delete(environmentId);
      }
    });
  }

  private getEnvironmentLaneMode(
    command: HostDaemonCommandEnvelope["command"],
  ): EnvironmentLaneMode | null {
    // Execution lanes protect per-environment workspace mutation ordering.
    // `shouldFlushEventsBeforeReportingCommandResult` is a separate
    // event-before-result ordering policy in the host-daemon contract.
    switch (command.type) {
      case "workspace.status":
      case "workspace.diff":
        return "read";
      case "environment.provision":
      case "environment.destroy":
      case "thread.archive":
      case "workspace.commit":
      case "workspace.squash_merge":
        return "write";
      default:
        return null;
    }
  }
}
