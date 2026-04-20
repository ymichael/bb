import { createReplayRawProviderEventTranslator } from "@bb/agent-runtime";
import { type ThreadEvent, type ThreadEventTurnStatus } from "@bb/domain";
import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import { replayRawProviderEventsPath } from "@bb/replay-capture";
import {
  deleteReplayCapture,
  listReplayCaptureSummaries,
  readReplayCaptureManifest,
  requireReplayCaptureFile,
  streamRawProviderRecords,
  type ReplayCaptureReadArgs,
} from "@bb/replay-capture/reader";
import {
  ReplayPlaybackAbortError,
  remapReplayThreadEvent,
  replayEventTurnId,
  replayTerminalIdentifiers,
  streamRawProviderReplayEvents,
  waitForReplayTime,
  type ReplayEventRecord,
  type ReplayTerminalIdentifiers,
  type ReplayTimingState,
} from "@bb/replay-capture/playback";
import type {
  CommandOf,
  EventSink,
  ReplayTaskHandle,
} from "../command-dispatch-support.js";
import { CommandDispatchError } from "../command-dispatch-support.js";

export interface ReplayCommandOptions {
  dataDir: string;
  eventSink?: EventSink;
  replayTasks?: Map<string, ReplayTaskHandle>;
}

interface ReplayTranslatedEventsArgs {
  command: CommandOf<"replay.run">;
  events: AsyncIterable<ReplayEventRecord>;
  eventSink: EventSink;
  terminal: ReplayTerminalIdentifiers;
  timing: ReplayTimingState;
  signal: AbortSignal;
}

interface ReplayPlan {
  events: () => AsyncIterable<ReplayEventRecord>;
  terminal: ReplayTerminalIdentifiers;
}

export async function listReplayCaptures(
  options: ReplayCommandOptions,
): Promise<HostDaemonCommandResult<"replay.capture_list">> {
  return {
    captures: await listReplayCaptureSummaries(options.dataDir),
  };
}

export async function getReplayCapture(
  command: CommandOf<"replay.capture_get">,
  options: ReplayCommandOptions,
): Promise<HostDaemonCommandResult<"replay.capture_get">> {
  return readReplayCaptureManifest({
    captureId: command.captureId,
    dataDir: options.dataDir,
  });
}

export async function removeReplayCapture(
  command: CommandOf<"replay.capture_delete">,
  options: ReplayCommandOptions,
): Promise<HostDaemonCommandResult<"replay.capture_delete">> {
  await deleteReplayCapture({
    captureId: command.captureId,
    dataDir: options.dataDir,
  });
  return {};
}

function terminalEvent(args: {
  command: CommandOf<"replay.run">;
  terminal: ReplayTerminalIdentifiers;
  status: ThreadEventTurnStatus;
  errorMessage?: string;
}): ThreadEvent {
  return {
    type: "turn/completed",
    threadId: args.command.threadId,
    providerThreadId: args.terminal.providerThreadId,
    turnId: args.terminal.turnId,
    status: args.status,
    ...(args.errorMessage ? { error: { message: args.errorMessage } } : {}),
  };
}

function emitReplaySystemError(args: {
  command: CommandOf<"replay.run">;
  error: Error;
  eventSink: EventSink;
}): void {
  args.eventSink.emit({
    environmentId: args.command.environmentId,
    threadId: args.command.threadId,
    event: {
      type: "system/error",
      threadId: args.command.threadId,
      code: "replay_failed",
      message: args.error.message,
    },
  });
}

function emitReplayTerminal(args: {
  command: CommandOf<"replay.run">;
  eventSink: EventSink;
  status: ThreadEventTurnStatus;
  terminal: ReplayTerminalIdentifiers;
  errorMessage?: string;
}): void {
  args.eventSink.emit({
    environmentId: args.command.environmentId,
    threadId: args.command.threadId,
    event: terminalEvent(args),
  });
}

