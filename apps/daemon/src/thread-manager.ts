import { spawn, type ChildProcess } from "node:child_process";
import type {
  AvailableModel,
  SystemProviderInfo,
  Thread,
  ThreadEvent,
  PromptInput,
  SpawnThreadRequest,
  TellThreadRequest,
} from "@beanbag/core";
import type {
  ThreadRepository,
  EventRepository,
  ProjectRepository,
} from "@beanbag/db";
import { WSManager } from "./ws.js";
import { createCodexProviderAdapter } from "./codex-provider-adapter.js";
import type {
  ProviderAdapter,
  ProviderExecutionOptions,
} from "./provider-adapter.js";
import {
  ProviderRuntime,
  ProviderRuntimeRpcError,
  ProviderRuntimeTimeoutError,
  ProviderRuntimeUnavailableError,
} from "./provider-runtime.js";
import {
  inactiveSessionError,
  invalidRequestError,
  noActiveTurnError,
  projectNotFoundError,
  providerRpcError,
  providerTimeoutError,
  providerUnavailableError,
  threadProvisioningError,
  threadProvisioningFailedError,
  threadArchivedError,
  threadNotFoundError,
  unsupportedOperationError,
} from "./domain-errors.js";

export type PromptExecutionOptions = ProviderExecutionOptions;

export class ThreadManager {
  private processes = new Map<string, ChildProcess>();
  private runtimes = new Map<string, ProviderRuntime>();
  /** Maps our internal thread ID to the provider thread ID */
  private providerThreadIds = new Map<string, string>();
  /** Tracks the currently active provider turn ID for each thread (when known). */
  private activeTurnIds = new Map<string, string>();
  /** Threads explicitly titled by the caller should not be overwritten by event heuristics. */
  private lockedTitleThreadIds = new Set<string>();
  /** Ensure auto-title generation runs at most once per thread. */
  private autoTitleAttemptedThreadIds = new Set<string>();
  /** Tracks in-flight provisioning operations by thread ID. */
  private provisioningTasks = new Map<string, Promise<void>>();
  private rpcIdCounter = 0;

  constructor(
    private threadRepo: ThreadRepository,
    private eventRepo: EventRepository,
    private projectRepo: ProjectRepository,
    private ws: WSManager,
    private provider: ProviderAdapter = createCodexProviderAdapter(),
  ) {}

  /**
   * One-time startup reconciliation for persisted thread statuses.
   * - created: reprovision
   * - provisioning: mark failed (interrupted by restart)
   * - active: attempt resume, otherwise demote to idle
   */
  async reconcileActiveThreadsOnBoot(): Promise<void> {
    const createdThreads = this.threadRepo.list({
      status: "created",
      includeArchived: true,
    });
    for (const thread of createdThreads) {
      if (thread.archivedAt !== undefined) {
        this._setThreadStatus(thread.id, "idle");
        continue;
      }
      this._scheduleProvisioning(thread.id, { projectId: thread.projectId });
    }

    const provisioningThreads = this.threadRepo.list({
      status: "provisioning",
      includeArchived: true,
    });
    for (const thread of provisioningThreads) {
      this._cleanupThreadRuntime(thread.id);
      this._setThreadStatus(thread.id, "provisioning_failed");
    }

    const activeThreads = this.threadRepo.list({
      status: "active",
      includeArchived: true,
    });
    if (!Array.isArray(activeThreads) || activeThreads.length === 0) return;

    for (const thread of activeThreads) {
      // Archived threads are never considered running.
      if (thread.archivedAt !== undefined) {
        this.threadRepo.update(thread.id, { status: "idle" });
        this.ws.broadcast("thread", thread.id);
        continue;
      }

      const project = this.projectRepo.getById(thread.projectId);
      const providerThreadId = this._resolvePersistedProviderThreadId(thread.id);
      const latestLifecycle = this._latestTurnLifecycleStatus(thread.id);
      const shouldRemainActive = latestLifecycle === "active";

      if (!project || !providerThreadId || !shouldRemainActive) {
        this.threadRepo.update(thread.id, { status: "idle" });
        this.ws.broadcast("thread", thread.id);
        continue;
      }

      try {
        this._spawnProcess(thread.id, project.rootPath);
        this._sendInitialize(thread.id);
        const resumedThreadId = await this._sendRequestAndAwaitThreadId(
          thread.id,
          this.provider.threadResumeMethod,
          this.provider.createThreadResumeParams(providerThreadId),
        );
        this.providerThreadIds.set(thread.id, resumedThreadId);

        const activeTurnId = this._resolvePersistedActiveTurnId(thread.id);
        if (activeTurnId) {
          this.activeTurnIds.set(thread.id, activeTurnId);
        }
      } catch {
        this._cleanupThreadRuntime(thread.id);
        this.threadRepo.update(thread.id, { status: "idle" });
        this.ws.broadcast("thread", thread.id);
      }
    }
  }

