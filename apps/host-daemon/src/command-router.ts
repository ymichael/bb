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
  private readonly environmentLanes = new Map<string, Promise<void>>();
  private hostRuntimeMaterialLane: Promise<void> = Promise.resolve();
  private readonly pendingResults: PendingCommandResultReport[] = [];
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
    if (envelope.command.type === "host.sync_runtime_material") {
      task = this.runInHostRuntimeMaterialLane(() =>
        this.executeCommand(envelope),
      );
    } else if (
      this.requiresWorkspaceLane(envelope.command.type) &&
      "environmentId" in envelope.command
    ) {
      const { environmentId } = envelope.command;
      if (!environmentId) {
        throw new Error(
          `Command ${envelope.command.type} is missing environmentId`,
        );
      }
      task = this.runInEnvironmentLane(environmentId, () =>
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
    if (envelope.command.type === "environment.destroy" && result.ok) {
      this.environmentLanes.delete(envelope.command.environmentId);
    }
    this.reportingPromise = this.reportingPromise
      .then(async () => {
        await this.drainPending();
        await this.reportCommandResult(report);
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

  private async drainPending(): Promise<void> {
    while (this.pendingResults.length > 0) {
      const report = this.pendingResults[0];
      if (!report) {
        return;
      }
      await this.reportCommandResult(report);
      this.pendingResults.shift();
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
    work: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.environmentLanes.get(environmentId) ?? Promise.resolve();
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

  private requiresWorkspaceLane(
    type: HostDaemonCommandEnvelope["command"]["type"],
  ): boolean {
    return (
      type === "environment.provision" ||
      type === "environment.destroy" ||
      type === "thread.archive" ||
      type.startsWith("workspace.")
    );
  }
}
