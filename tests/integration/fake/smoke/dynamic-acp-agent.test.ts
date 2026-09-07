import path from "node:path";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { systemExecutionOptionsResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { getThreadOutput, sendTextMessage } from "../../helpers/api.js";
import {
  waitForHostConnected,
  waitForThreadOutputContaining,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness, type IntegrationHarness } from "../../helpers/harness.js";
import { registerConfiguredAcpProvider } from "../../../../apps/server/test/helpers/provider-registry.js";
import { scaleTimeoutMs } from "../../helpers/time.js";
import {
  createProjectFixture,
  createReadyThread,
  DEFAULT_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./shared.js";

const DYNAMIC_ACP_TEST_TIMEOUT_MS = scaleTimeoutMs(120_000);

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/dynamic-acp-agent.mjs",
);
chmodSync(fixturePath, 0o755);

async function registerDynamicAcpAgents(
  harness: IntegrationHarness,
): Promise<void> {
  const registry = harness.server.providerRegistry;
  await registerConfiguredAcpProvider(registry, {
    id: "smoke",
    displayName: "Smoke ACP",
    command: fixturePath,
    args: [],
    env: { BB_DYNAMIC_ACP_SMOKE: "thread" },
    modelCli: {
      listArgs: ["--list-models"],
      selectFlag: "--model",
      primaryModels: ["bb-dynamic-smoke-medium"],
    },
  });
  await registerConfiguredAcpProvider(registry, {
    id: "nomodelcli",
    displayName: "No Model CLI ACP",
    command: fixturePath,
    args: [],
    env: {},
  });
}

describe.sequential("dynamic ACP integration smoke", () => {
  it(
    "spawns configured ACP agents for model list, start, submit, and lazy resume",
    () =>
      withHarness(async (harness) => {
        await registerDynamicAcpAgents(harness);

        const providersResponse = await harness.api.system.providers.$get({});
        expect(providersResponse.status).toBe(200);
        const providers = await providersResponse.json();
        expect(providers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "acp-smoke",
              displayName: "Smoke ACP",
            }),
            expect.objectContaining({
              id: "acp-nomodelcli",
              displayName: "No Model CLI ACP",
            }),
          ]),
        );

        const listedModelsResponse = await harness.api.system[
          "execution-options"
        ].$get({
          query: { hostId: harness.hostId, providerId: "acp-smoke" },
        });
        expect(listedModelsResponse.status).toBe(200);
        const listedOptions = systemExecutionOptionsResponseSchema.parse(
          await listedModelsResponse.json(),
        );
        expect(listedOptions.modelLoadError).toBeNull();
        expect(listedOptions.providers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "acp-smoke",
              displayName: "Smoke ACP",
            }),
          ]),
        );
        expect(listedOptions.models.map((model) => model.model)).toContain(
          "bb-dynamic-smoke-medium",
        );

        const defaultModelsResponse = await harness.api.system[
          "execution-options"
        ].$get({
          query: { hostId: harness.hostId, providerId: "acp-nomodelcli" },
        });
        expect(defaultModelsResponse.status).toBe(200);
        const defaultOptions = systemExecutionOptionsResponseSchema.parse(
          await defaultModelsResponse.json(),
        );
        expect(defaultOptions.modelLoadError).toBeNull();
        expect(defaultOptions.models.map((model) => model.model)).toEqual([
          "bb-dynamic-acp-native-default",
          "bb-dynamic-acp-native-strong",
        ]);
        expect(defaultOptions.models.map((model) => model.model)).not.toEqual([
          "acp-default",
        ]);

        const project = await createProjectFixture(
          harness,
          "Dynamic ACP Smoke",
        );
        const { thread: nativeThread } = await createReadyThread(harness, {
          execution: {
            model: "bb-dynamic-acp-native-strong",
            reasoningLevel: "medium",
            permissionMode: "accept-edits",
          },
          input: [{ type: "text", text: "native selection", mentions: [] }],
          projectId: project.id,
          providerId: "acp-nomodelcli",
          workspace: {
            type: "unmanaged",
            path: harness.repoDir,
          },
        });

        await waitForThreadOutputContaining(
          harness.api,
          nativeThread.id,
          "dynamic-acp:model=bb-dynamic-acp-native-strong:native selection",
          TURN_TIMEOUT_MS,
        );

        const { thread } = await createReadyThread(harness, {
          execution: {
            model: "bb-dynamic-smoke-medium",
            reasoningLevel: "medium",
            permissionMode: "accept-edits",
          },
          input: [{ type: "text", text: "start launch spec", mentions: [] }],
          projectId: project.id,
          providerId: "acp-smoke",
          workspace: {
            type: "unmanaged",
            path: harness.repoDir,
          },
        });

        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "dynamic-acp:model=bb-dynamic-smoke-medium:start launch spec",
          TURN_TIMEOUT_MS,
        );

        await sendTextMessage(harness.api, thread.id, {
          execution: {
            model: "bb-dynamic-smoke-medium",
            reasoningLevel: "medium",
            permissionMode: "accept-edits",
          },
          text: "submit launch spec",
        });
        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "dynamic-acp:model=bb-dynamic-smoke-medium:submit launch spec",
          TURN_TIMEOUT_MS,
        );
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        );

        await harness.restartDaemon("dynamic-acp-resume");
        await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);

        await sendTextMessage(harness.api, thread.id, {
          execution: {
            model: "bb-dynamic-smoke-medium",
            reasoningLevel: "medium",
            permissionMode: "accept-edits",
          },
          text: "resume launch spec",
        });
        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "dynamic-acp:model=bb-dynamic-smoke-medium:resume launch spec",
          TURN_TIMEOUT_MS,
        );

        const output = await getThreadOutput(harness.api, thread.id);
        expect(output).toContain(
          "dynamic-acp:model=bb-dynamic-smoke-medium:resume launch spec",
        );
      }),
    DYNAMIC_ACP_TEST_TIMEOUT_MS,
  );
});