  /**
   * Spawn a new provider child process for the given project.
   * Creates a Thread record, starts the process, sets up event streaming,
   * and optionally sends an initial prompt.
   */
  async spawn(req: SpawnThreadRequest): Promise<Thread> {
    // Validate the project exists.
    const project = this.projectRepo.getById(req.projectId);
    if (!project) {
      throw projectNotFoundError(req.projectId);
    }

    // Create thread record in DB
    const explicitTitle = this._normalizeThreadTitle(req.title);
    const derivedTitle = this.provider.deriveThreadTitle(req.input);
    const threadTitle = explicitTitle ?? derivedTitle;
    const thread = this.threadRepo.create({
      projectId: req.projectId,
      title: threadTitle,
    });
    // Treat only truly custom titles as locked. If caller title matches our
    // normal first-message derivation, keep it mutable so server events can refine it.
    if (explicitTitle && explicitTitle !== derivedTitle) {
      this.lockedTitleThreadIds.add(thread.id);
    }

    this.ws.broadcast("thread", thread.id);
    this._scheduleProvisioning(thread.id, req, { rootPathHint: project.rootPath });
    return thread;
  }

  /**
   * Send a message to an active thread via turn/start or turn/steer JSON-RPC.
   */
  async tell(
    threadId: string,
    request: TellThreadRequest,
    options?: PromptExecutionOptions,
  ): Promise<void> {
    const input = request.input;
    if (input.length === 0) {
      throw invalidRequestError("Tell payload input must be non-empty");
    }

    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }
    if (thread.status === "created" || thread.status === "provisioning") {
      throw threadProvisioningError(threadId);
    }
    if (thread.status === "provisioning_failed") {
      this._scheduleProvisioning(
        threadId,
        {
          projectId: thread.projectId,
          model: options?.model,
          reasoningLevel: options?.reasoningLevel,
        },
        {
          reason: "tell-after-provisioning-failure",
        },
      );
      throw threadProvisioningFailedError(threadId);
    }

    const providerThreadId = await this._ensureProviderSession(threadId, options);
    const tellMode = request.mode ?? "auto";
    const hasExecutionOverrides = Boolean(options?.model || options?.reasoningLevel);
    const activeTurnId =
      this.activeTurnIds.get(threadId) ?? this._resolvePersistedActiveTurnId(threadId);
    if (activeTurnId) {
      this.activeTurnIds.set(threadId, activeTurnId);
    }

    if (!this.provider.generateThreadTitle) {
      const suggestedTitle = this.provider.deriveThreadTitle(input);
      if (suggestedTitle) {
        this._setThreadTitle(threadId, suggestedTitle, {
          onlyIfMissing: true,
        });
      }
    }

    const project = this.projectRepo.getById(thread.projectId);
    if (project) {
      this._maybeAutogenerateThreadTitle(
        threadId,
        project.rootPath,
        providerThreadId,
        input,
      );
    }

    this._setThreadStatus(threadId, "active");

