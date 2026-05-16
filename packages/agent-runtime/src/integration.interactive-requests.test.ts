/** Provider integration tests using createAgentRuntime. */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isApprovalPendingInteractionPayload,
  type PendingInteractionApprovalDecision,
  type PendingInteractionApprovalSubject,
  type PendingInteractionCreate,
} from "@bb/domain";
import { listAvailableProviderInfos } from "./provider-registry.js";
import {
  cleanup,
  createApprovalResolution,
  createTempFileName,
  createTestRuntime,
  createToken,
  expectWriteApprovalRequest,
  getAgentText,
  getFirstNonEmptyLine,
  getStreamedText,
  getThreadText,
  hasDeniedCommandExecution,
  newThreadId,
  resolveRuntimeOptions,
  waitForInteractiveRequestBeforeTurnCompletion,
  waitForThreadTurnCompleted,
  waitForThreadTurnCompletedCount,
} from "./test/runtime-integration-harness.js";

function describePendingInteractionPayload(
  request: PendingInteractionCreate,
): string {
  if (isApprovalPendingInteractionPayload(request.payload)) {
    return request.payload.subject.kind;
  }
  return request.payload.kind;
}

function hasApprovalSubjectKind(
  request: PendingInteractionCreate,
  subjectKind: PendingInteractionApprovalSubject["kind"],
): boolean {
  return (
    isApprovalPendingInteractionPayload(request.payload) &&
    request.payload.subject.kind === subjectKind
  );
}

function hasAvailableApprovalDecision(
  request: PendingInteractionCreate,
  decision: PendingInteractionApprovalDecision,
): boolean {
  return (
    isApprovalPendingInteractionPayload(request.payload) &&
    request.payload.availableDecisions.includes(decision)
  );
}

