import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { readdir, rm } from "node:fs/promises";
import { createHostProgress } from "bb-environment-provider-host/progress";
import { worktreeHostContract, worktreeHostSignals } from "./contract.js";
import { resolveWorktreeBaseBranch } from "./host/base-branch.js";
import {
  resolveWorktreesRoot,
  resolveWorktreeAttemptRoot,
  resolveWorktreeTargetPath,
} from "./host/paths.js";
import { createWorktree, removeWorktree } from "./host/worktree.js";

function completionPathForWorktree(worktreePath: string): string {
  return `${worktreePath}.completed`;
}

async function worktreePathsForPathKey(args: {
  dataDir: string;
  pathKey: string;
}): Promise<string[]> {
  const root = resolveWorktreeAttemptRoot(args);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        resolveWorktreeTargetPath({
          dataDir: args.dataDir,
          pathKey: args.pathKey,
          sourcePath: entry.name,
        }),
      );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function createWorktreeHostEntry() {
  return experimental_defineHostEntry({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
    handlers: {
      async create(input, context) {
        const targetPath = resolveWorktreeTargetPath({
          dataDir: context.experimental_paths.dataDir,
          pathKey: input.pathKey,
          sourcePath: input.sourcePath,
        });
        try {
          const baseBranch = await resolveWorktreeBaseBranch(
            input.sourcePath,
            input.baseBranch,
          );
          const created = await createWorktree({
            sourcePath: input.sourcePath,
            targetPath,
            completionPath: completionPathForWorktree(targetPath),
            ownWorktreesRoot: resolveWorktreesRoot(
              context.experimental_paths.dataDir,
            ),
            branchName: input.branchName,
            baseBranch,
            branchMode: input.branchMode,
            timeoutMs: input.setupTimeoutMs,
            onProgress: createHostProgress({
              operationId: input.operationId,
              emit: (payload) =>
                context.experimental_emitSignal("progress", payload),
            }),
            pruneEmptyParent: true,
            signal: context.signal,
          });
          return { status: "created", path: created.path, baseBranch } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },

      async remove(input, context) {
        try {
          const paths =
            input.path === null
              ? await worktreePathsForPathKey({
                  dataDir: context.experimental_paths.dataDir,
                  pathKey: input.pathKey,
                })
              : [input.path];
          for (const path of paths) {
            await rm(completionPathForWorktree(path), { force: true });
            await removeWorktree({
              path,
              timeoutMs: input.teardownTimeoutMs,
              force: true,
              pruneEmptyParent: true,
              onProgress: createHostProgress({
                operationId: input.operationId,
                emit: (payload) =>
                  context.experimental_emitSignal("progress", payload),
              }),
              signal: context.signal,
            });
          }
          return { status: "removed" } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },
    },
  });
}

export default createWorktreeHostEntry();
