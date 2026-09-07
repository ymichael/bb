import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PluginProviderDeclaration } from "../backend-contract.js";
import { validatePluginProviderDeclaration } from "../internal/host-policy.js";

function declaration(
  overrides: Partial<PluginProviderDeclaration> = {},
): PluginProviderDeclaration {
  return {
    id: "my-agent",
    displayName: "My Agent",
    maintenance: { health: false, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["medium"],
    },
    composerActions: [],
    ...overrides,
  };
}

describe("provider declaration target-state fields", () => {
  it("carries strings, option descriptors and extension kinds through validation", () => {
    const goalSchema = z.object({ objective: z.string() });
    const normalized = validatePluginProviderDeclaration(
      declaration({
        strings: {
          signInHint: "Run `my-agent login`.",
          expiredHint: "Session expired; run `my-agent login` again.",
          installUrl: "https://example.com/install",
          brandPrefix: "My ",
          iconTint: { light: "#123456", dark: "#abcdef" },
        },
        serviceTiers: [
          { id: "fast", label: "Fast", description: "Priority routing" },
          { id: "flex", label: "Flex" },
        ],
        reasoningLevels: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        extensionKinds: {
          goal: { item: goalSchema, state: goalSchema },
          "permission-profile": { item: goalSchema },
        },
      }),
    );
    expect(normalized.strings).toEqual({
      signInHint: "Run `my-agent login`.",
      expiredHint: "Session expired; run `my-agent login` again.",
      installUrl: "https://example.com/install",
      brandPrefix: "My ",
      iconTint: { light: "#123456", dark: "#abcdef" },
    });
    expect(normalized.serviceTiers).toEqual([
      { id: "fast", label: "Fast", description: "Priority routing" },
      { id: "flex", label: "Flex" },
    ]);
    expect(normalized.reasoningLevels?.map((l) => l.id)).toEqual([
      "low",
      "high",
    ]);
    expect(Object.keys(normalized.extensionKinds ?? {}).sort()).toEqual([
      "goal",
      "permission-profile",
    ]);
    expect(normalized.extensionKinds?.goal?.state).toBe(goalSchema);
    expect(Object.isFrozen(normalized.strings)).toBe(true);
    expect(Object.isFrozen(normalized.serviceTiers)).toBe(true);
  });

  it("omits the fields entirely when a plugin does not declare them", () => {
    const normalized = validatePluginProviderDeclaration(declaration());
    expect("strings" in normalized).toBe(false);
    expect("serviceTiers" in normalized).toBe(false);
    expect("reasoningLevels" in normalized).toBe(false);
    expect("extensionKinds" in normalized).toBe(false);
  });

  it("rejects incomplete strings, duplicate option ids, and malformed extension kinds", () => {
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          strings: {
            signInHint: "Sign in",
            expiredHint: "Expired",
          } as PluginProviderDeclaration["strings"],
        }),
      ),
    ).toThrow(/strings\.installUrl/u);
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          serviceTiers: [
            { id: "fast", label: "Fast" },
            { id: "fast", label: "Also fast" },
          ],
        }),
      ),
    ).toThrow(/duplicated/u);
    expect(() =>
      validatePluginProviderDeclaration(declaration({ reasoningLevels: [] })),
    ).toThrow(/non-empty array/u);
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          extensionKinds: { Goal: { item: z.object({}) } },
        }),
      ),
    ).toThrow(/name "Goal"/u);
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          extensionKinds: { "my/goal": { item: z.object({}) } },
        }),
      ),
    ).toThrow(/name "my\/goal"/u);
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({ extensionKinds: { goal: {} } }),
      ),
    ).toThrow(/item schema, a state schema, or both/u);
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          extensionKinds: {
            goal: { item: { parse: () => ({}) } as never },
          },
        }),
      ),
    ).toThrow(/Standard Schema v1/u);
  });
  it("rejects a skill root that is not a relative path", () => {
    const roots = [
      ["an absolute path", "/etc/skills"],
      ["a Windows drive letter", "C:/skills"],
      ["a parent dot segment", "../skills"],
      ["an interior dot segment", "skills/./more"],
      ["an empty segment", "skills//more"],
    ] as const;
    for (const [label, root] of roots) {
      expect(
        () =>
          validatePluginProviderDeclaration(
            declaration({
              experimental_nativeSkillRoots: { user: [root], project: [] },
            }),
          ),
        label,
      ).toThrow(/relative paths without dot segments/u);
    }
  });

  it("rejects duplicate skill roots and more than the cap", () => {
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          experimental_nativeSkillRoots: {
            user: [".agents/skills", ".agents/skills"],
            project: [],
          },
        }),
      ),
    ).toThrow(/Roots must not repeat a path/u);
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          experimental_nativeSkillRoots: {
            user: Array.from({ length: 33 }, (_value, index) => `r${index}`),
            project: [],
          },
        }),
      ),
    ).toThrow(/Too big.*32/u);
  });

  it("keeps well-formed skill roots and defaults the side that is absent", () => {
    const normalized = validatePluginProviderDeclaration(
      declaration({
        experimental_nativeSkillRoots: { user: [".agents/skills"] } as never,
      }),
    );

    expect(normalized.experimental_nativeSkillRoots).toEqual({
      user: [
        {
          path: ".agents/skills",
          recursive: false,
          ancestors: false,
          namePrefix: "",
        },
      ],
      project: [],
    });
    expect(normalized.experimental_nativeCommandRoots).toBeUndefined();
    expect(normalized.experimental_resolvesNativeRoots).toBe(false);
  });

  it("normalizes root entries with options and validates command roots by the same rules", () => {
    const normalized = validatePluginProviderDeclaration(
      declaration({
        experimental_nativeSkillRoots: {
          project: [
            { path: ".cursor/skills", recursive: true, ancestors: true },
          ],
          user: [{ path: ".claude/plugins/one/skills", namePrefix: "one:" }],
        },
        experimental_nativeCommandRoots: { project: [".claude/commands"] },
        experimental_resolvesNativeRoots: true,
      }),
    );
    expect(normalized.experimental_nativeSkillRoots).toEqual({
      project: [
        {
          path: ".cursor/skills",
          recursive: true,
          ancestors: true,
          namePrefix: "",
        },
      ],
      user: [
        {
          path: ".claude/plugins/one/skills",
          recursive: false,
          ancestors: false,
          namePrefix: "one:",
        },
      ],
    });
    expect(normalized.experimental_nativeCommandRoots).toEqual({
      project: [
        {
          path: ".claude/commands",
          recursive: false,
          ancestors: false,
          namePrefix: "",
        },
      ],
      user: [],
    });
    expect(normalized.experimental_resolvesNativeRoots).toBe(true);

    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          experimental_nativeCommandRoots: { user: ["../commands"] },
        }),
      ),
    ).toThrow(
      /experimental_nativeCommandRoots\.user\.0\.path Roots must be relative paths without dot segments/u,
    );
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          experimental_nativeSkillRoots: {
            user: [{ path: ".agents/skills", ancestors: true }],
          },
        }),
      ),
    ).toThrow(/Only project roots may walk ancestors/u);
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          experimental_nativeSkillRoots: {
            user: [{ path: ".agents/skills", namePrefix: "no colon" }],
          },
        }),
      ),
    ).toThrow(/ending in ':'/u);
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({ experimental_resolvesNativeRoots: "yes" as never }),
      ),
    ).toThrow(/experimental_resolvesNativeRoots must be a boolean/u);
  });

  it("refuses the removed host-absolute side", () => {
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({
          experimental_nativeSkillRoots: {
            absolute: ["/home/dev/.pi/agent/skills"],
          } as never,
        }),
      ),
    ).toThrow(/experimental_nativeSkillRoots Unrecognized key: "absolute"/u);
  });
  it("rejects a model catalog scope outside the two it has", () => {
    expect(() =>
      validatePluginProviderDeclaration(
        declaration({ models: { scope: "user" as never } }),
      ),
    ).toThrow(/models\.scope must be one of host, workspace/u);
  });

  it("defaults the model catalog scope to workspace", () => {
    expect(validatePluginProviderDeclaration(declaration()).models.scope).toBe(
      "workspace",
    );
  });
});