async function replayTranslatedEvents(
  args: ReplayTranslatedEventsArgs,
): Promise<void> {
  let emittedTerminal = false;
  for await (const replayEvent of args.events) {
    const { event, relativeMs } = replayEvent;
    await waitForReplayTime({
      relativeMs,
      signal: args.signal,
      timing: args.timing,
    });
    const remappedEvent = remapReplayThreadEvent({
      event,
      providerThreadId: args.terminal.providerThreadId,
      threadId: args.command.threadId,
    });
    args.terminal.turnId =
      replayEventTurnId(remappedEvent) ?? args.terminal.turnId;
    args.eventSink.emit({
      environmentId: args.command.environmentId,
      threadId: args.command.threadId,
      event: remappedEvent,
    });
    emittedTerminal ||= remappedEvent.type === "turn/completed";
  }

  if (!emittedTerminal) {
    emitReplayTerminal({
      command: args.command,
      eventSink: args.eventSink,
      status: "completed",
      terminal: args.terminal,
    });
  }
  await args.eventSink.flush();
}

export async function runReplay(
  command: CommandOf<"replay.run">,
  options: ReplayCommandOptions,
): Promise<HostDaemonCommandResult<"replay.run">> {
  const eventSink = options.eventSink;
  if (!eventSink) {
    throw new CommandDispatchError(
      "replay_unavailable",
      "Replay requires an event sink",
    );
  }
  const replayTasks = options.replayTasks;
  if (!replayTasks) {
    throw new CommandDispatchError(
      "replay_unavailable",
      "Replay requires a task registry",
    );
  }
  if (replayTasks.has(command.threadId)) {
    throw new CommandDispatchError(
      "replay_already_running",
      "Replay is already running",
    );
  }

  const readArgs: ReplayCaptureReadArgs = {
    captureId: command.captureId,
    dataDir: options.dataDir,
  };
  let plan: ReplayPlan;
  try {
    plan = await buildReplayPlan(command, readArgs);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await emitReplayFailure({
      command,
      eventSink,
      error: failure,
      terminal: {
        providerThreadId: `replay:${command.captureId}`,
        turnId: `replay:${command.captureId}`,
      },
    });
    throw error;
  }

  const abort = new AbortController();
  const task: ReplayTaskHandle = {
    abort,
    done: Promise.resolve(),
  };
  replayTasks.set(command.threadId, task);
  task.done = runReplayTask({
    command,
    eventSink,
    plan,
    signal: abort.signal,
  }).finally(() => {
    replayTasks.delete(command.threadId);
  });

  return {};
}

async function buildReplayPlan(
  command: CommandOf<"replay.run">,
  readArgs: ReplayCaptureReadArgs,
): Promise<ReplayPlan> {
  const manifest = await readReplayCaptureManifest(readArgs);
  const terminal = replayTerminalIdentifiers(manifest);

  await requireReplayCaptureFile(
    replayRawProviderEventsPath(readArgs.dataDir, readArgs.captureId),
  );
  const translator = createReplayRawProviderEventTranslator({
    bbThreadId: command.threadId,
    providerId: manifest.providerId,
  });
  return {
    events: () =>
      streamRawProviderReplayEvents({
        records: streamRawProviderRecords(readArgs),
        translator,
      }),
    terminal,
  };
}

async function runReplayTask(args: {
  command: CommandOf<"replay.run">;
  eventSink: EventSink;
  plan: ReplayPlan;
  signal: AbortSignal;
}): Promise<void> {
  const timing: ReplayTimingState = {
    previousRelativeMs: 0,
    speed: args.command.speed,
  };

  try {
    await replayTranslatedEvents({
      command: args.command,
      eventSink: args.eventSink,
      events: args.plan.events(),
      signal: args.signal,
      terminal: args.plan.terminal,
      timing,
    });
  } catch (error) {
    if (error instanceof ReplayPlaybackAbortError || args.signal.aborted) {
      emitReplayTerminal({
        command: args.command,
        eventSink: args.eventSink,
        status: "interrupted",
        terminal: args.plan.terminal,
      });
      await args.eventSink.flush();
      return;
    }

    const failure = error instanceof Error ? error : new Error(String(error));
    await emitReplayFailure({
      command: args.command,
      eventSink: args.eventSink,
      error: failure,
      terminal: args.plan.terminal,
    });
  }
}

async function emitReplayFailure(args: {
  command: CommandOf<"replay.run">;
  error: Error;
  eventSink: EventSink;
  terminal: ReplayTerminalIdentifiers;
}): Promise<void> {
  emitReplaySystemError(args);
  emitReplayTerminal({
    command: args.command,
    eventSink: args.eventSink,
    status: "failed",
    terminal: args.terminal,
    errorMessage: args.error.message,
  });
  await args.eventSink.flush();
}
