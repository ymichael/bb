import { readFile } from "node:fs/promises";
import {
  bridgeCapabilitiesSchema,
  bridgeExecutionOptionsSchema,
  providerRecoveryNotificationSchema,
} from "@bb/provider-bridge-protocol";
import {
  providerRecoveryKindValues,
  threadEventDelegationItemSchema,
  threadEventItemPresentationSchema,
  type ThreadEventItemPresentation,
} from "@bb/domain";
import {
  timelineCommandWorkRowSchema,
  type TimelineCommandWorkRow,
} from "@bb/server-contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { PluginAppSlots } from "../app-contract.js";
import type {
  PluginProviderCapabilities,
  PluginProviderDeclaration,
  PluginProviderStrings,
} from "../backend-contract.js";
import * as providerBridgeSdk from "../provider-bridge.js";
import * as providerBridgeTestingSdk from "../provider-bridge-testing.js";

const DOC_URL = new URL(
  "../../../../docs/provider-plugin-api.md",
  import.meta.url,
);

type Gap = { gap: `WS${string}` };

type DeclarationPath =
  | keyof PluginProviderDeclaration
  | `capabilities.${keyof PluginProviderCapabilities}`
  | `strings.${keyof PluginProviderStrings}`;

const REGISTRATION_FIELDS = {
  id: "id",
  displayName: "displayName",
  family: "family",
  icon: "icon",
  strings: "strings",
  signInHint: "strings.signInHint",
  expiredHint: "strings.expiredHint",
  installUrl: "strings.installUrl",
  brandPrefix: "strings.brandPrefix",
  planModeCopy: "strings.planModeCopy",
  iconTint: "strings.iconTint",
  capabilities: "capabilities",
  permissionModes: "capabilities.permissionModes",
  reasoningLevels: "reasoningLevels",
  serviceTiers: "serviceTiers",
  fork: "capabilities.fork",
  supportsNativeUserQuestion: "capabilities.supportsNativeUserQuestion",
  supportsManualCompaction: "capabilities.supportsManualCompaction",
  supportsThreadArchive: "capabilities.supportsThreadArchive",
  supportsThreadRename: "capabilities.supportsThreadRename",
  supportsServiceTier: "capabilities.supportsServiceTier",
  maintenance: "maintenance",
  composerActions: "composerActions",
  extensionKinds: "extensionKinds",
  models: "models",
  env: "env",
  deriveProviderOptions: "deriveProviderOptions",
} as const satisfies Record<string, DeclarationPath | Gap>;

type DeclarationGapKeys = {
  [
    K in keyof typeof REGISTRATION_FIELDS
  ]: (typeof REGISTRATION_FIELDS)[K] extends Gap ? K : never;
}[keyof typeof REGISTRATION_FIELDS];
type DeclarationGapsNotLanded = Extract<
  DeclarationGapKeys,
  keyof PluginProviderDeclaration | keyof PluginProviderCapabilities
>;

const HANDSHAKE_FIELDS = {
  grammarVersions: "grammarVersions",
  sessionRestore: "sessionRestore",
  threadArchive: "threadArchive",
  threadRename: "threadRename",
  threadGoalClear: "threadGoalClear",
  fork: "fork",
  approvalEnforcedBy: "approvalEnforcedBy",
  steerMode: "steerMode",
  skills: "skills",
} as const satisfies Record<
  string,
  keyof z.infer<typeof bridgeCapabilitiesSchema> | Gap
>;

const EXECUTION_OPTION_FIELDS = {
  model: "model",
  serviceTier: "serviceTier",
  reasoningLevel: "reasoningLevel",
  promptMode: "promptMode",
  instructions: "instructions",
  providerOptions: "providerOptions",
} as const satisfies Record<
  string,
  keyof z.infer<typeof bridgeExecutionOptionsSchema> | Gap
>;

const RECOVERY_FIELDS = {
  kind: "kind",
  message: "message",
  retryable: "retryable",
} as const satisfies Record<
  string,
  keyof z.infer<typeof providerRecoveryNotificationSchema> | Gap
>;

const DELEGATION_FIELDS = {
  childRef: "childRef",
  label: "label",
  status: "status",
  background: "background",
  summary: "summary",
} as const satisfies Record<
  string,
  keyof z.infer<typeof threadEventDelegationItemSchema> | Gap
>;

