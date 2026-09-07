import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_SDK_VERSION } from "@bb/domain";
import {
  collectLogPayloads,
  readlineMocks,
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";
import { installFakeNpm } from "../helpers/fake-npm.js";
import { registerPluginCommands } from "../../commands/plugin.js";

const register = (program: Parameters<typeof registerPluginCommands>[0]) => {
  registerPluginCommands(program, () => "http://server");
};

setupCommandOutputTestEnvironment();

let rootDir: string;
let toolsDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "bb-cli-migrate-"));
  toolsDir = await mkdtemp(join(tmpdir(), "bb-cli-migrate-tools-"));
  await installFakeNpm(toolsDir);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
  await rm(toolsDir, { recursive: true, force: true });
});

async function writeManifest(value: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(rootDir, "package.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function writeVendoredPlugin(): Promise<void> {
  await writeManifest({
    name: "bb-plugin-legacy",
    engines: { bbPluginSdk: ">=0.2.0" },
    bb: { server: "./server.ts" },
    devDependencies: { typescript: "^5.7.0" },
  });
  await writeFile(
    join(rootDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          paths: { "@get-bb/plugin-sdk": ["./types/bb-plugin-sdk.d.ts"] },
        },
        include: ["server.ts", "types"],
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(rootDir, "types"), { recursive: true });
  await writeFile(join(rootDir, "types", "bb-plugin-sdk.d.ts"), "// old\n");
}

async function readManifest(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    await readFile(join(rootDir, "package.json"), "utf8"),
  );
  return parsed as Record<string, unknown>;
}

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
}

describe("bb plugin migrate", () => {
  it("prints the plan and changes nothing without --yes on a non-TTY", async () => {
    await writeVendoredPlugin();
    setTty(false);
    const before = await readFile(join(rootDir, "package.json"), "utf8");
    const logSpy = vi.mocked(console.log);

    await expect(
      runCommand(["plugin", "migrate", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    const logged = collectLogPayloads(logSpy).join("\n");
    expect(logged).toContain(
      `"@get-bb/plugin-sdk": (none) → ${PLUGIN_SDK_VERSION}`,
    );
    expect(logged).toContain("delete         types/bb-plugin-sdk.d.ts");
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "Refusing to migrate without confirmation",
    );
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(
      await stat(join(rootDir, "types", "bb-plugin-sdk.d.ts")).then(() => true),
    ).toBe(true);
  });

  it("migrates with --yes and reports the follow-up install", async () => {
    await writeVendoredPlugin();
    setTty(false);

    await runCommand(["plugin", "migrate", rootDir, "--yes"], register);

    const manifest = await readManifest();
    expect(
      (manifest.devDependencies as Record<string, string>)[
        "@get-bb/plugin-sdk"
      ],
    ).toBe(PLUGIN_SDK_VERSION);
    await expect(
      stat(join(rootDir, "types", "bb-plugin-sdk.d.ts")),
    ).rejects.toThrow();
    const logged = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(logged).toContain("Migrated to the @get-bb/plugin-sdk npm package.");
    expect(logged).toContain("Run `npm install`");
  });

  it("plans and applies the pre-rename import rewrite", async () => {
    await writeVendoredPlugin();
    await writeFile(
      join(rootDir, "server.ts"),
      'import type { BbPluginApi } from "@bb/plugin-sdk";\nimport "@bb/plugin-sdk/testing";\n',
    );
    setTty(false);

    await runCommand(["plugin", "migrate", rootDir, "--yes"], register);

    const logged = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(logged).toContain(
      'rewrite        server.ts (2 imports of "@bb/plugin-sdk" → "@get-bb/plugin-sdk")',
    );
    expect(await readFile(join(rootDir, "server.ts"), "utf8")).toBe(
      'import type { BbPluginApi } from "@get-bb/plugin-sdk";\nimport "@get-bb/plugin-sdk/testing";\n',
    );
  });

  it("reports an already-migrated plugin without touching it", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      engines: { bbPluginSdk: `>=${PLUGIN_SDK_VERSION}` },
      bb: { server: "./server.ts" },
      devDependencies: { "@get-bb/plugin-sdk": PLUGIN_SDK_VERSION },
    });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await runCommand(["plugin", "migrate", rootDir], register);

    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      "Already migrated",
    );
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
  });

  it("pins a package-layout plugin that never got the devDependency", async () => {
    await writeManifest({
      name: "bb-plugin-pinless",
      bb: { server: "./server.ts" },
      devDependencies: { typescript: "^5.7.0" },
    });
    setTty(false);

    await runCommand(["plugin", "migrate", rootDir, "--yes"], register);

    const manifest = await readManifest();
    expect(
      (manifest.devDependencies as Record<string, string>)[
        "@get-bb/plugin-sdk"
      ],
    ).toBe(PLUGIN_SDK_VERSION);
    expect((manifest.engines as Record<string, string>).bbPluginSdk).toBe(
      `>=${PLUGIN_SDK_VERSION}`,
    );
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).not.toContain(
      "Already migrated",
    );
  });

  it("aborts when the plugin changes between the plan and the confirmation", async () => {
    await writeVendoredPlugin();
    setTty(true);
    readlineMocks.question.mockImplementation(async () => {
      await writeFile(
        join(rootDir, "types", "bb-plugin-sdk-app.d.ts"),
        "// appeared mid-prompt\n",
      );
      return "y";
    });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await expect(
      runCommand(["plugin", "migrate", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "changed while awaiting confirmation",
    );
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(
      await stat(join(rootDir, "types", "bb-plugin-sdk.d.ts")).then(() => true),
    ).toBe(true);
  });
});

