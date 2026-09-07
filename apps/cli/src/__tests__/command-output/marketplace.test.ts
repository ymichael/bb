import { describe, expect, it, vi } from "vitest";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerMarketplaceCommands } from "../../commands/marketplace.js";

const acme = {
  name: "acme-plugins",
  displayName: "Acme Plugins",
  description: "Plugins the Acme team maintains.",
  official: false,
  sourceKind: "https" as const,
  source: "https://acme.test/marketplace.json",
  resolvedCommit: null,
  entryCount: 2,
  lastRefreshAt: 1_700_000_000_000,
  lastAttemptAt: 1_700_000_000_000,
  lastError: null,
};

const official = {
  ...acme,
  name: "bb-community",
  displayName: "BB Community",
  official: true,
  source: "https://getbb.app/marketplace/v1/marketplace.json",
  entryCount: 5,
};

const bundled = {
  ...official,
  name: "bb-official",
  displayName: "BB Official",
  sourceKind: "path" as const,
  source: "/app/builtin-plugins",
  entryCount: 25,
};

function json(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("bb marketplace", () => {
  setupCommandOutputTestEnvironment();
  const register: CommandRegistrar = (program) =>
    registerMarketplaceCommands(program, () => "http://server");

  it("adds a marketplace and says that nothing was installed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: true, marketplace: acme }),
    );

    await runCommand(
      ["marketplace", "add", "https://acme.test/marketplace.json"],
      register,
    );

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "http://server/api/v1/marketplaces",
    );
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)),
    ).toEqual({ source: "https://acme.test/marketplace.json" });
    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Added marketplace acme-plugins");
    expect(output).toContain("Adding a marketplace installs nothing");
    expect(output).toContain("bb plugin install <id>@acme-plugins");
  });

  it("resolves a relative path: source on the invoking machine", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: true, marketplace: { ...acme, sourceKind: "path" } }),
    );

    await runCommand(["marketplace", "add", "path:./catalog"], register);

    const body = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body),
    ) as { source: string };
    expect(body.source.startsWith("path:/")).toBe(true);
    expect(body.source.endsWith("/catalog")).toBe(true);
  });

  it("lists marketplaces with their source and entry count", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ marketplaces: [bundled, official, acme] }),
    );

    await runCommand(["marketplace", "list"], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("bb-official (official)");
    expect(output).toContain("bb-community (official)");
    expect(output).toContain("acme-plugins");
    expect(output).toContain("https://acme.test/marketplace.json");
  });

  it("reports a failed refresh and exits non-zero without hiding the rest", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({
        results: [
          {
            name: "bb-community",
            ok: true,
            error: null,
            marketplace: official,
          },
          {
            name: "acme-plugins",
            ok: false,
            error: "request failed with HTTP 503",
            marketplace: acme,
          },
        ],
      }),
    );

    await expect(
      runCommand(["marketplace", "refresh"], register),
    ).rejects.toThrow("process.exit:1");

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("bb-community: 5 entries");
    expect(output).toContain("acme-plugins: refresh failed");
    expect(output).toContain("keeping the last catalog");
  });

  it("names the plugins a removal kept as direct installs", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: true, convertedPluginIds: ["notes", "status"] }),
    );

    await runCommand(["marketplace", "remove", "acme-plugins"], register);

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "http://server/api/v1/marketplaces/acme-plugins",
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBe("DELETE");
    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Removed marketplace acme-plugins.");
    expect(output).toContain("Kept as direct installs: notes, status");
  });
});
