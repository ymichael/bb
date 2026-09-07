import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

let harness: FakePiBridgeHarness;
let dumpPath: string;

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-tool-schema-",
    initialize: true,
  });
  dumpPath = join(harness.workspaceDir, "tools.ndjson");
  vi.stubEnv("FAKE_PI_TOOLS_DUMP", dumpPath);
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

it("carries descriptions, unions, constants, integers, and closed objects into the registered tool", async () => {
  await harness.request(1, "thread/start", {
    threadId: "thr_schema",
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
    dynamicTools: [
      {
        name: "bb_rich",
        description: "A richly typed bb tool.",
        inputSchema: {
          type: "object",
          description: "The call.",
          additionalProperties: false,
          required: ["mode", "count"],
          properties: {
            mode: {
              type: "string",
              enum: ["fast", "slow"],
              description: "How fast.",
            },
            count: { type: "integer", description: "How many.", minimum: 1 },
            label: {
              type: ["string", "null"],
              description: "An optional label.",
            },
            target: {
              description: "A path or an id.",
              anyOf: [
                {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
                {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                },
              ],
            },
            kind: { const: "file", description: "Always file." },
          },
        },
      },
    ],
  });
  expect(existsSync(dumpPath)).toBe(true);
  const registered = readFileSync(dumpPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        },
    );
  const tool = registered.find((entry) => entry.name === "bb_rich");
  expect(tool).toBeDefined();
  expect(tool!.description).toBe("A richly typed bb tool.");
  const parameters = tool!.parameters as {
    description?: string;
    additionalProperties?: boolean;
    required?: string[];
    properties: Record<string, Record<string, unknown>>;
  };
  expect(parameters.description).toBe("The call.");
  expect(parameters.additionalProperties).toBe(false);
  expect(parameters.required).toEqual(["mode", "count"]);
  expect(parameters.properties.mode).toMatchObject({
    description: "How fast.",
    anyOf: [{ const: "fast" }, { const: "slow" }],
  });
  expect(parameters.properties.count).toMatchObject({
    type: "integer",
    description: "How many.",
  });
  expect(parameters.properties.label).toMatchObject({
    description: "An optional label.",
    anyOf: [{ type: "string" }, { type: "null" }],
  });
  expect(parameters.properties.target).toMatchObject({
    description: "A path or an id.",
    anyOf: [
      {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    ],
  });
  expect(parameters.properties.kind).toMatchObject({
    const: "file",
    description: "Always file.",
  });
}, 30_000);
