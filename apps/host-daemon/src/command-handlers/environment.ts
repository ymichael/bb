import {
  threadScope,
  type ProvisioningTranscriptEntry,
  WORKSPACE_PROVISIONING_STEP_KEYS,
} from "@bb/domain";
import type {
  EnvironmentProvisionCommand,
  HostDaemonCommandResult,
} from "@bb/host-daemon-contract";
import type { ProvisionWorkspaceArgs } from "@bb/host-workspace";
import {
  type CommandDispatchOptions,
  type CommandOf,
} from "../command-dispatch-support.js";

type ProvisionProgressCallback = (entry: ProvisioningTranscriptEntry) => void;
interface ProvisionProgressEmitter {
  flush: () => void;
  onProgress: ProvisionProgressCallback;
}
type BuildOnProgressArgs = {
  command: CommandOf<"environment.attach">;
  options: CommandDispatchOptions;
};

const PROVISION_PROGRESS_BATCH_MS = 1_000;

export async function provisionEnvironment(
  command: CommandOf<"environment.attach">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"environment.attach">> {
  const alreadyExists =
    options.runtimeManager.get(command.environmentId) != null;

  const progress = buildOnProgress({ command, options });
  let streamedAnyStep = false;
  const onProgress: ProvisionProgressCallback = (entry) => {
    streamedAnyStep = true;
    progress.onProgress(entry);
  };

  try {
    const entry = await options.runtimeManager.ensureEnvironment({
      environmentId: command.environmentId,
      provision: toProvisionWorkspaceOptions(command, onProgress),
    });

    const [branchName, resolvedDefaultBranch] = await Promise.all([
      entry.workspace.getCurrentBranch(),
      entry.workspace.isGitRepo
        ? entry.workspace.getDefaultBranch()
        : Promise.resolve(null),
    ]);
    const defaultBranch = entry.workspace.isGitRepo
      ? (resolvedDefaultBranch ?? branchName)
      : null;

    if (!alreadyExists || !streamedAnyStep) {
      onProgress({
        type: "step",
        key: WORKSPACE_PROVISIONING_STEP_KEYS.workspacePath,
        text: `Using workspace: ${entry.workspace.path}`,
        status: "completed",
        startedAt: Date.now(),
      });
      if (entry.workspace.isGitRepo && branchName) {
        let branchText = `Using branch: ${branchName}`;
        const metadata: { branchName: string; sha?: string } = { branchName };
        try {
          const sha = await entry.workspace.getHeadSha();
          if (sha) {
            branchText = `Using branch: ${branchName} (${sha.slice(0, 7)})`;
            metadata.sha = sha;
          }
        } catch {}
        onProgress({
          type: "step",
          key: WORKSPACE_PROVISIONING_STEP_KEYS.workspaceBranch,
          text: branchText,
          status: "completed",
          startedAt: Date.now(),
          metadata,
        });
      }
    }

    return {
      path: entry.workspace.path,
      isGitRepo: entry.workspace.isGitRepo,
      isWorktree: entry.workspace.isWorktree,
      branchName,
      defaultBranch,
    };
  } finally {
    progress.flush();
    if (command.initiator) {
      await options.eventSink.flush();
    }
  }
}

export function cancelEnvironmentProvision(
  command: CommandOf<"environment.attach.cancel">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"environment.attach.cancel">> {
  return options.runtimeManager.cancelEnvironmentProvision({
    environmentId: command.environmentId,
  });
}

function buildOnProgress(args: BuildOnProgressArgs): ProvisionProgressEmitter {
  const { command, options } = args;
  const initiator = command.initiator;
  const eventSink = options.eventSink;
  if (!initiator) {
    return {
      flush: () => undefined,
      onProgress: () => undefined,
    };
  }
  const threadId = initiator.threadId;
  const pendingEntries: ProvisioningTranscriptEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingEntries.length === 0) {
      return;
    }
    const entries = pendingEntries.splice(0, pendingEntries.length);
    eventSink.emit({
      threadId,
      event: {
        type: "system/thread-provisioning",
        threadId,
        scope: threadScope(),
        provisioningId: initiator.provisioningId,
        status: "active",
        environmentId: command.environmentId,
        entries,
      },
    });
  };

  const scheduleFlush = () => {
    if (flushTimer !== null) {
      return;
    }
    flushTimer = setTimeout(flush, PROVISION_PROGRESS_BATCH_MS);
  };

  return {
    flush,
    onProgress: (entry) => {
      pendingEntries.push(entry);
      scheduleFlush();
    },
  };
}

function toProvisionWorkspaceOptions(
  command: EnvironmentProvisionCommand,
  onProgress?: ProvisionProgressCallback,
): ProvisionWorkspaceArgs {
  return {
    path: command.path,
    onProgress,
  };
}
