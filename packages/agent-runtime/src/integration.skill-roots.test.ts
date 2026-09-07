import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeSkillRoot } from "./types.js";
import {
  cleanup,
  createTestRuntime,
  getThreadText,
  newThreadId,
  resolveRuntimeOptions,
  waitForThreadTurnCompleted,
} from "./test/runtime-integration-harness.js";
import { promptTextInput } from "./test/prompt-input.js";

type SkillRootProviderId = "claude-code" | "codex" | "pi";

const providers: readonly SkillRootProviderId[] = [
  "codex",
  "claude-code",
  "pi",
];
const skillName = "bb-runtime-skill-integration";
const skillDescription =
  "Use when asked for the BB runtime dynamic skill integration token.";

interface CreateSkillRootArgs {
  token: string;
  workspacePath: string;
}

function createSkillMarkdown(token: string): string {
  return [
    "---",
    `name: ${skillName}`,
    `description: ${skillDescription}`,
    "---",
    "",
    "# BB Runtime Skill Integration",
    "",
    "When asked for the runtime skill integration token, reply with exactly:",
    token,
    "",
  ].join("\n");
}

function createSkillRoot(args: CreateSkillRootArgs): AgentRuntimeSkillRoot {
  const rootPath = join(args.workspacePath, "skill-roots");
  mkdirSync(join(rootPath, skillName), { recursive: true });
  writeFileSync(
    join(rootPath, skillName, "SKILL.md"),
    createSkillMarkdown(args.token),
    "utf8",
  );
  return {
    id: skillName,
    path: rootPath,
    skills: [{ name: skillName, description: skillDescription }],
  };
}

for (const providerId of providers) {
  describe.concurrent(`${providerId} provider skill roots`, () => {
    it("uses a runtime-injected skill root", async () => {
      const workspacePath = mkdtempSync(
        join(tmpdir(), `bb-integ-skill-${providerId}-`),
      );
      const token = `BB_SKILL_TOKEN_${randomUUID()
        .replaceAll("-", "")
        .toUpperCase()}`;
      const skillRoot = createSkillRoot({ token, workspacePath });
      const ctx = createTestRuntime(providerId, {
        skillRoots: [skillRoot],
        workspacePath,
      });

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId,
          preset: "full",
        });
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options,
          instructions:
            "When asked for a runtime skill integration token, use the named skill and return the token from that skill.",
        });

        await ctx.runtime.runTurn({
          threadId,
          clientRequestId: "creq_23456789ab",
          options,
          input: [
            promptTextInput({
              text:
                `Use the available skill named ${skillName}. ` +
                "Reply with exactly the runtime skill integration token from that skill and nothing else.",
            }),
          ],
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 75_000,
          label: "skill-root turn/completed",
        });

        expect(getThreadText(ctx.events, threadId)).toContain(token);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
        rmSync(workspacePath, { recursive: true, force: true });
      }
    }, 80_000);
  });
}
