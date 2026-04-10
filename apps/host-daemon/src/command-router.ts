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

type CommandResultReport = Omit<HostDaemonCommandResultReport, "sessionId">;

export interface CommandRouterOptions {
  fetchRuntimeMaterial: CommandDispatchOptions["fetchRuntimeMaterial"];
  readPersistedRuntimeMaterial: CommandDispatchOptions["readPersistedRuntimeMaterial"];
  persistRuntimeMaterial: CommandDispatchOptions["persistRuntimeMaterial"];
  runtimeManager: RuntimeManager;
  reportResult?: (result: CommandResultReport) => Promise<void>;
  seedThreadHighWaterMark?: CommandDispatchOptions["seedThreadHighWaterMark"];
  eventSink?: CommandDispatchOptions["eventSink"];
  listModels?: CommandDispatchOptions["listModels"];
  threadStorageRootPath: string;
  logger: Pick<HostDaemonLogger, "warn">;
  now?: () => number;
}

export class CommandRouter {
  private readonly reportResult;
  private readonly logger;
  private readonly now;
  private readonly environmentLanes = new Map<string, Promise<unknown>>();
  private hostRuntimeMaterialLane: Promise<unknown> = Promise.resolve();
  private readonly pendingResults: CommandResultReport[] = [];
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
    if (
      envelope.command.type === "host.sync_runtime_material"
    ) {
      task = this.runInHostRuntimeMaterialLane(
        () => this.executeCommand(envelope),
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
    this.reportingPromise = this.reportingPromise
      .then(async () => {
        await this.drainPending();
        await this.reportResult(result);
      })
      .catch((error) => {
        this.pendingResults.push(result);
        this.logger.warn(
          { err: error },
          "failed to report command result, will retry on next completion",
        );
      });
    await this.reportingPromise;
  }

  private runInHostRuntimeMaterialLane<T>(
    work: () => Promise<T>,
  ): Promise<T> {
    const next = this.hostRuntimeMaterialLane.catch(() => undefined).then(work);
    this.hostRuntimeMaterialLane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async drainPending(): Promise<void> {
    while (this.pendingResults.length > 0) {
      const result = this.pendingResults[0];
      if (!result) {
        return;
      }
      await this.reportResult(result);
      this.pendingResults.shift();
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
  ): Promise<CommandResultReport> {
    const baseReport: Pick<CommandResultReport, "commandId" | "type"> = {
      commandId: envelope.id,
      type: envelope.command.type,
    };

    try {
      const result = await dispatchCommand(envelope.command, {
        fetchRuntimeMaterial: this.options.fetchRuntimeMaterial,
        readPersistedRuntimeMaterial: this.options.readPersistedRuntimeMaterial,
        persistRuntimeMaterial: this.options.persistRuntimeMaterial,
        runtimeManager: this.options.runtimeManager,
        seedThreadHighWaterMark: this.options.seedThreadHighWaterMark,
        eventSink: this.options.eventSink,
        listModels: this.options.listModels,
        threadStorageRootPath: this.options.threadStorageRootPath,
      });
      return {
        ...baseReport,
        completedAt: this.now(),
        ok: true,
        result,
      };
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          commandId: envelope.id,
          type: envelope.command.type,
        },
        "command execution failed",
      );
      return {
        ...baseReport,
        completedAt: this.now(),
        ok: false,
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
