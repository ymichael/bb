import type { ProvisioningTranscriptEntry } from "@bb/domain";
import type { HostDaemonCommandResult, environmentProvisionCommandSchema } from "@bb/host-daemon-contract";
import type { ProvisionWorkspaceArgs } from "@bb/host-workspace";
import { type CommandDispatchOptions, type CommandOf } from "../command-dispatch-support.js";

type ProvisionProgressCallback = (entry: ProvisioningTranscriptEntry) => void;
type BuildOnProgressArgs = {
  command: CommandOf<"environment.provision">;
  options: CommandDispatchOptions;
  transcript: ProvisioningTranscriptEntry[];
};

export async function provisionEnvironment(
  command: CommandOf<"environment.provision">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"environment.provision">> {
  const alreadyExists = options.runtimeManager.get(command.environmentId) != null;

  // Seed event buffer so daemon-emitted sequences don't collide with server-side events
  if (command.initiator) {
    options.seedThreadHighWaterMark?.({
      threadId: command.initiator.threadId,
      sequence: command.initiator.eventSequence,
    });
  }

  const transcript: ProvisioningTranscriptEntry[] = [];
  const onProgress = buildOnProgress({
    command,
    options,
    transcript,
  });

  try {
    const entry = await options.runtimeManager.ensureEnvironment({
      environmentId: command.environmentId,
      provision: toProvisionWorkspaceOptions(command, onProgress),
    });

    const defaultBranch = entry.workspace.isGitRepo
      ? (await entry.workspace.getStatus()).branch.defaultBranch || null
      : null;
    const branchName = await entry.workspace.getCurrentBranch();

    // For fresh provisions, emit cwd (for unmanaged) and branch/SHA entries.
    if (!alreadyExists) {
      if (!entry.workspace.managed) {
        onProgress({
          type: "step",
          key: "workspace-path",
          text: `Using workspace: ${entry.workspace.path}`,
          status: "completed",
          startedAt: Date.now(),
        });
      }
      if (entry.workspace.isGitRepo && branchName) {
        let branchText = `Using branch: ${branchName}`;
        const metadata: { branchName: string; sha?: string } = { branchName };
        try {
          const sha = await entry.workspace.getHeadSha();
          if (sha) {
            branchText = `Using branch: ${branchName} (${sha.slice(0, 7)})`;
            metadata.sha = sha;
          }
        } catch {
          // SHA unavailable (e.g., empty repo)
        }
        onProgress({
          type: "step",
          key: "workspace-branch",
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
      transcript: alreadyExists ? [] : transcript,
    };
  } finally {
    // Flush buffered progress events before reporting the command result so
    // streamed transcript entries stay ordered ahead of the terminal outcome.
    if (command.initiator) {
      await options.eventSink?.flush();
    }
  }
}

function buildOnProgress(args: BuildOnProgressArgs): ProvisionProgressCallback {
  const { command, options, transcript } = args;
  const threadId = command.initiator?.threadId;
  const eventSink = options.eventSink;
  if (!threadId || !eventSink) {
    return (entry) => {
      transcript.push(entry);
    };
  }

  return (entry) => {
    transcript.push(entry);
    eventSink.emit({
      environmentId: command.environmentId,
      threadId,
      event: {
        type: "system/thread-provisioning",
        threadId,
        status: "active",
        environmentId: command.environmentId,
        entries: [entry],
      },
    });
  };
}

export function toProvisionWorkspaceOptions(
  command: typeof environmentProvisionCommandSchema._type,
  onProgress?: ProvisionProgressCallback,
): ProvisionWorkspaceArgs {
  switch (command.workspaceProvisionType) {
    case "unmanaged": {
      return {
        workspaceProvisionType: "unmanaged" as const,
        path: command.path,
        onProgress,
      };
    }
    case "managed-worktree":
    case "managed-clone": {
      return {
        workspaceProvisionType: command.workspaceProvisionType,
        sourcePath: command.sourcePath,
        targetPath: command.targetPath,
        branchName: command.branchName,
        timeoutMs: command.setupTimeoutMs,
        onProgress,
      };
    }
  }
}
