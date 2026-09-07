import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { createAgentRuntime } from "./runtime.js";
import {
  createScriptedEchoLaunch,
  createScriptedEchoRequestRecord,
  fullRuntimeOptions,
  waitForThreadAgentMessageText,
  withBridgeLaunch,
} from "./test/runtime-test-harness.js";
import { promptTextInput } from "./test/prompt-input.js";
import type { AgentRuntime } from "./types.js";

const echoExampleBridgePath = fileURLToPath(
  new URL(
    "../../../examples/plugins/echo-provider/src/provider-bridge.ts",
    import.meta.url,
  ),
);

describe("skills/configure handshake capability", () => {
  let workspacePath: string;
  const runtimes: AgentRuntime[] = [];

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "bb-skill-capability-"));
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    rmSync(workspacePath, { recursive: true, force: true });
  });

  function stageSkillRoot(): string {
    const root = join(workspacePath, "skills");
    mkdirSync(join(root, "demo"), { recursive: true });
    writeFileSync(join(root, "demo", "SKILL.md"), "---\nname: demo\n---\n");
    return root;
  }

  it("starts a thread on a bridge that does not declare skills.configure, without sending the request", async () => {
    const events: ThreadEvent[] = [];
    const record = createScriptedEchoRequestRecord();
    const runtime = withBridgeLaunch(
      createAgentRuntime({
        workspacePath,
        env: record.env,
        skillRoots: [
          {
            id: "global-skills:builtin",
            path: stageSkillRoot(),
            skills: [{ name: "demo", description: "A demo skill." }],
          },
        ],
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({ contentItems: [], success: true }),
      }),
      createScriptedEchoLaunch({
        pluginId: "echo-provider-example",
        modulePath: echoExampleBridgePath,
        capabilities: {
          supportsThreadArchive: false,
          supportsThreadRename: false,
          fork: "none",
        },
      }),
    );
    runtimes.push(runtime);

    await runtime.startThread({
      environmentId: "env-1",
      projectId: "p1",
      providerId: "echo-agent",
      threadId: "t1",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_skcapab222",
      threadId: "t1",
      input: [promptTextInput({ text: "hello" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "echo-agent",
      runtime,
      text: "hello",
      threadId: "t1",
    });
    expect(runtime.hasThread("t1")).toBe(true);
  });

  it("sends skills/configure before thread/start to a bridge that declares it", async () => {
    const record = createScriptedEchoRequestRecord();
    const runtime = withBridgeLaunch(
      createAgentRuntime({
        workspacePath,
        env: record.env,
        skillRoots: [
          { id: "global-skills:builtin", path: stageSkillRoot(), skills: [] },
        ],
        onEvent: () => {},
        onToolCall: async () => ({ contentItems: [], success: true }),
      }),
      createScriptedEchoLaunch(),
    );
    runtimes.push(runtime);
    await runtime.startThread({
      environmentId: "env-1",
      projectId: "p1",
      providerId: "fake",
      threadId: "t1",
      options: fullRuntimeOptions,
    });
    const methods = record.read().map((entry) => entry.method);
    expect(methods.indexOf("skills/configure")).toBeGreaterThan(-1);
    expect(methods.indexOf("skills/configure")).toBeLessThan(
      methods.indexOf("thread/start"),
    );
  });

  it("rejects a relative skill root path", () => {
    expect(() =>
      createAgentRuntime({
        workspacePath,
        skillRoots: [{ id: "rel", path: "staged/skills", skills: [] }],
        onEvent: () => {},
        onToolCall: async () => ({ contentItems: [], success: true }),
      }),
    ).toThrow(/must use an absolute path: staged\/skills/);
  });
});
