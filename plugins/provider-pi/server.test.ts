import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import piPlugin from "./server.js";

function registeredDeclaration() {
  const host = createFakePluginHost({ pluginId: "provider-pi" });
  piPlugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "pi",
  );
  if (declaration === undefined)
    throw new Error("expected pi to be registered");
  return declaration;
}

describe("the pi plugin's environment passthrough", () => {
  it("declares the bridge command override variables so a host-set value reaches the bridge", () => {
    expect(registeredDeclaration().env).toEqual({
      passthrough: ["BB_PI_BRIDGE_COMMAND", "BB_PI_BRIDGE_ARGS"],
    });
  });
});

function rootPaths(
  side: readonly (string | { readonly path: string })[] | undefined,
): string[] {
  return (side ?? []).map((root) =>
    typeof root === "string" ? root : root.path,
  );
}

describe("the pi plugin's skill roots", () => {
  it("declares pi's documented directories and resolves the rest per host", () => {
    const declaration = registeredDeclaration();
    const roots = declaration.experimental_nativeSkillRoots;
    expect(rootPaths(roots?.user)).toEqual([
      ".pi/agent/skills",
      ".agents/skills",
    ]);
    expect(rootPaths(roots?.project)).toEqual([".pi/skills", ".agents/skills"]);
    expect(declaration.experimental_resolvesNativeRoots).toBe(true);
  });
});
