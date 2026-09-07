import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as providerBridgeSdk from "../provider-bridge.js";

const DOC_URL = new URL("../../../../docs/api_to_audit.md", import.meta.url);
const DECLARATIONS_URL = new URL(
  "../../bundled-types/bb-plugin-sdk-provider-bridge.d.ts",
  import.meta.url,
);

function scheduledRemovalNames(doc: string): string[] {
  const start = doc.indexOf("## Scheduled removals (next major)");
  expect(start, "the scheduled-removals section").toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const end = rest.search(/^## /mu);
  const section = end === -1 ? rest : rest.slice(0, end);
  return Array.from(
    section.matchAll(/^- `([A-Za-z0-9_]+)`/gmu),
    (match) => match[1],
  );
}

function exportedNames(
  declarations: string,
  kind: "type" | "value",
): Set<string> {
  const prefix = kind === "type" ? "export type" : "export";
  const names = new Set<string>();
  for (const match of declarations.matchAll(
    new RegExp(`^${prefix} \\{ ([^}]+) \\};$`, "gmu"),
  )) {
    for (const entry of match[1].split(", ")) {
      const alias = entry.split(" as ");
      names.add(alias[alias.length - 1]);
    }
  }
  return names;
}

describe("scheduled removals on @get-bb/plugin-sdk/provider-bridge", () => {
  it("keeps every name the audit doc schedules for removal exported until the next major", async () => {
    const [doc, declarations] = await Promise.all([
      readFile(DOC_URL, "utf8"),
      readFile(DECLARATIONS_URL, "utf8"),
    ]);
    const scheduled = scheduledRemovalNames(doc);
    expect(scheduled.length).toBeGreaterThan(0);

    const typeExports = exportedNames(declarations, "type");
    const valueExports = exportedNames(declarations, "value");
    const facade: Record<string, unknown> = providerBridgeSdk;
    for (const name of scheduled) {
      const isType = typeExports.has(name);
      expect(
        isType || valueExports.has(name),
        `${name} is declared by the published bundle`,
      ).toBe(true);
      if (!isType) {
        expect(facade[name], `${name} is a runtime export`).toBeDefined();
      }
    }
  });

  it("still resolves the 0.4.15 names whose definitions moved", () => {
    expect(
      providerBridgeSdk.hostDaemonAcpLaunchSpecSchema.safeParse({
        displayName: "Amp",
        command: "amp",
        args: ["acp"],
        env: {},
      }).success,
    ).toBe(true);
    expect(
      providerBridgeSdk.normalizeHostDaemonAcpLaunchSpec({
        displayName: "Amp",
        command: "amp",
        args: ["acp"],
        env: {},
        modelCli: { listArgs: [], primaryModels: [] },
      }),
    ).toEqual({ displayName: "Amp", command: "amp", args: ["acp"], env: {} });
    expect(
      providerBridgeSdk.claudeTaskToolNameSchema.safeParse("TaskCreate")
        .success,
    ).toBe(true);
    expect(
      providerBridgeSdk.claudeTaskToolOutputSchema.safeParse({
        success: true,
        taskId: "t1",
      }).success,
    ).toBe(true);
  });
});