describe("bb plugin dev stale-pin warning", () => {
  function stubEmptyPluginList(): void {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ plugins: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("warns when an exact pin differs from this bb's SDK version", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      bb: { server: "./server.ts" },
      devDependencies: { "@get-bb/plugin-sdk": "0.2.0" },
    });
    stubEmptyPluginList();

    await expect(
      runCommand(["plugin", "dev", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toContain(
      `This plugin pins @get-bb/plugin-sdk 0.2.0; this bb's SDK is ${PLUGIN_SDK_VERSION}`,
    );
  });

  it("stays quiet for a matching pin and for a range", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      bb: { server: "./server.ts" },
      devDependencies: { "@get-bb/plugin-sdk": PLUGIN_SDK_VERSION },
    });
    stubEmptyPluginList();
    await expect(
      runCommand(["plugin", "dev", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    await writeManifest({
      name: "bb-plugin-modern",
      bb: { server: "./server.ts" },
      devDependencies: { "@get-bb/plugin-sdk": "^0.2.0" },
    });
    stubEmptyPluginList();
    await expect(
      runCommand(["plugin", "dev", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).not.toContain(
      "This plugin pins @get-bb/plugin-sdk",
    );
  });
});

describe("bb plugin types on a package-layout plugin", () => {
  it("repoints an outdated pin to the running host's SDK version", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      engines: { bbPluginSdk: ">=0.2.0" },
      bb: { server: "./server.ts" },
      devDependencies: { "@get-bb/plugin-sdk": "0.2.0" },
    });

    await runCommand(["plugin", "types", rootDir], register);

    const manifest = await readManifest();
    expect(
      (manifest.devDependencies as Record<string, string>)[
        "@get-bb/plugin-sdk"
      ],
    ).toBe(PLUGIN_SDK_VERSION);
    expect((manifest.engines as Record<string, string>).bbPluginSdk).toBe(
      ">=0.2.0",
    );
    const logged = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(logged).toContain(`0.2.0 → ${PLUGIN_SDK_VERSION}`);
    expect(logged).toContain("Run `npm install`");
  });

  it("--check reports the mismatch and writes nothing", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      bb: { server: "./server.ts" },
      devDependencies: { "@get-bb/plugin-sdk": "0.2.0" },
    });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await expect(
      runCommand(["plugin", "types", rootDir, "--check"], register),
    ).rejects.toThrow("process.exit:1");

    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
  });

  it("is a no-op when the pin already matches", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      bb: { server: "./server.ts" },
      devDependencies: { "@get-bb/plugin-sdk": PLUGIN_SDK_VERSION },
    });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await runCommand(["plugin", "types", rootDir], register);

    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      `already pinned to ${PLUGIN_SDK_VERSION}`,
    );
  });
});
