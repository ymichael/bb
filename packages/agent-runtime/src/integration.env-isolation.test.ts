import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanup,
  createApprovalResolution,
  createTestRuntime,
  newThreadId,
  resolveRuntimeOptions,
  turnCompletedCountForThread,
  waitForRuntimeCondition,
} from "./test/runtime-integration-harness.js";
import { promptTextInput } from "./test/prompt-input.js";

interface ThreadEnvCapture {
  fileName: string;
  projectId: string;
  threadId: string;
}

interface ReadCapturedEnvArgs {
  ctxTmpDir: string;
  fileName: string;
}

const providers = ["codex", "claude-code", "pi"];

function createCaptureCommand(fileName: string): string {
  return (
    `printf '%s\\n%s\\n%s\\n' ` +
    `"$BB_THREAD_ID" "$BB_PROJECT_ID" "$BB_ENVIRONMENT_ID" > ${fileName}`
  );
}

function createCapturePrompt(command: string): string {
  return (
    "Run this shell command exactly once from the current working directory: " +
    `\`${command}\`. ` +
    "After the command finishes, reply with exactly DONE."
  );
}

function readCapturedEnv(args: ReadCapturedEnvArgs): string[] {
  return readFileSync(join(args.ctxTmpDir, args.fileName), "utf8")
    .trim()
    .split(/\r?\n/u);
}

for (const providerId of providers) {
  describe.concurrent(`${providerId} provider env isolation`, () => {
    it("keeps concurrent thread shell env isolated in one provider process", async () => {
      const ctx = createTestRuntime(providerId, {
        onInteractiveRequest: createApprovalResolution,
      });
      const sharedEnvironmentId = `env-isolation-${randomUUID()}`;
      const firstCapture: ThreadEnvCapture = {
        fileName: `env-first-${randomUUID()}.txt`,
        projectId: `project-first-${randomUUID()}`,
        threadId: newThreadId(),
      };
      const secondCapture: ThreadEnvCapture = {
        fileName: `env-second-${randomUUID()}.txt`,
        projectId: `project-second-${randomUUID()}`,
        threadId: newThreadId(),
      };

      try {
        const options = await resolveRuntimeOptions({
          ctx,
          providerId,
          preset: "full",
        });

        await ctx.runtime.startThread({
          environmentId: sharedEnvironmentId,
          threadId: firstCapture.threadId,
          projectId: firstCapture.projectId,
          providerId,
          options,
          instructions:
            "When the user asks you to run an exact shell command, use your shell or command execution tool and preserve command output.",
        });
        await ctx.runtime.startThread({
          environmentId: sharedEnvironmentId,
          threadId: secondCapture.threadId,
          projectId: secondCapture.projectId,
          providerId,
          options,
          instructions:
            "When the user asks you to run an exact shell command, use your shell or command execution tool and preserve command output.",
        });

        const firstFilePath = join(ctx.tmpDir, firstCapture.fileName);
        const secondFilePath = join(ctx.tmpDir, secondCapture.fileName);

        await Promise.all([
          ctx.runtime.runTurn({
            threadId: firstCapture.threadId,
            clientRequestId: "creq_23456789ab",
            options,
            input: [
              promptTextInput({
                text: createCapturePrompt(
                  createCaptureCommand(firstCapture.fileName),
                ),
              }),
            ],
          }),
          ctx.runtime.runTurn({
            threadId: secondCapture.threadId,
            clientRequestId: "creq_23456789ab",
            options,
            input: [
              promptTextInput({
                text: createCapturePrompt(
                  createCaptureCommand(secondCapture.fileName),
                ),
              }),
            ],
          }),
        ]);

        await waitForRuntimeCondition({
          ctx,
          label: "both thread env capture files",
          predicate: () =>
            (existsSync(firstFilePath) && existsSync(secondFilePath)) ||
            (turnCompletedCountForThread(ctx.events, firstCapture.threadId) >
              0 &&
              turnCompletedCountForThread(ctx.events, secondCapture.threadId) >
                0),
          timeoutMs: 90_000,
        });

        const firstFileExists = existsSync(firstFilePath);
        const secondFileExists = existsSync(secondFilePath);
        if (!firstFileExists || !secondFileExists) {
          const firstTurnCompletedCount = turnCompletedCountForThread(
            ctx.events,
            firstCapture.threadId,
          );
          const secondTurnCompletedCount = turnCompletedCountForThread(
            ctx.events,
            secondCapture.threadId,
          );
          throw new Error(
            [
              `${providerId} turns completed without writing env capture files`,
              `firstThread=${firstCapture.threadId}`,
              `firstFile=${firstFilePath}`,
              `firstFileExists=${firstFileExists}`,
              `firstTurnCompletedCount=${firstTurnCompletedCount}`,
              `secondThread=${secondCapture.threadId}`,
              `secondFile=${secondFilePath}`,
              `secondFileExists=${secondFileExists}`,
              `secondTurnCompletedCount=${secondTurnCompletedCount}`,
            ].join(" "),
          );
        }

        const firstCapturedEnv = readCapturedEnv({
          ctxTmpDir: ctx.tmpDir,
          fileName: firstCapture.fileName,
        });
        const secondCapturedEnv = readCapturedEnv({
          ctxTmpDir: ctx.tmpDir,
          fileName: secondCapture.fileName,
        });

        expect(firstCapturedEnv).toEqual([
          firstCapture.threadId,
          firstCapture.projectId,
          sharedEnvironmentId,
        ]);
        expect(secondCapturedEnv).toEqual([
          secondCapture.threadId,
          secondCapture.projectId,
          sharedEnvironmentId,
        ]);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 95_000);
  });
}