describe("interactive request scenarios", () => {
  it.concurrent(
    "loads Claude repo CLAUDE.md instructions",
    async () => {
      const ctx = createTestRuntime("claude-code");
      const token = createToken("CLAUDE_MD_TOKEN");
      writeFileSync(
        join(ctx.tmpDir, "CLAUDE.md"),
        `When asked for the repo validation phrase, reply exactly: ${token}\n`,
      );

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "full",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "claude-code",
          options,
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_222222222x",
          threadId,
          input: [
            {
              type: "text",
              text: "What is the repo validation phrase? Reply with only that phrase.",
            },
          ],
          options,
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Claude CLAUDE.md turn/completed",
        });

        const text = getThreadText(ctx.events, threadId);
        expect(text).toContain(token);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    60_000,
  );

  it.concurrent(
    "routes Claude Read prompts as semantic permission-grant approvals",
    async () => {
      const hostsPath = "/etc/hosts";
      const expectedLine = getFirstNonEmptyLine(hostsPath);
      const ctx = createTestRuntime("claude-code", {
        onInteractiveRequest: async (request) => {
          if (
            !isApprovalPendingInteractionPayload(request.payload) ||
            request.payload.subject.kind !== "permission_grant"
          ) {
            throw new Error(
              `Expected permission grant approval, got ${describePendingInteractionPayload(request)}`,
            );
          }

          return {
            decision: "allow_once",
            grantedPermissions: request.payload.subject.permissions,
          };
        },
      });

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "workspace-write-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "claude-code",
          options,
          instructions:
            "Use the Read tool when the user explicitly asks for it. Do not substitute Bash.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_222222222y",
          threadId,
          input: [
            {
              type: "text",
              text: "Use the Read tool to read /etc/hosts, then reply with exactly the first non-empty line from the file and nothing else.",
            },
          ],
          options,
        });

        await waitForInteractiveRequestBeforeTurnCompletion({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 45_000,
          label: "Claude permission request",
        });
        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Claude permission turn/completed",
        });

        expect(ctx.interactiveRequests).toHaveLength(1);
        expect(ctx.interactiveRequests[0]?.payload).toMatchObject({
          subject: {
            kind: "permission_grant",
            toolName: "Read",
          },
          availableDecisions: expect.arrayContaining(["allow_once", "deny"]),
        });

        const text = getAgentText(ctx.events) || getStreamedText(ctx.events);
        expect(text).toContain(expectedLine);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    60_000,
  );

  it.concurrent(
    "allows Claude workspace-write Write tool mutations without interactive requests",
    async () => {
      const ctx = createTestRuntime("claude-code");
      const fileName = createTempFileName("claude-workspace-write-tool");
      const filePath = join(ctx.tmpDir, fileName);
      const token = createToken("CLAUDE_WORKSPACE_WRITE_TOOL_APPROVED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "workspace-write-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "claude-code",
          options,
          instructions:
            "Use the Write tool when the user explicitly asks for Write. Do not substitute Bash.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_222222222z",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Use the Write tool to create exactly this file: ${filePath}. ` +
                `The file content must be exactly ${token} with no trailing newline. ` +
                "Do not use Bash. After the file is written, reply with exactly DONE.",
            },
          ],
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Claude workspace-write Write turn/completed",
        });

        expect(ctx.interactiveRequests).toHaveLength(0);
        expect(readFileSync(filePath, "utf8")).toBe(token);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "allows Claude workspace-write sandboxed Bash workspace writes without interactive requests",
    async () => {
      const ctx = createTestRuntime("claude-code");
      const fileName = createTempFileName("claude-workspace-write-bash");
      const filePath = join(ctx.tmpDir, fileName);
      const token = createToken("CLAUDE_WORKSPACE_BASH_APPROVED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "workspace-write-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "claude-code",
          options,
          instructions:
            "Use the Bash tool when the user explicitly asks for Bash. Do not substitute Write.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_2222222232",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Use Bash to run exactly: printf '${token}' > ${fileName}. ` +
                "Do not use the Write tool. After the command finishes, reply with exactly DONE.",
            },
          ],
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Claude workspace-write sandboxed Bash turn/completed",
        });

        expect(ctx.interactiveRequests).toHaveLength(0);
        expect(readFileSync(filePath, "utf8")).toBe(token);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "blocks Claude workspace-write outside-workspace Bash without interactive requests when escalation is deny",
    async () => {
      const ctx = createTestRuntime("claude-code");
      const outsideDir = mkdtempSync(join(tmpdir(), "bb-claude-outside-"));
      const filePath = join(
        outsideDir,
        createTempFileName("claude-outside-bash-denied"),
      );
      const token = createToken("CLAUDE_WORKSPACE_BASH_DENIED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "workspace-write-deny",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "claude-code",
          options,
          instructions:
            "Use the Bash tool when the user explicitly asks for Bash. Do not substitute Write.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_2222222233",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Use Bash to run exactly: printf '${token}' > '${filePath}'. ` +
                "If it is denied or blocked, say DENIED.",
            },
          ],
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Claude workspace-write outside Bash deny turn/completed",
        });

        expect(ctx.interactiveRequests).toHaveLength(0);
        expect(existsSync(filePath)).toBe(false);
      } finally {
        await ctx.runtime.shutdown();
        rmSync(outsideDir, { recursive: true, force: true });
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "allows Codex workspace-write workspace writes without interactive requests",
    async () => {
      const ctx = createTestRuntime("codex");
      const fileName = createTempFileName("codex-workspace-write");
      const filePath = join(ctx.tmpDir, fileName);
      const token = createToken("CODEX_WORKSPACE_WRITE_APPROVED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "codex",
          preset: "workspace-write-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "codex",
          options,
          instructions:
            "When the user asks you to run an exact shell command, run that shell command exactly once and then report DONE.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_2222222234",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Run this exact shell command: printf '${token}' > ${fileName}. ` +
                "After the command finishes, reply with exactly DONE.",
            },
          ],
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Codex workspace-write turn/completed",
        });

        expect(ctx.interactiveRequests).toHaveLength(0);
        expect(readFileSync(filePath, "utf8")).toBe(token);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "routes Codex workspace-write outside-workspace writes through onInteractiveRequest",
    async () => {
      const ctx = createTestRuntime("codex", {
        onInteractiveRequest: createApprovalResolution,
      });
      const outsideDir = mkdtempSync(join(process.cwd(), ".bb-codex-outside-"));
      const filePath = join(
        outsideDir,
        createTempFileName("codex-outside-write"),
      );
      const token = createToken("CODEX_WORKSPACE_WRITE_ESCALATED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "codex",
          preset: "workspace-write-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "codex",
          options,
          instructions:
            "When the user asks you to run an exact shell command, run that shell command exactly once. If approval is needed, request approval; it will be approved. Then report DONE.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_2222222235",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Run this exact shell command: printf '${token}' > '${filePath}'. ` +
                "If approval is needed, request approval. If it is denied or blocked, report the exact error. Otherwise reply DONE.",
            },
          ],
        });

        await waitForInteractiveRequestBeforeTurnCompletion({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 45_000,
          label: "Codex workspace-write outside-workspace approval",
        });
        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Codex workspace-write outside-workspace turn/completed",
        });

        expectWriteApprovalRequest(ctx.interactiveRequests);
        expect(readFileSync(filePath, "utf8")).toBe(token);
      } finally {
        await ctx.runtime.shutdown();
        rmSync(outsideDir, { recursive: true, force: true });
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "routes Codex readonly workspace writes through onInteractiveRequest when escalation is ask",
    async () => {
      const ctx = createTestRuntime("codex", {
        onInteractiveRequest: createApprovalResolution,
      });
      const fileName = createTempFileName("codex-readonly-write");
      const filePath = join(ctx.tmpDir, fileName);
      const token = createToken("CODEX_READONLY_APPROVED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "codex",
          preset: "readonly-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "codex",
          options,
          instructions:
            "When the user asks you to run an exact shell command, run that shell command exactly once. If approval is needed, request approval; it will be approved. Then report DONE.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_2222222236",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Run this exact shell command: printf '${token}' > ${fileName}. ` +
                "If approval is needed, request approval. After the command finishes, reply with exactly DONE.",
            },
          ],
        });

        await waitForInteractiveRequestBeforeTurnCompletion({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 45_000,
          label: "Codex readonly write approval",
        });
        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Codex readonly ask turn/completed",
        });

        expectWriteApprovalRequest(ctx.interactiveRequests);
        expect(readFileSync(filePath, "utf8")).toBe(token);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "routes Codex readonly file edits through semantic file-change approvals",
    async () => {
      const ctx = createTestRuntime("codex", {
        onInteractiveRequest: createApprovalResolution,
      });
      const fileName = createTempFileName("codex-readonly-file-change");
      const filePath = join(ctx.tmpDir, fileName);
      const token = createToken("CODEX_FILE_CHANGE_APPROVED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "codex",
          preset: "readonly-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "codex",
          options,
          instructions:
            "When the user asks you to edit a file, use your file editing capability. Do not run shell commands for file edits. If approval is needed, request approval; it will be approved.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_2222222237",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Create a file named ${fileName} in the current workspace. ` +
                `The file content must be exactly ${token} with no trailing newline. ` +
                "Do not run shell commands. After the file is written, reply with exactly DONE.",
            },
          ],
        });

        await waitForInteractiveRequestBeforeTurnCompletion({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 45_000,
          label: "Codex readonly file-change approval",
        });
        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Codex readonly file-change turn/completed",
        });

        const fileChangeApproval = ctx.interactiveRequests.find(
          (request) =>
            hasApprovalSubjectKind(request, "file_change") &&
            hasAvailableApprovalDecision(request, "allow_once"),
        );
        expect(
          fileChangeApproval,
          `Expected a Codex file-change approval; got ${JSON.stringify(
            ctx.interactiveRequests.map((request) => request.payload),
          )}`,
        ).toBeDefined();
        if (
          !fileChangeApproval ||
          !isApprovalPendingInteractionPayload(fileChangeApproval.payload) ||
          fileChangeApproval.payload.subject.kind !== "file_change"
        ) {
          throw new Error("Expected a semantic file-change approval");
        }
        expect(fileChangeApproval.payload.subject.kind).toBe("file_change");
        expect(fileChangeApproval.payload.subject.itemId).toEqual(
          expect.any(String),
        );
        expect(
          fileChangeApproval.payload.subject.writeScope,
        ).not.toBeUndefined();
        expect(
          fileChangeApproval.payload.subject.sessionGrant,
        ).not.toBeUndefined();
        expect(fileChangeApproval.payload.availableDecisions).toContain(
          "allow_once",
        );
        expect(Object.keys(fileChangeApproval.payload.subject).sort()).toEqual([
          "itemId",
          "kind",
          "sessionGrant",
          "writeScope",
        ]);
        expect(readFileSync(filePath, "utf8").trimEnd()).toBe(token);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "respects user-denied Codex command approvals in readonly ask mode",
    async () => {
      const ctx = createTestRuntime("codex", {
        onInteractiveRequest: async (request) => {
          if (
            !isApprovalPendingInteractionPayload(request.payload) ||
            request.payload.subject.kind !== "command"
          ) {
            throw new Error(
              `Expected command approval, got ${describePendingInteractionPayload(request)}`,
            );
          }
          if (!request.payload.availableDecisions.includes("deny")) {
            throw new Error("Codex command approval did not offer deny");
          }
          return {
            decision: "deny",
          };
        },
      });
      const fileName = createTempFileName("codex-readonly-user-denied");
      const filePath = join(ctx.tmpDir, fileName);
      const token = createToken("CODEX_READONLY_USER_DENIED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "codex",
          preset: "readonly-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "codex",
          options,
          instructions:
            "When the user asks you to run an exact shell command, run that shell command exactly once. If approval is denied, say DENIED.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_2222222238",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Run this exact shell command: printf '${token}' > ${fileName}. ` +
                "If approval is denied, reply with exactly DENIED.",
            },
          ],
        });

        await waitForInteractiveRequestBeforeTurnCompletion({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 45_000,
          label: "Codex user-denied command approval",
        });
        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Codex user-denied turn/completed",
        });

        expect(
          ctx.interactiveRequests.some(
            (request) => hasApprovalSubjectKind(request, "command"),
          ),
        ).toBe(true);
        expect(hasDeniedCommandExecution(ctx.events)).toBe(true);
        expect(existsSync(filePath)).toBe(false);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "blocks Codex readonly workspace writes without interactive requests when escalation is deny",
    async () => {
      const ctx = createTestRuntime("codex");
      const fileName = createTempFileName("codex-readonly-denied");
      const filePath = join(ctx.tmpDir, fileName);
      const token = createToken("CODEX_READONLY_DENIED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "codex",
          preset: "readonly-deny",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "codex",
          options,
          instructions:
            "When the user asks you to run an exact shell command, run that shell command exactly once and then report DONE.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_2222222239",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Run this exact shell command: printf '${token}' > ${fileName}. ` +
                "If it is denied, say DENIED.",
            },
          ],
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Codex readonly deny turn/completed",
        });

        expect(ctx.interactiveRequests).toHaveLength(0);
        expect(existsSync(filePath)).toBe(false);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "routes Codex readonly network requests through semantic approvals",
    async () => {
      const ctx = createTestRuntime("codex", {
        onInteractiveRequest: createApprovalResolution,
      });

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "codex",
          preset: "readonly-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "codex",
          options,
          instructions:
            "When the user asks you to run an exact shell command, run that shell command exactly once. If approval is needed, request approval; it will be approved. Then report DONE.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_222222223a",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                "Run this exact shell command: curl -L --max-time 10 https://example.com >/dev/null. " +
                "If approval is needed, request approval. After the command finishes, reply with exactly DONE.",
            },
          ],
        });

        await waitForInteractiveRequestBeforeTurnCompletion({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 45_000,
          label: "Codex readonly network approval",
        });
        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Codex readonly network turn/completed",
        });

        const commandApproval = ctx.interactiveRequests.find(
          (request) =>
            hasApprovalSubjectKind(request, "command") &&
            hasAvailableApprovalDecision(request, "allow_once"),
        );
        expect(
          commandApproval,
          `Expected a Codex command approval for network access; got ${JSON.stringify(
            ctx.interactiveRequests.map((request) => request.payload),
          )}`,
        ).toBeDefined();
        if (
          !commandApproval ||
          !isApprovalPendingInteractionPayload(commandApproval.payload) ||
          commandApproval.payload.subject.kind !== "command"
        ) {
          throw new Error("Expected a semantic command approval");
        }
        expect(commandApproval.payload.subject.sessionGrant).toBeNull();
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "routes Claude readonly Bash mutations through onInteractiveRequest when escalation is ask",
    async () => {
      const ctx = createTestRuntime("claude-code", {
        onInteractiveRequest: createApprovalResolution,
      });
      const fileName = "note.txt";
      const filePath = join(ctx.tmpDir, fileName);
      const token = "sample text";

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "readonly-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "claude-code",
          options,
          instructions:
            "Use the Bash tool when the user explicitly asks for Bash. Do not use another tool.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_222222223b",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Use Bash to run exactly: printf '${token}' > ${fileName}. ` +
                "After the command finishes, reply with exactly DONE.",
            },
          ],
        });

        await waitForInteractiveRequestBeforeTurnCompletion({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 45_000,
          label: "Claude readonly permission request",
        });
        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Claude readonly ask turn/completed",
        });

        const commandApproval = ctx.interactiveRequests.find(
          (request) =>
            hasApprovalSubjectKind(request, "command") &&
            hasAvailableApprovalDecision(request, "allow_once") &&
            hasAvailableApprovalDecision(request, "deny"),
        );
        expect(commandApproval).toBeDefined();
        if (
          !commandApproval ||
          !isApprovalPendingInteractionPayload(commandApproval.payload) ||
          commandApproval.payload.subject.kind !== "command"
        ) {
          throw new Error("Expected a semantic command approval");
        }
        expect(commandApproval.payload.subject.actions).toContainEqual({
          type: "unknown",
          command: expect.stringContaining("printf"),
        });
        expect(commandApproval.payload.subject.command).toContain("printf");
        expect(readFileSync(filePath, "utf8")).toBe(token);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "routes Claude readonly Write tool mutations through onInteractiveRequest when escalation is ask",
    async () => {
      const ctx = createTestRuntime("claude-code", {
        onInteractiveRequest: createApprovalResolution,
      });
      const fileName = createTempFileName("claude-readonly-write-tool");
      const filePath = join(ctx.tmpDir, fileName);
      const token = createToken("CLAUDE_READONLY_WRITE_TOOL_APPROVED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "readonly-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "claude-code",
          options,
          instructions:
            "Use the Write tool when the user explicitly asks for Write. Do not substitute Bash.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_222222223c",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Use the Write tool to create exactly this file: ${filePath}. ` +
                `The file content must be exactly ${token} with no trailing newline. ` +
                "Do not use Bash. After the file is written, reply with exactly DONE.",
            },
          ],
        });

        await waitForInteractiveRequestBeforeTurnCompletion({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 45_000,
          label: "Claude readonly Write permission request",
        });
        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Claude readonly Write ask turn/completed",
        });

        const fileChangeApproval = ctx.interactiveRequests.find(
          (request) =>
            hasApprovalSubjectKind(request, "file_change") &&
            hasAvailableApprovalDecision(request, "allow_once") &&
            hasAvailableApprovalDecision(request, "deny"),
        );
        expect(fileChangeApproval).toBeDefined();
        if (
          !fileChangeApproval ||
          !isApprovalPendingInteractionPayload(fileChangeApproval.payload) ||
          fileChangeApproval.payload.subject.kind !== "file_change"
        ) {
          throw new Error("Expected a semantic file-change approval");
        }
        expect(fileChangeApproval.payload.subject.sessionGrant).toEqual({
          network: null,
          fileSystem: null,
        });
        expect(readFileSync(filePath, "utf8")).toBe(token);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "applies Claude allow_for_session approvals to later WebFetch calls in the same session",
    async () => {
      const ctx = createTestRuntime("claude-code", {
        onInteractiveRequest: createApprovalResolution,
      });
      const fetchUrl = "https://example.com";

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "readonly-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "claude-code",
          options,
          instructions:
            "Use the WebFetch tool when the user explicitly asks for WebFetch. Do not substitute Bash or any other tool.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_222222223d",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Use WebFetch to fetch ${fetchUrl}. ` +
                "After the fetch finishes, reply with exactly FIRST_DONE.",
            },
          ],
        });

        await waitForInteractiveRequestBeforeTurnCompletion({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 45_000,
          label: "Claude session WebFetch approval",
        });
        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Claude session first WebFetch turn/completed",
        });

        const firstRequestCount = ctx.interactiveRequests.length;
        expect(
          ctx.interactiveRequests.some(
            (request) => {
              if (
                !isApprovalPendingInteractionPayload(request.payload) ||
                request.payload.subject.kind !== "permission_grant"
              ) {
                return false;
              }
              return (
                request.payload.subject.toolName === "WebFetch" &&
                request.payload.availableDecisions.includes(
                  "allow_for_session",
                )
              );
            },
          ),
          `Expected a session-capable WebFetch permission approval; got ${JSON.stringify(
            ctx.interactiveRequests.map((request) => request.payload),
          )}`,
        ).toBe(true);

        await ctx.runtime.runTurn({
          clientRequestId: "creq_222222223e",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Use WebFetch to fetch ${fetchUrl} again. ` +
                "After the fetch finishes, reply with exactly SECOND_DONE.",
            },
          ],
        });

        await waitForThreadTurnCompletedCount({
          ctx,
          threadId,
          count: 2,
          timeoutMs: 45_000,
          label: "Claude session second WebFetch turn/completed",
        });

        expect(
          ctx.interactiveRequests,
          `Expected no new WebFetch approvals; got ${JSON.stringify(
            ctx.interactiveRequests.map((request) => request.payload),
          )}`,
        ).toHaveLength(firstRequestCount);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    90_000,
  );

  it.concurrent(
    "respects user-denied Claude permission requests in readonly ask mode",
    async () => {
      const ctx = createTestRuntime("claude-code", {
        onInteractiveRequest: async (request) => {
          return {
            decision: "deny",
          };
        },
      });
      const fileName = createTempFileName("claude-readonly-user-denied");
      const filePath = join(ctx.tmpDir, fileName);
      const token = createToken("CLAUDE_READONLY_USER_DENIED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "readonly-ask",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "claude-code",
          options,
          instructions:
            "Use the Bash tool when the user explicitly asks for Bash. Do not use another tool.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_222222223f",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                "This is a local integration test in an empty temporary workspace. " +
                `Use Bash to run exactly: printf '${token}' > ${fileName}. ` +
                "If permission is denied by the harness, reply with exactly DENIED.",
            },
          ],
        });

        await waitForInteractiveRequestBeforeTurnCompletion({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 45_000,
          label: "Claude user-denied permission request",
        });
        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Claude user-denied turn/completed",
        });

        expect(
          ctx.interactiveRequests.some(
            (request) => hasApprovalSubjectKind(request, "command"),
          ),
        ).toBe(true);
        expect(existsSync(filePath)).toBe(false);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent(
    "blocks Claude readonly Bash mutations without interactive requests when escalation is deny",
    async () => {
      const ctx = createTestRuntime("claude-code");
      const fileName = createTempFileName("claude-readonly-denied");
      const filePath = join(ctx.tmpDir, fileName);
      const token = createToken("CLAUDE_READONLY_DENIED");

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "readonly-deny",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId: "claude-code",
          options,
          instructions:
            "Use the Bash tool when the user explicitly asks for Bash. Do not use another tool.",
        });

        await ctx.runtime.runTurn({
          clientRequestId: "creq_222222223g",
          threadId,
          options,
          input: [
            {
              type: "text",
              text:
                `Use Bash to run exactly: printf '${token}' > ${fileName}. ` +
                "If it is denied, say DENIED.",
            },
          ],
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 45_000,
          label: "Claude readonly deny turn/completed",
        });

        expect(ctx.interactiveRequests).toHaveLength(0);
        expect(existsSync(filePath)).toBe(false);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    },
    75_000,
  );

  it.concurrent("keeps Pi limited to full permission mode", () => {
    const piProvider = listAvailableProviderInfos().find(
      (provider) => provider.id === "pi",
    );

    expect(piProvider?.capabilities.supportedPermissionModes).toEqual(["full"]);
  });
});