type PresentationPath =
  | "presentation"
  | keyof ThreadEventItemPresentation
  | `label.${keyof ThreadEventItemPresentation["label"]}`
  | `icon.${keyof ThreadEventItemPresentation["icon"]}`
  | `tint.${keyof NonNullable<ThreadEventItemPresentation["tint"]>}`;

const PRESENTATION_FIELDS = {
  presentation: "presentation",
  label: "label",
  pending: "label.pending",
  completed: "label.completed",
  icon: "icon",
  glyph: "icon.glyph",
  title: "title",
  detail: "detail",
  suppress: "suppress",
  tint: "tint",
  light: "tint.light",
  dark: "tint.dark",
} as const satisfies Record<string, PresentationPath | Gap>;

const TIMELINE_ROW_FIELDS = {
  kind: "kind",
  payload: {
    gap: "WS3 (projection): one folded `payload` for every kind; rows stay typed per kind and only extension rows carry `payload`",
  },
  presentation: "presentation",
} as const satisfies Record<string, keyof TimelineCommandWorkRow | Gap>;
type TimelineRowGapsNotLanded = Extract<
  "payload",
  keyof TimelineCommandWorkRow
>;

type TimelineRendererSlot = PluginAppSlots["experimental_timelineRenderer"];

function extractTsBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/gu)].map(
    (match) => match[1] ?? "",
  );
}

function fieldNames(block: string): string[] {
  const names = new Set<string>();
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/u, "");
    const match = /^\s*\{?\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*[:(]/u.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].sort();
}

function bareFieldNames(block: string): string[] {
  const body = block.replace(/\/\/.*$/gmu, "").split("&")[0] ?? "";
  return [
    ...new Set(
      [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\??(?=\s*(?:,|:|\}))/gu)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ].sort();
}

function isGap(value: unknown): value is Gap {
  return typeof value === "object" && value !== null && "gap" in value;
}

function landedKeys(map: Record<string, unknown>): string[] {
  return Object.keys(map).filter((key) => !isGap(map[key]));
}

function gapKeys(map: Record<string, unknown>): string[] {
  return Object.keys(map).filter((key) => isGap(map[key]));
}

function schemaKeys(schema: z.ZodType): Set<string> {
  const def = schema._zod.def;
  if (def.type === "object") {
    const shape = Reflect.get(def, "shape");
    return new Set(
      typeof shape === "object" && shape !== null ? Object.keys(shape) : [],
    );
  }
  if (def.type === "intersection") {
    const left = Reflect.get(def, "left");
    const right = Reflect.get(def, "right");
    return new Set([
      ...(left ? schemaKeys(left as z.ZodType) : []),
      ...(right ? schemaKeys(right as z.ZodType) : []),
    ]);
  }
  return new Set();
}

function expectGapsNotLanded(
  map: Record<string, unknown>,
  present: Set<string>,
  where: string,
): void {
  const landed = gapKeys(map).filter((key) => present.has(key));
  expect(
    landed,
    `${where}: these doc fields are marked as gaps but now exist — move them from { gap } to their real path`,
  ).toEqual([]);
}

function expectLandedPresent(
  map: Record<string, string | Gap>,
  present: Set<string>,
  where: string,
): void {
  const missing = landedKeys(map).filter((key) => {
    const path = map[key];
    if (isGap(path) || path === undefined) return false;
    const root = path.split(".")[0] ?? path;
    return !present.has(root);
  });
  expect(
    missing,
    `${where}: the doc names these fields but the schema no longer has them`,
  ).toEqual([]);
}