    const steerSupported = Boolean(
      this.provider.turnSteerMethod && this.provider.createTurnSteerParams,
    );
    const shouldUseSteer =
      steerSupported &&
      activeTurnId &&
      (
        tellMode === "steer" ||
        (tellMode === "auto" && !hasExecutionOverrides)
      );

    if (tellMode === "steer") {
      if (!steerSupported) {
        throw unsupportedOperationError(
          `${this.provider.displayName} does not support turn/steer`,
        );
      }
      if (!activeTurnId) {
        throw noActiveTurnError(threadId);
      }
      if (hasExecutionOverrides) {
        throw invalidRequestError(
          "Tell mode 'steer' does not support model or reasoning overrides",
        );
      }
    }

    if (shouldUseSteer && activeTurnId) {
      const steerMsg = {
        jsonrpc: "2.0",
        method: this.provider.turnSteerMethod!,
        id: ++this.rpcIdCounter,
        params: this.provider.createTurnSteerParams!(
          providerThreadId,
          activeTurnId,
          input,
        ),
      };
      this._sendToProcess(threadId, steerMsg);
      return;
    }

    const turnStartMsg = {
      jsonrpc: "2.0",
      method: this.provider.turnStartMethod,
      id: ++this.rpcIdCounter,
      params: this.provider.createTurnStartParams(providerThreadId, input, options),
    };
    this._sendToProcess(threadId, turnStartMsg);
  }

  /**
   * Stop an active thread by killing its process.
   */
  stop(threadId: string): void {
    const child = this.processes.get(threadId);
    if (child) {
      child.kill("SIGTERM");
      // Give it a moment, then force kill
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }

    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      runtime.close(new Error(`[thread ${threadId}] Stopping thread`));
      this.runtimes.delete(threadId);
    }

    this.activeTurnIds.delete(threadId);
    this.threadRepo.update(threadId, { status: "idle" });
    this.ws.broadcast("thread", threadId);
  }

  /**
   * Archive a thread and stop any active process.
   */
  archive(threadId: string): void {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;

    const child = this.processes.get(threadId);
    if (child) {
      child.kill("SIGTERM");
      // Give it a moment, then force kill
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000);
      this.processes.delete(threadId);
    }

    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      runtime.close(new Error(`[thread ${threadId}] Archiving thread`));
      this.runtimes.delete(threadId);
    }

    this.providerThreadIds.delete(threadId);
    this.activeTurnIds.delete(threadId);
    this.threadRepo.update(threadId, {
      status: "idle",
      archivedAt: thread.archivedAt ?? Date.now(),
    });
    this.ws.broadcast("thread", threadId);
  }

  /**
   * Get events for a thread, optionally after a given sequence number.
   */
  getEvents(threadId: string, afterSeq?: number): ThreadEvent[] {
    return this.eventRepo.listByThread(threadId, afterSeq);
  }

  /**
   * Get the final output of a thread — the text from the last agentMessage
   * completion event recognized by the active provider adapter.
   */
  getOutput(threadId: string): string | undefined {
    const allEvents = this.eventRepo.listByThread(threadId);
    // Walk backwards to find the last output event.
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const output = this.provider.outputFromEvent(allEvents[i]);
      if (output !== undefined) return output;
    }
    return undefined;
  }

  /**
   * Get the thread record by id.
   */
  getById(threadId: string): Thread | undefined {
    return this.threadRepo.getById(threadId);
  }

  /**
   * List threads with optional filters.
   */
  list(filters?: { projectId?: string; includeArchived?: boolean }): Thread[] {
    return this.threadRepo.list(filters);
  }

  /**
   * Check if a thread's process is currently active.
   */
  isActive(threadId: string): boolean {
    return this.processes.has(threadId);
  }

  /**
   * Get count of currently active (running) thread processes.
   */
  getActiveCount(): number {
    return this.processes.size;
  }

  /**
   * Get count of threads currently marked as active.
   */
  getRunningCount(): number {
    return this.threadRepo.list({ status: "active" }).length;
  }

  /**
   * List available models from the active provider.
   */
  async listModels(): Promise<AvailableModel[]> {
    return this.provider.listModels();
  }

  getProviderInfo(): SystemProviderInfo {
    return {
      id: this.provider.id,
      displayName: this.provider.displayName,
      capabilities: { ...this.provider.capabilities },
    };
  }

  /**
   * Stop all active processes. Called during graceful shutdown.
   */
  stopAll(): void {
    for (const [threadId, child] of this.processes) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
      this.threadRepo.update(threadId, { status: "idle" });
    }
    for (const runtime of this.runtimes.values()) {
      runtime.close();
    }
    this.runtimes.clear();
    this.processes.clear();
    this.providerThreadIds.clear();
    this.activeTurnIds.clear();
    this.autoTitleAttemptedThreadIds.clear();
    this.provisioningTasks.clear();
  }

  private _scheduleProvisioning(
    threadId: string,
    req: SpawnThreadRequest,
    opts?: { rootPathHint?: string; reason?: string },
  ): void {
    if (this.provisioningTasks.has(threadId)) return;

    const task = this._provisionThread(threadId, req, opts)
      .catch((err) => {
        this._cleanupThreadRuntime(threadId);
        this._setThreadStatus(threadId, "provisioning_failed", true, {
          force: true,
        });
        const message = err instanceof Error ? err.message : String(err);
        const reason = opts?.reason ? ` (${opts.reason})` : "";
        console.error(`[thread ${threadId}] provisioning failed${reason}: ${message}`);
      })
      .finally(() => {
        this.provisioningTasks.delete(threadId);
      });

    this.provisioningTasks.set(threadId, task);
  }

  private async _provisionThread(
    threadId: string,
    req: SpawnThreadRequest,
    opts?: { rootPathHint?: string },
  ): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (thread?.archivedAt !== undefined) return;

    const project = this.projectRepo.getById(req.projectId);
    if (!project) {
      throw projectNotFoundError(req.projectId);
    }

    // Ensure provisioning starts from a clean runtime state.
    this._cleanupThreadRuntime(threadId);
    this._setThreadStatus(threadId, "provisioning", true, {
      force: true,
    });

    this._spawnProcess(threadId, opts?.rootPathHint ?? project.rootPath);
    this._sendInitialize(threadId);

    const providerThreadId = await this._sendRequestAndAwaitThreadId(
      threadId,
      this.provider.threadStartMethod,
      this.provider.createThreadStartParams(req),
    );
    this.providerThreadIds.set(threadId, providerThreadId);

    const initialInput = req.input ?? [];
    this._maybeAutogenerateThreadTitle(
      threadId,
      project.rootPath,
      providerThreadId,
      initialInput,
    );

    if (initialInput.length > 0) {
      this._setThreadStatus(threadId, "active");
      const turnMsg = {
        jsonrpc: "2.0",
        method: this.provider.turnStartMethod,
        id: ++this.rpcIdCounter,
        params: this.provider.createTurnStartParams(
          providerThreadId,
          initialInput,
          req,
        ),
      };
      this._sendToProcess(threadId, turnMsg);
      return;
    }

    this._setThreadStatus(threadId, "idle");
  }

  private _cleanupThreadRuntime(threadId: string): void {
    const child = this.processes.get(threadId);
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore shutdown errors
      }
    }
    this.processes.delete(threadId);

    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      runtime.close();
    }
    this.runtimes.delete(threadId);

    this.providerThreadIds.delete(threadId);
    this.activeTurnIds.delete(threadId);
  }

  private _spawnProcess(threadId: string, cwd: string): void {
    const child = spawn(this.provider.processCommand, this.provider.processArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });

    this.processes.set(threadId, child);
    let seqCounter = this.eventRepo.getLatestSeq(threadId);

    const runtime = new ProviderRuntime({
      threadId,
      child,
      onNotification: (msg) => {
        seqCounter = this._handleProviderNotification(threadId, seqCounter, msg);
      },
      onUnmatchedRpcError: (requestId, errorMessage) => {
        console.error(
          `[thread ${threadId}] Provider RPC error (request ${requestId}):`,
          errorMessage,
        );
      },
      onStderrLine: (line) => {
        console.error(`[thread ${threadId}] stderr: ${line}`);
      },
    });
    this.runtimes.set(threadId, runtime);

    child.on("exit", (code, signal) => {
      this._handleProcessExit(threadId, code, signal);
    });

    child.on("error", (err) => {
      console.error(`[thread ${threadId}] Process error:`, err.message);
      runtime.close(
        new Error(`[thread ${threadId}] Process error: ${err.message}`),
      );
      this._handleProcessExit(threadId, 1, null);
    });
  }

  private _sendInitialize(threadId: string): void {
    const initMsg = {
      jsonrpc: "2.0",
      method: this.provider.initializeMethod,
      id: ++this.rpcIdCounter,
      params: {
        clientInfo: this.provider.clientInfo,
      },
    };
    this._sendToProcess(threadId, initMsg);
  }

  private _resolvePersistedProviderThreadId(threadId: string): string | undefined {
    const indexedLookup =
      typeof this.eventRepo.getLatestProviderThreadId === "function"
        ? this.eventRepo.getLatestProviderThreadId(threadId)
        : undefined;
    if (indexedLookup) return indexedLookup;

    const events = this.eventRepo.listByThread(threadId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      const providerThreadId = this.provider.extractThreadIdFromEventData(
        event.data,
      );
      if (providerThreadId) return providerThreadId;
    }
    return undefined;
  }

  private _resolvePersistedActiveTurnId(threadId: string): string | undefined {
    const latestLifecycle =
      typeof this.eventRepo.getLatestTurnLifecycle === "function"
        ? this.eventRepo.getLatestTurnLifecycle(threadId)
        : undefined;
    if (latestLifecycle) {
      if (
        latestLifecycle.normType === "turn/completed" ||
        latestLifecycle.normType === "turn/end"
      ) {
        return undefined;
      }
      if (
        latestLifecycle.normType === "turn/started" ||
        latestLifecycle.normType === "turn/start"
      ) {
        return latestLifecycle.turnId;
      }
    }

    const events = this.eventRepo.listByThread(threadId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      const normalizedType = this.provider.normalizeEventType(event.type);
      if (normalizedType === "turn/completed" || normalizedType === "turn/end") {
        return undefined;
      }
      if (normalizedType === "turn/started" || normalizedType === "turn/start") {
        return this._extractTurnIdFromEventData(event.data);
      }
    }
    return undefined;
  }

  private _extractTurnIdFromEventData(data: unknown): string | undefined {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return undefined;
    }

    const payload = data as Record<string, unknown>;
    if (typeof payload.turnId === "string" && payload.turnId.length > 0) {
      return payload.turnId;
    }

    const turn = payload.turn;
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
      return undefined;
    }
    const turnRecord = turn as Record<string, unknown>;
    return typeof turnRecord.id === "string" && turnRecord.id.length > 0
      ? turnRecord.id
      : undefined;
  }

  private async _ensureProviderSession(
    threadId: string,
    options?: PromptExecutionOptions,
  ): Promise<string> {
    const hasActiveProcess = this.processes.has(threadId);
    const inMemoryThreadId = this.providerThreadIds.get(threadId);
    const persistedThreadId =
      inMemoryThreadId ?? this._resolvePersistedProviderThreadId(threadId);

    if (hasActiveProcess) {
      if (inMemoryThreadId) return inMemoryThreadId;
      if (persistedThreadId) {
        this.providerThreadIds.set(threadId, persistedThreadId);
        return persistedThreadId;
      }
      throw inactiveSessionError(this.provider.inactiveSessionErrorMessage(threadId));
    }

    if (!persistedThreadId) {
      throw inactiveSessionError(this.provider.inactiveSessionErrorMessage(threadId));
    }

    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }

    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      throw projectNotFoundError(thread.projectId);
    }

    try {
      this._spawnProcess(threadId, project.rootPath);
      this._sendInitialize(threadId);
      const resumedThreadId = await this._sendRequestAndAwaitThreadId(
        threadId,
        this.provider.threadResumeMethod,
        this.provider.createThreadResumeParams(
          persistedThreadId,
          options,
        ),
      );
      this.providerThreadIds.set(threadId, resumedThreadId);
      return resumedThreadId;
    } catch (err) {
      this._cleanupThreadRuntime(threadId);
      throw err;
    }
  }

  private _handleProviderNotification(
    threadId: string,
    seqCounter: number,
    msg: { method: unknown; params: unknown },
  ): number {
    if (msg.method === undefined || msg.method === null) {
      return seqCounter;
    }

    const eventType =
      typeof msg.method === "string" ? msg.method : String(msg.method);
    const eventData = msg.params ?? {};

    const nextSeq = seqCounter + 1;
    this.eventRepo.create({
      threadId,
      seq: nextSeq,
      type: eventType,
      data: eventData,
    });

    if (typeof msg.method === "string") {
      this._syncTitleFromEvent(threadId, msg.method, eventData);
      this._syncStatusFromEvent(threadId, msg.method);
      this._syncActiveTurnFromEvent(threadId, msg.method, eventData);

      if (this.provider.shouldBroadcastForEvent(msg.method)) {
        this.ws.broadcast("thread", threadId);
      }
      return nextSeq;
    }

    this.ws.broadcast("thread", threadId);
    return nextSeq;
  }

  /**
   * Handle process exit: update thread status and clean up.
   */
  private _handleProcessExit(
    threadId: string,
    code: number | null,
    signal: string | null,
  ): void {
    this.processes.delete(threadId);
    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      runtime.close(
        new Error(
          `[thread ${threadId}] Process exited (${signal ?? code ?? "unknown"})`,
        ),
      );
      this.runtimes.delete(threadId);
    }
    this.providerThreadIds.delete(threadId);
    this.activeTurnIds.delete(threadId);

    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;

    if (thread.status === "active") {
      this._setThreadStatus(threadId, "idle", false);
    } else if (thread.status === "created" || thread.status === "provisioning") {
      this._setThreadStatus(threadId, "provisioning_failed", false);
    }

    this.ws.broadcast("thread", threadId);
  }

  /**
   * Send a JSON-RPC message to a thread's process stdin.
   */
  private _sendToProcess(threadId: string, msg: object): void {
    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      try {
        runtime.send(msg);
      } catch (err) {
        if (err instanceof ProviderRuntimeUnavailableError) {
          throw providerUnavailableError(err.message);
        }
        throw err;
      }
      return;
    }

    // Compatibility fallback for tests and edge cases where a process exists
    // but a runtime has not been registered.
    const child = this.processes.get(threadId);
    if (!child || !child.stdin) {
      throw inactiveSessionError(
        this.provider.inactiveSessionErrorMessage(threadId),
      );
    }
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private async _sendRequestAndAwaitThreadId(
    threadId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      throw providerUnavailableError(
        `[thread ${threadId}] No active provider runtime`,
      );
    }

    const requestId = ++this.rpcIdCounter;
    let result: unknown;
    try {
      result = await runtime.request({
        jsonrpc: "2.0",
        method,
        id: requestId,
        params,
      });
    } catch (err) {
      if (err instanceof ProviderRuntimeTimeoutError) {
        throw providerTimeoutError(err.message);
      }
      if (err instanceof ProviderRuntimeRpcError) {
        throw providerRpcError(err.message);
      }
      if (err instanceof ProviderRuntimeUnavailableError) {
        throw providerUnavailableError(err.message);
      }
      throw err;
    }

    const providerThreadId = this.provider.extractThreadIdFromResult(result);
    if (!providerThreadId) {
      throw providerRpcError(
        `[thread ${threadId}] RPC response missing thread ID. Response: ${JSON.stringify(result)}`,
      );
    }

    return providerThreadId;
  }

  private _syncStatusFromEvent(threadId: string, method: string): void {
    const nextStatus = this.provider.statusForEvent(method);
    if (!nextStatus) return;
    this._setThreadStatus(threadId, nextStatus, false);
  }

  private _syncActiveTurnFromEvent(
    threadId: string,
    method: string,
    data: unknown,
  ): void {
    const normalizedMethod = this.provider.normalizeEventType(method);

    if (normalizedMethod === "turn/start" || normalizedMethod === "turn/started") {
      const turnId = this._extractTurnIdFromEventData(data);
      if (turnId) {
        this.activeTurnIds.set(threadId, turnId);
      }
      return;
    }

    if (normalizedMethod === "turn/completed" || normalizedMethod === "turn/end") {
      this.activeTurnIds.delete(threadId);
    }
  }

  private _syncTitleFromEvent(
    threadId: string,
    method: string,
    data: unknown,
  ): void {
    const title = this.provider.titleFromEvent(method, data);
    if (!title) return;
    this._setThreadTitle(threadId, title, {
      onlyIfMissing: false,
      shouldBroadcast: false,
    });
  }

  private _setThreadTitle(
    threadId: string,
    value: unknown,
    opts?: { onlyIfMissing?: boolean; shouldBroadcast?: boolean },
  ): void {
    const title = this._normalizeThreadTitle(value);
    if (!title) return;
    if (this.lockedTitleThreadIds.has(threadId)) return;

    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;
    if (opts?.onlyIfMissing && thread.title) return;
    if (thread.title === title) return;

    this.threadRepo.update(threadId, { title });
    if (opts?.shouldBroadcast !== false) {
      this.ws.broadcast("thread", threadId);
    }
  }

  private _canTransitionStatus(
    currentStatus: Thread["status"],
    nextStatus: Thread["status"],
  ): boolean {
    if (currentStatus === nextStatus) return true;

    switch (currentStatus) {
      case "created":
        return (
          nextStatus === "provisioning" ||
          nextStatus === "provisioning_failed" ||
          nextStatus === "idle"
        );
      case "provisioning":
        return (
          nextStatus === "active" ||
          nextStatus === "idle" ||
          nextStatus === "provisioning_failed"
        );
      case "provisioning_failed":
        return nextStatus === "provisioning" || nextStatus === "idle";
      case "idle":
        return nextStatus === "active" || nextStatus === "provisioning";
      case "active":
        return nextStatus === "idle";
      default:
        return false;
    }
  }

  private _setThreadStatus(
    threadId: string,
    nextStatus: Thread["status"],
    shouldBroadcast = true,
    opts?: { force?: boolean },
  ): void {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      if (!opts?.force) return;
      this.threadRepo.update(threadId, { status: nextStatus });
      if (shouldBroadcast) {
        this.ws.broadcast("thread", threadId);
      }
      return;
    }
    if (thread.archivedAt !== undefined && nextStatus === "active") return;

    if (thread.status === nextStatus) return;
    if (!opts?.force && !this._canTransitionStatus(thread.status, nextStatus)) {
      return;
    }

    this.threadRepo.update(threadId, { status: nextStatus });
    if (shouldBroadcast) {
      this.ws.broadcast("thread", threadId);
    }
  }

  private _maybeAutogenerateThreadTitle(
    threadId: string,
    cwd: string,
    providerThreadId: string,
    input: PromptInput[],
  ): void {
    if (this.lockedTitleThreadIds.has(threadId)) return;
    if (this.autoTitleAttemptedThreadIds.has(threadId)) return;
    if (input.length === 0) return;
    if (this._hasPriorUserMessage(threadId)) {
      // Titles are generated only from the first user message in a thread.
      this.autoTitleAttemptedThreadIds.add(threadId);
      return;
    }

    const fallbackTitle = this.provider.deriveThreadTitle(input);
    if (fallbackTitle) {
      this._setThreadTitle(threadId, fallbackTitle, {
        onlyIfMissing: true,
      });
    }

    // Title generation is a one-time attempt bound to the first user message,
    // even if that message has no text or generation later fails.
    this.autoTitleAttemptedThreadIds.add(threadId);

    const hasTextInput = input.some(
      (chunk) => chunk.type === "text" && chunk.text.trim().length > 0,
    );
    if (!hasTextInput) return;
    if (!this.provider.generateThreadTitle) return;
    void this._runAutogeneratedThreadTitle(threadId, cwd, providerThreadId, input);
  }

  private _hasPriorUserMessage(threadId: string): boolean {
    const events = this.eventRepo.listByThread(threadId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const canonicalEvent = this.provider.toCanonicalEvent(events[i]);
      const normalizedType = this.provider.normalizeEventType(canonicalEvent.type);
      if (normalizedType === "message/user") {
        return true;
      }
    }
    return false;
  }

  private async _runAutogeneratedThreadTitle(
    threadId: string,
    cwd: string,
    providerThreadId: string,
    input: PromptInput[],
  ): Promise<void> {
    try {
      if (!this.provider.generateThreadTitle) return;
      const generatedTitle = await this.provider.generateThreadTitle({
        input,
        cwd,
      });

      if (!generatedTitle) return;

      this._setThreadTitle(threadId, generatedTitle, {
        onlyIfMissing: false,
      });
      // Preserve generated titles against provider-side default renames
      // (for example, first-message fallback names emitted later).
      this.lockedTitleThreadIds.add(threadId);
      this._sendThreadNameSet(threadId, providerThreadId, generatedTitle);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown title generation error";
      console.error(
        `[thread ${threadId}] Failed to auto-generate title (${this.provider.displayName}): ${message}`,
      );
    }
  }

  private _sendThreadNameSet(
    threadId: string,
    providerThreadId: string,
    title: string,
  ): void {
    if (!this.provider.threadNameSetMethod) return;
    if (!this.provider.createThreadNameSetParams) return;

    const child = this.processes.get(threadId);
    if (!child) return;

    try {
      this._sendToProcess(threadId, {
        jsonrpc: "2.0",
        method: this.provider.threadNameSetMethod,
        id: ++this.rpcIdCounter,
        params: this.provider.createThreadNameSetParams(providerThreadId, title),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(
        `[thread ${threadId}] Failed to send ${this.provider.threadNameSetMethod}: ${message}`,
      );
    }
  }

  private _normalizeThreadTitle(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;

    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    if (normalized.length <= 60) return normalized;
    return `${normalized.slice(0, 57).trimEnd()}...`;
  }

  private _latestTurnLifecycleStatus(
    threadId: string,
  ): Thread["status"] | undefined {
    const latestLifecycle =
      typeof this.eventRepo.getLatestTurnLifecycle === "function"
        ? this.eventRepo.getLatestTurnLifecycle(threadId)
        : undefined;
    if (latestLifecycle) {
      if (
        latestLifecycle.normType === "turn/completed" ||
        latestLifecycle.normType === "turn/end"
      ) {
        return "idle";
      }
      if (
        latestLifecycle.normType === "turn/started" ||
        latestLifecycle.normType === "turn/start"
      ) {
        return "active";
      }
    }

    const events = this.eventRepo.listByThread(threadId) ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const normalizedType = this.provider.normalizeEventType(events[i].type);
      if (normalizedType === "turn/completed" || normalizedType === "turn/end") {
        return "idle";
      }
      if (normalizedType === "turn/started" || normalizedType === "turn/start") {
        return "active";
      }
    }
    return undefined;
  }

}
