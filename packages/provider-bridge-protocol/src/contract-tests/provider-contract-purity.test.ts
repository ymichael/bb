import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  pendingInteractionPayloadSchema,
  interactionRequestPayloadSchema,
  providerInfoSchema,
  runtimeThreadExecutionOptionsSchema,
  threadEventItemSchema,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bridgeCapabilitiesSchema,
  bridgeExecutionOptionsSchema,
  providerRecoveryNotificationSchema,
  threadDeltaSchema,
} from "../index.js";
import { collectZodKeyPaths } from "./zod-shape.js";

const PROVIDER_NAME_SEGMENTS = new Set([
  "codex",
  "claude",
  "pi",
  "acp",
  "cursor",
]);

const allowlistSchema = z.object({
  $comment: z.string(),
  entries: z.array(
    z.object({
      path: z.string().min(1),
      removedBy: z.string().min(1),
    }),
  ),
});

const SCANNED_SCHEMAS: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["bridgeExecutionOptionsSchema", bridgeExecutionOptionsSchema],
  ["runtimeThreadExecutionOptionsSchema", runtimeThreadExecutionOptionsSchema],
  ["bridgeCapabilitiesSchema", bridgeCapabilitiesSchema],
  ["threadDeltaSchema", threadDeltaSchema],
  ["threadEventItemSchema", threadEventItemSchema],
  ["providerInfoSchema", providerInfoSchema],
  ["providerRecoveryNotificationSchema", providerRecoveryNotificationSchema],
  ["pendingInteractionPayloadSchema", pendingInteractionPayloadSchema],
  ["interactionRequestPayloadSchema", interactionRequestPayloadSchema],
];

export function keySegments(key: string): string[] {
  return key
    .split(/(?=[A-Z])|[_\-.]/u)
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length > 0);
}

function keyNamesProvider(key: string): boolean {
  return keySegments(key).some((segment) =>
    PROVIDER_NAME_SEGMENTS.has(segment),
  );
}

function loadAllowlist(): Set<string> {
  const raw = readFileSync(
    fileURLToPath(
      new URL("./provider-contract-purity.allowlist.json", import.meta.url),
    ),
    "utf8",
  );
  const parsed = allowlistSchema.parse(JSON.parse(raw));
  const paths = parsed.entries.map((entry) => entry.path);
  expect(new Set(paths).size, "duplicate allowlist entries").toBe(paths.length);
  return new Set(paths);
}

describe("guardrail G2: the provider contract names no provider", () => {
  it("splits keys by segment so `pi` does not match inside other words", () => {
    expect(keySegments("claudeCodePermissionMode")).toEqual([
      "claude",
      "code",
      "permission",
      "mode",
    ]);
    expect(keyNamesProvider("capabilities")).toBe(false);
    expect(keyNamesProvider("expiresAt")).toBe(false);
    expect(keyNamesProvider("providerId")).toBe(false);
    expect(keyNamesProvider("acpLaunchSpec")).toBe(true);
    expect(keyNamesProvider("codex_goal")).toBe(true);
    expect(keyNamesProvider("piMode")).toBe(true);
  });

  it("flags every provider-named key and keeps the allowlist honest", () => {
    const allowlist = loadAllowlist();
    const offenders: string[] = [];
    for (const [name, schema] of SCANNED_SCHEMAS) {
      for (const path of collectZodKeyPaths(schema, name)) {
        const key = path.slice(path.lastIndexOf(".") + 1);
        if (keyNamesProvider(key)) offenders.push(path);
      }
    }
    const unexpected = offenders.filter((path) => !allowlist.has(path));
    const unused = [...allowlist].filter((path) => !offenders.includes(path));

    expect(
      unexpected,
      "new provider-named keys on the provider-agnostic contract — move the knob into providerOptions or declare it generically; see docs/provider-plugin-api.md",
    ).toEqual([]);
    expect(
      unused,
      "allowlist entries that no longer match a key — delete them from provider-contract-purity.allowlist.json",
    ).toEqual([]);
  });
});