describe("guardrail G10: docs/provider-plugin-api.md matches the contract", () => {
  it("has exactly the code blocks this test maps, in order", async () => {
    const blocks = extractTsBlocks(await readFile(DOC_URL, "utf8"));
    const headings = blocks.map((block) => block.split("\n")[0]?.trim());
    expect(headings).toEqual([
      "bb.providers.register({",
      "export const experimental_providerBridge = experimental_defineProviderBridge({",
      "{",
      "{ model, serviceTier?, reasoningLevel, promptMode?, instructions,",
      "// provider/recovery",
      "{ childRef: string, label: string, status: ItemStatus,",
      "presentation: {",
      "TimelineRow { kind: string, payload, presentation }",
      "app.slots.experimental_timelineRenderer({ kind, component })",
    ]);
  });

  it("§1 registration fields map onto PluginProviderDeclaration or a named gap", async () => {
    const [registration] = extractTsBlocks(await readFile(DOC_URL, "utf8"));
    expect(fieldNames(registration ?? "")).toEqual(
      Object.keys(REGISTRATION_FIELDS).sort(),
    );
    expectTypeOf<DeclarationGapsNotLanded>().toBeNever();
  });

  it("§2 the bridge entry point is exported from @get-bb/plugin-sdk/provider-bridge", () => {
    expect(typeof providerBridgeSdk.experimental_defineProviderBridge).toBe(
      "function",
    );
  });

  it("§2 the assembler ships with the conformance kit and JSON-RPC harness as provider-bridge/testing", () => {
    expect(
      typeof providerBridgeTestingSdk.experimental_createDeltaAssembler,
    ).toBe("function");
    expect(
      typeof providerBridgeTestingSdk.experimental_runBridgeConformance,
    ).toBe("function");
    expect(
      typeof providerBridgeTestingSdk.experimental_createBridgeJsonRpcTestHarness,
    ).toBe("function");
    expect(
      typeof providerBridgeTestingSdk.experimental_normalizeCalibrationEvents,
    ).toBe("function");
  });

  it("§2 handshake, execution options and recovery fields match the protocol schemas", async () => {
    const [, , handshake, executionOptions, recovery] = extractTsBlocks(
      await readFile(DOC_URL, "utf8"),
    );
    expect(fieldNames(handshake ?? "")).toEqual(
      Object.keys(HANDSHAKE_FIELDS).sort(),
    );
    const capabilityKeys = schemaKeys(bridgeCapabilitiesSchema);
    expectLandedPresent(HANDSHAKE_FIELDS, capabilityKeys, "handshake");
    expectGapsNotLanded(HANDSHAKE_FIELDS, capabilityKeys, "handshake");

    expect(
      bareFieldNames(executionOptions ?? "").filter(
        (name) => name !== "JsonValue",
      ),
    ).toEqual(Object.keys(EXECUTION_OPTION_FIELDS).sort());
    const optionKeys = schemaKeys(bridgeExecutionOptionsSchema);
    expectLandedPresent(
      EXECUTION_OPTION_FIELDS,
      optionKeys,
      "execution options",
    );
    expectGapsNotLanded(
      EXECUTION_OPTION_FIELDS,
      optionKeys,
      "execution options",
    );

    const recoveryBlock = recovery ?? "";
    expect(fieldNames(recoveryBlock.replaceAll(",", ",\n"))).toEqual(
      Object.keys(RECOVERY_FIELDS).sort(),
    );
    const recoveryKeys = schemaKeys(providerRecoveryNotificationSchema);
    expectLandedPresent(RECOVERY_FIELDS, recoveryKeys, "provider/recovery");
    const documentedKinds = [...recoveryBlock.matchAll(/"([A-Za-z]+)"/gu)]
      .map((match) => match[1])
      .sort();
    expect(documentedKinds).toEqual([...providerRecoveryKindValues].sort());
  });

  it("§3 delegation and presentation fields match the domain schemas", async () => {
    const [, , , , , delegation, presentation] = extractTsBlocks(
      await readFile(DOC_URL, "utf8"),
    );
    expect(fieldNames((delegation ?? "").replaceAll(",", ",\n"))).toEqual(
      Object.keys(DELEGATION_FIELDS).sort(),
    );
    expectLandedPresent(
      DELEGATION_FIELDS,
      schemaKeys(threadEventDelegationItemSchema),
      "delegation",
    );

    expect(
      fieldNames(
        (presentation ?? "").replaceAll(",", ",\n").replaceAll("{", "{\n"),
      ),
    ).toEqual(Object.keys(PRESENTATION_FIELDS).sort());
    const presentationKeys = schemaKeys(threadEventItemPresentationSchema);
    presentationKeys.add("presentation");
    expectLandedPresent(PRESENTATION_FIELDS, presentationKeys, "presentation");
  });

  it("§5 presentation rides every work row and the renderer slot exists (WS3)", () => {
    const rowKeys = schemaKeys(timelineCommandWorkRowSchema);
    expectLandedPresent(TIMELINE_ROW_FIELDS, rowKeys, "TimelineRow");
    expectGapsNotLanded(TIMELINE_ROW_FIELDS, rowKeys, "TimelineRow");
    expectTypeOf<TimelineRowGapsNotLanded>().toBeNever();
    expectTypeOf<TimelineRendererSlot>().toBeFunction();
  });
});
