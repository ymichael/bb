import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import echoPlugin from "./server.js";
import { ECHO_PROJECT_SKILL_ROOT, ECHO_PROVIDER_ID } from "./src/vocabulary.js";

function registeredDeclaration() {
  const host = createFakePluginHost({ pluginId: "echo-provider" });
  echoPlugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === ECHO_PROVIDER_ID,
  );
  if (declaration === undefined) {
    throw new Error(`provider "${ECHO_PROVIDER_ID}" was not registered`);
  }
  return declaration;
}

describe("the echo provider's native skill root", () => {
  it("registers the one project root, normalized with every option explicit", () => {
    expect(registeredDeclaration().experimental_nativeSkillRoots).toEqual({
      user: [],
      project: [
        {
          path: ECHO_PROJECT_SKILL_ROOT,
          recursive: false,
          ancestors: false,
          namePrefix: "",
        },
      ],
    });
  });

  it("declares no command roots and no host-side resolver", () => {
    const declaration = registeredDeclaration();
    expect(declaration.experimental_nativeCommandRoots).toBeUndefined();
    expect(declaration.experimental_resolvesNativeRoots).toBe(false);
  });
});