describe("provider declaration fields renamed in SDK 0.4.16", () => {
  it.each([
    ["experimental_family", "family", "my-agent"],
    ["experimental_strings", "strings", { signInHint: "x", expiredHint: "y" }],
    [
      "experimental_serviceTiers",
      "serviceTiers",
      [{ id: "fast", label: "Fast" }],
    ],
    [
      "experimental_reasoningLevels",
      "reasoningLevels",
      [{ id: "low", label: "Low" }],
    ],
    ["experimental_extensionKinds", "extensionKinds", {}],
    ["experimental_models", "models", { scope: "workspace" }],
    ["experimental_env", "env", { passthrough: ["HOME"] }],
    ["experimental_deriveProviderOptions", "deriveProviderOptions", () => ({})],
  ] as const)('rejects "%s" and names "%s"', (oldKey, newKey, value) => {
    const stale = { ...declaration(), [oldKey]: value };
    expect(() => validatePluginProviderDeclaration(stale)).toThrow(
      `provider "my-agent": "${oldKey}" was renamed to "${newKey}" in SDK 0.4.16`,
    );
  });

  it("rejects an experimental_ key it has never read as unknown", () => {
    const stale = { ...declaration(), experimental_foo: true };
    expect(() => validatePluginProviderDeclaration(stale)).toThrow(
      'provider "my-agent": unknown declaration field "experimental_foo"',
    );
  });

  it("still reads the experimental_ keys that stayed experimental", () => {
    const normalized = validatePluginProviderDeclaration(
      declaration({
        experimental_bridgeOptions: { tier: "fast" },
        experimental_visibility: "always",
        experimental_nativeSkillRoots: { project: ["skills"] },
        experimental_nativeCommandRoots: { project: ["commands"] },
        experimental_resolvesNativeRoots: true,
      }),
    );
    expect(normalized.experimental_bridgeOptions).toEqual({ tier: "fast" });
    expect(normalized.experimental_resolvesNativeRoots).toBe(true);
  });

  it.each([
    ["experimental_providerHealth", "maintenance.health"],
    ["experimental_providerUsage", "maintenance.usage"],
    ["experimental_providerInstallation", "maintenance.installation"],
  ] as const)("rejects capabilities.%s and names %s", (oldKey, newKey) => {
    const base = declaration();
    const stale = {
      ...base,
      capabilities: { ...base.capabilities, [oldKey]: true },
    };
    expect(() => validatePluginProviderDeclaration(stale)).toThrow(
      `provider "my-agent": "capabilities.${oldKey}" was moved to "${newKey}" in SDK 0.4.16`,
    );
  });

  it("reports the move before the visibility rule that depends on it", () => {
    const base = declaration();
    const stale = {
      ...base,
      experimental_visibility: "installed" as const,
      capabilities: { ...base.capabilities, experimental_providerHealth: true },
    };
    expect(() => validatePluginProviderDeclaration(stale)).toThrow(
      /"capabilities.experimental_providerHealth" was moved to "maintenance.health"/,
    );
  });

  it("rejects an unknown experimental_ capability", () => {
    const base = declaration();
    const stale = {
      ...base,
      capabilities: { ...base.capabilities, experimental_fork: "full" },
    };
    expect(() => validatePluginProviderDeclaration(stale)).toThrow(
      'provider "my-agent": unknown declaration field "capabilities.experimental_fork"',
    );
  });
});
