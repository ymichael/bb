import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  getHelpOutput,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerSkillCommands } from "../../commands/skill.js";

describe("bb skill commands", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerSkillCommands(
      program,
      () => "http://server",
      () => ({ projectId: "project-context", serverUrl: "http://server" }),
    );

  it("lists installed skills through the public SDK", async () => {
    const get = vi.fn(async () => ({
      skills: [
        {
          id: `skill_${"a".repeat(64)}`,
          name: "review",
          description: "Review the current diff",
          provider: "codex",
          scope: "codex-user",
          filePath: "/home/user/.agents/skills/review/SKILL.md",
          manageable: true,
          registrySkillId: null,
        },
      ],
    }));
    stubServerApi({ "v1.projects.:id.skills.$get": get });

    await runCommand(["skill", "list"], register);

    expect(get).toHaveBeenCalledWith({
      param: { id: "project-context" },
      query: { environmentId: "" },
    });
    expect(collectLogLines(vi.mocked(console.log)).join("\n")).toContain(
      "review",
    );
  });

  it("installs only by canonical registry identity", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          filePath: "/home/user/.bb/skills/review/SKILL.md",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await runCommand(
      ["skill", "install", "owner/repo/review", "--json"],
      register,
    );

    const [input, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(String(input)).toBe("http://server/api/v1/skills-registry/install");
    expect(JSON.parse(String(init?.body))).toEqual({
      registrySkillId: "owner/repo/review",
    });
  });

  it("deduplicates repository stars while printing registry search results", async () => {
    const skill = {
      id: "owner/repo/review",
      source: "owner/repo",
      skillId: "review",
      name: "Review",
      installs: 42,
      stars: null,
      installUrl: "https://github.com/owner/repo",
      url: "https://www.skills.sh/owner/repo/review",
      topic: null,
      summary: "Review a change",
    };
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("http://server/api/v1/skills-registry?")) {
        return Response.json({
          skills: [
            skill,
            {
              ...skill,
              id: "owner/repo/test",
              skillId: "test",
              name: "Test",
            },
          ],
          pagination: { page: 0, perPage: 24, total: 2, hasMore: false },
          ranking: "trending",
        });
      }
      if (url.startsWith("http://server/api/v1/skills-registry/entry?")) {
        return Response.json({ ...skill, installs: 881_234 });
      }
      if (
        url.startsWith("http://server/api/v1/skills-registry/repository-stars?")
      ) {
        return Response.json({ stars: 27_053 });
      }
      return new Response(null, { status: 404 });
    });

    await runCommand(["skill", "search"], register);

    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("27053");
    expect(output).toContain("INSTALLS");
    expect(output).not.toContain("INSTALLS/24H");
    expect(output).toContain("881234");
    expect(output).not.toContain(" 42 ");
    const requested = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([input]) => String(input));
    expect(requested).toContain(
      "http://server/api/v1/skills-registry?page=0&perPage=24",
    );
    expect(
      requested.filter((url) => url.includes("/repository-stars?")),
    ).toEqual([
      "http://server/api/v1/skills-registry/repository-stars?source=owner%2Frepo",
    ]);
  });

  it("keeps window and lifetime installs in separate JSON fields on trending", async () => {
    const skill = {
      id: "owner/repo/review",
      source: "owner/repo",
      skillId: "review",
      name: "Review",
      installs: 42,
      stars: 7,
      installUrl: "https://github.com/owner/repo",
      url: "https://www.skills.sh/owner/repo/review",
      topic: null,
      summary: "Review a change",
    };
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("http://server/api/v1/skills-registry?")) {
        return Response.json({
          skills: [skill],
          pagination: { page: 0, perPage: 24, total: 1, hasMore: false },
          ranking: "trending",
        });
      }
      if (url.startsWith("http://server/api/v1/skills-registry/entry?")) {
        return Response.json({ ...skill, installs: 881_234 });
      }
      return new Response(null, { status: 404 });
    });

    await runCommand(["skill", "search", "--json"], register);

    const payload = JSON.parse(
      collectLogLines(vi.mocked(console.log)).join("\n"),
    ) as {
      ranking: string;
      skills: { id: string; installs: number; lifetimeInstalls: number }[];
    };
    expect(payload.ranking).toBe("trending");
    expect(payload.skills).toEqual([
      expect.objectContaining({
        id: "owner/repo/review",
        installs: 42,
        lifetimeInstalls: 881_234,
      }),
    ]);
  });

  it("keeps the list's own count on the all-time ranking", async () => {
    const skill = {
      id: "owner/repo/review",
      source: "owner/repo",
      skillId: "review",
      name: "Review",
      installs: 42,
      stars: null,
      installUrl: "https://github.com/owner/repo",
      url: "https://www.skills.sh/owner/repo/review",
      topic: null,
      summary: null,
    };
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("http://server/api/v1/skills-registry?")) {
        return Response.json({
          skills: [skill],
          pagination: { page: 0, perPage: 24, total: 1, hasMore: false },
          ranking: "all-time",
        });
      }
      if (url.startsWith("http://server/api/v1/skills-registry/entry?")) {
        return Response.json({
          ...skill,
          installs: 881_234,
          summary: "Review a change",
        });
      }
      return Response.json({ stars: 7 });
    });

    await runCommand(["skill", "search", "review"], register);

    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("42");
    expect(output).not.toContain("881234");
    expect(output).toContain("Review a change");
  });

  it("marks install counts it could not resolve instead of printing the window count", async () => {
    const skill = {
      id: "owner/repo/review",
      source: "owner/repo",
      skillId: "review",
      name: "Review",
      installs: 42,
      stars: null,
      installUrl: "https://github.com/owner/repo",
      url: "https://www.skills.sh/owner/repo/review",
      topic: null,
      summary: null,
    };
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("http://server/api/v1/skills-registry?")) {
        return Response.json({
          skills: [skill],
          pagination: { page: 0, perPage: 24, total: 1, hasMore: false },
          ranking: "trending",
        });
      }
      if (url.startsWith("http://server/api/v1/skills-registry/entry?")) {
        return new Response(null, { status: 404 });
      }
      return Response.json({ stars: 7 });
    });

    await runCommand(["skill", "search", "--json"], register);

    const payload = JSON.parse(
      collectLogLines(vi.mocked(console.log)).join("\n"),
    ) as {
      skills: {
        id: string;
        installs: number;
        lifetimeInstalls: number | null;
      }[];
    };
    expect(payload.skills).toEqual([
      expect.objectContaining({
        id: "owner/repo/review",
        installs: 42,
        lifetimeInstalls: null,
      }),
    ]);
  });

  it("prints registry metadata and the bounded file preview", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "owner/repo/review",
            source: "owner/repo",
            skillId: "review",
            name: "Review",
            installs: 42,
            stars: 7,
            installUrl: "https://github.com/owner/repo",
            url: "https://www.skills.sh/owner/repo/review",
            topic: null,
            summary: "Review a change",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "owner/repo/review",
            source: "owner/repo",
            skillId: "review",
            hash: "abc123",
            files: [{ path: "SKILL.md", contents: "# Review\n" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    await runCommand(
      ["skill", "registry", "detail", "owner/repo/review"],
      register,
    );

    expect(collectLogLines(vi.mocked(console.log)).join("\n")).toContain(
      "ID: owner/repo/review",
    );
    expect(write).toHaveBeenCalledWith("# Review\n");
    expect(
      vi.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input)),
    ).toEqual([
      "http://server/api/v1/skills-registry/entry?id=owner%2Frepo%2Freview",
      "http://server/api/v1/skills-registry/detail?source=owner%2Frepo&skillId=review",
    ]);
  });

  it("prints registry metadata and detail together as JSON", async () => {
    const entry = {
      id: "owner/repo/review",
      source: "owner/repo",
      skillId: "review",
      name: "Review",
      installs: 42,
      stars: null,
      installUrl: null,
      url: "https://www.skills.sh/owner/repo/review",
      topic: null,
      summary: null,
    };
    const detail = {
      id: entry.id,
      source: entry.source,
      skillId: entry.skillId,
      hash: null,
      files: null,
    };
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(entry), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(detail), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          stars: 27_053,
        }),
      );

    await runCommand(
      ["skill", "registry", "detail", entry.id, "--json"],
      register,
    );

    expect(vi.mocked(console.log)).toHaveBeenCalledWith(
      JSON.stringify({ skill: { ...entry, stars: 27_053 }, detail }, null, 2),
    );
  });

  it("documents the installed and registry lifecycle", async () => {
    const help = await getHelpOutput(["skill"], register);
    for (const command of [
      "list",
      "show",
      "files",
      "update",
      "delete",
      "search",
      "registry",
      "install",
    ]) {
      expect(help).toContain(command);
    }
  });
});
