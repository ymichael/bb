import {
  PROVIDER_RESOLVED_NATIVE_ROOTS_MAX,
  type ProviderResolvedNativeRootInput,
} from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import {
  experimental_filterResolvedNativeRoots,
  experimental_nativeRootsResolveOutputSchema,
} from "../native-roots-contract.js";

const PREFIX_REASON =
  "namePrefix: A root name prefix is a plugin-name-like token ending in ':'";

function roots(count: number, side: string) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/${side}/${index}`,
    origin: "user" as const,
  }));
}

describe("experimental_filterResolvedNativeRoots", () => {
  it("drops a root with an unknown key so the kept answer passes the strict output schema", () => {
    const warn = vi.fn();
    const result = experimental_filterResolvedNativeRoots(
      {
        skills: [
          { path: "/home/u/.claude/skills", origin: "user" },
          { path: "/home/u/config/skills", origin: "user", source: "config" },
        ],
      },
      { warn, warned: new Set() },
    );
    expect(result.answer.skills.map((root) => root.path)).toEqual([
      "/home/u/.claude/skills",
    ]);
    expect(result.dropped).toEqual([
      {
        side: "skills",
        path: "/home/u/config/skills",
        reason: expect.stringContaining("source"),
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() =>
      experimental_nativeRootsResolveOutputSchema.parse(result.answer),
    ).not.toThrow();
  });

  it("warns once per (side, path, reason) across calls that share a warned set", () => {
    const warn = vi.fn();
    const warned = new Set<string>();
    const answer = {
      skills: [
        { path: "/p/spaced", origin: "user" as const, namePrefix: "bad name:" },
        ...roots(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX + 1, "skills"),
      ],
    };
    experimental_filterResolvedNativeRoots(answer, { warn, warned });
    experimental_filterResolvedNativeRoots(answer, { warn, warned });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining('dropped the skills root "/p/spaced"'),
      expect.stringContaining("kept the first"),
    ]);
    experimental_filterResolvedNativeRoots(answer, { warn, warned: new Set() });
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("drops each refused root on its own, in order, with the path and the reason", () => {
    const warn = vi.fn();

    const result = experimental_filterResolvedNativeRoots(
      {
        skills: [
          { path: "/home/u/.claude/skills", origin: "user" },
          { path: "/p/spaced", origin: "user", namePrefix: "bad name:" },
          { path: "/p/scoped", origin: "user", namePrefix: "@scope/x:" },
          { path: "/p/hidden", origin: "user", namePrefix: ".hidden:" },
          { path: "/p/long", origin: "user", namePrefix: `${"a".repeat(64)}:` },
          { path: "relative/skills", origin: "user" },
          {
            path: "/p/marker",
            origin: "user",
            skipIfManifest: "../plugin.json",
          },
          { path: "/p/walker", origin: "user", ancestors: true },
          { path: "/p/commands", origin: "user", shape: "commands" },
          {
            path: "/home/u/plugin/skills",
            origin: "project",
            namePrefix: "plugin-1:",
          },
        ],
        commands: [
          {
            path: "/p/commands-marker",
            origin: "user",
            shape: "commands",
            skipIfManifest: "../plugin.json",
          },
          { path: "/p/skill", origin: "user", shape: "skill" },
          { path: "/home/u/.claude/commands", origin: "user" },
        ],
      },
      { warn, warned: new Set() },
    );

    expect(result.answer.skills.map((root) => root.path)).toEqual([
      "/home/u/.claude/skills",
      "/home/u/plugin/skills",
    ]);
    expect(result.answer.commands.map((root) => root.path)).toEqual([
      "/home/u/.claude/commands",
    ]);
    expect(result.dropped).toEqual([
      { side: "skills", path: "/p/spaced", reason: PREFIX_REASON },
      { side: "skills", path: "/p/scoped", reason: PREFIX_REASON },
      { side: "skills", path: "/p/hidden", reason: PREFIX_REASON },
      { side: "skills", path: "/p/long", reason: PREFIX_REASON },
      {
        side: "skills",
        path: "relative/skills",
        reason:
          "path: Absolute roots must be absolute paths without dot segments",
      },
      {
        side: "skills",
        path: "/p/marker",
        reason:
          "skipIfManifest: A manifest marker is a relative path without dot segments",
      },
      {
        side: "skills",
        path: "/p/walker",
        reason: "Only project roots may walk ancestors",
      },
      {
        side: "skills",
        path: "/p/commands",
        reason: "A skills root needs a skill shape",
      },
      {
        side: "commands",
        path: "/p/commands-marker",
        reason:
          "skipIfManifest: A manifest marker is a relative path without dot segments",
      },
      {
        side: "commands",
        path: "/p/skill",
        reason: "A commands root needs a command shape",
      },
    ]);
    expect(result.truncated).toEqual({ skills: 0, commands: 0 });
    expect(warn).toHaveBeenCalledTimes(10);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      `resolveNativeRoots: dropped the skills root "/p/spaced": ${PREFIX_REASON}`,
    );
    expect(warn).toHaveBeenLastCalledWith(
      'resolveNativeRoots: dropped the commands root "/p/skill": A commands root needs a command shape',
    );
    const parsed = experimental_nativeRootsResolveOutputSchema.safeParse(
      result.answer,
    );
    expect(parsed.success).toBe(true);
  });

  it("names the reason classes a root with more than one defect reports", () => {
    const PATH_REASON =
      "path: Absolute roots must be absolute paths without dot segments";
    const MARKER_REASON =
      "skipIfManifest: A manifest marker is a relative path without dot segments";
    const wrongTyped: ProviderResolvedNativeRootInput = {
      path: "rel/typed",
      origin: "user",
      // @ts-expect-error a wrong-typed option, as a resolver written in JavaScript can send.
      ancestors: "yes",
    };

    const result = experimental_filterResolvedNativeRoots(
      {
        skills: [
          { path: "rel/skills", origin: "user", ancestors: true },
          {
            path: "/p/prefixed",
            origin: "user",
            namePrefix: "bad prefix:",
            shape: "skill",
            skipIfManifest: "m.json",
          },
          { path: "rel/skill-file", origin: "user", fallbackName: "n" },
          wrongTyped,
          { path: "", origin: "user" },
          { path: "/p/empty-marker", origin: "user", skipIfManifest: "" },
        ],
        commands: [
          { path: "/p/c-marker", origin: "user", skipIfManifest: "a/b.json" },
          {
            path: "/p/c-bad-marker",
            origin: "user",
            skipIfManifest: "../b.json",
          },
        ],
      },
      { warn: () => {}, warned: new Set() },
    );

    expect(result.answer.skills).toEqual([]);
    expect(result.answer.commands.map((root) => root.path)).toEqual([
      "/p/c-marker",
    ]);
    expect(result.dropped).toEqual([
      { side: "skills", path: "rel/skills", reason: PATH_REASON },
      { side: "skills", path: "/p/prefixed", reason: PREFIX_REASON },
      { side: "skills", path: "rel/skill-file", reason: PATH_REASON },
      {
        side: "skills",
        path: "rel/typed",
        reason: `${PATH_REASON}; ancestors: Invalid input: expected boolean, received string`,
      },
      {
        side: "skills",
        path: "",
        reason: `path: Too small: expected string to have >=1 characters; ${PATH_REASON}`,
      },
      {
        side: "skills",
        path: "/p/empty-marker",
        reason: `skipIfManifest: Too small: expected string to have >=1 characters; ${MARKER_REASON}`,
      },
      { side: "commands", path: "/p/c-bad-marker", reason: MARKER_REASON },
    ]);
  });

  it("cuts a side to the cap after the drops, keeps the first roots, and warns once per side", () => {
    const warn = vi.fn();

    const result = experimental_filterResolvedNativeRoots(
      {
        skills: [{ path: "relative", origin: "user" }, ...roots(300, "s")],
        commands: roots(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX, "c"),
      },
      { warn, warned: new Set() },
    );

    expect(result.answer.skills).toHaveLength(
      PROVIDER_RESOLVED_NATIVE_ROOTS_MAX,
    );
    expect(result.answer.skills[0]?.path).toBe("/s/0");
    expect(result.answer.skills[255]?.path).toBe("/s/255");
    expect(result.answer.commands).toHaveLength(
      PROVIDER_RESOLVED_NATIVE_ROOTS_MAX,
    );
    expect(result.truncated).toEqual({ skills: 44, commands: 0 });
    expect(result.dropped).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      'resolveNativeRoots: kept the first 256 of 300 skills roots; dropped 44 from "/s/256" on',
    );
  });
});

describe("experimental_nativeRootsResolveOutputSchema", () => {
  it("fills each side's defaults and drops a commands root's manifest marker instead of refusing it", () => {
    const parsed = experimental_nativeRootsResolveOutputSchema.parse({
      skills: [
        {
          path: "/home/u/.claude/skills",
          origin: "user",
          skipIfManifest: ".claude-plugin/plugin.json",
        },
      ],
      commands: [
        {
          path: "/home/u/.claude/commands",
          origin: "user",
          skipIfManifest: ".claude-plugin/plugin.json",
        },
      ],
    });
    expect(parsed).toEqual({
      skills: [
        {
          path: "/home/u/.claude/skills",
          origin: "user",
          recursive: false,
          ancestors: false,
          namePrefix: "",
          shape: "skills",
          skipIfManifest: ".claude-plugin/plugin.json",
        },
      ],
      commands: [
        {
          path: "/home/u/.claude/commands",
          origin: "user",
          recursive: false,
          ancestors: false,
          namePrefix: "",
          shape: "commands",
        },
      ],
    });
    expect(
      experimental_nativeRootsResolveOutputSchema.safeParse({
        commands: [
          {
            path: "/home/u/.claude/commands",
            origin: "user",
            skipIfManifest: "../plugin.json",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("cuts a side past the cap instead of refusing the answer", () => {
    const parsed = experimental_nativeRootsResolveOutputSchema.parse({
      skills: roots(300, "s"),
    });
    expect(parsed.skills).toHaveLength(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX);
    expect(parsed.skills[255]?.path).toBe("/s/255");
    expect(parsed.commands).toEqual([]);
  });

  it("still refuses the whole answer for one bad root", () => {
    expect(
      experimental_nativeRootsResolveOutputSchema.safeParse({
        skills: [
          { path: "/home/u/.claude/skills", origin: "user" },
          { path: "/p/spaced", origin: "user", namePrefix: "bad name:" },
        ],
      }).success,
    ).toBe(false);
  });
});
