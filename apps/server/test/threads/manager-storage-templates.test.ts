import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSession } from "@bb/db";
import type { ManagerTemplateName } from "@bb/domain";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_MANAGER_TEMPLATE_FILE_NAME,
  DEFAULT_MANAGER_TEMPLATE_NAME,
  managerTemplateRootPath,
  seedManagerThreadStorage,
} from "../../src/services/threads/manager-storage-templates.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import { seedHost } from "../helpers/seed.js";
import { createTestAppHarness, testLogger } from "../helpers/test-app.js";

const MINE_MANAGER_TEMPLATE_NAME: ManagerTemplateName = "mine";

interface SeedHarness {
  dataDir: string;
  harness: TestAppHarness;
  hostId: string;
}

interface WriteManagerTemplateSetArgs {
  dataDir: string;
  files: Record<string, string>;
  name: ManagerTemplateName;
}

interface WriteActiveManagerTemplateArgs {
  dataDir: string;
  name: ManagerTemplateName;
}

interface SeedStorageArgs {
  dataDir: string;
  explicitTemplateName: ManagerTemplateName | null;
  harness: TestAppHarness;
  hostId: string;
  logger?: typeof testLogger;
  threadId: string;
}

async function makeDataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "bb-manager-templates-"));
}

async function createSeedHarness(): Promise<SeedHarness> {
  const harness = await createTestAppHarness();
  const dataDir = await makeDataDir();
  const host = seedHost(harness.deps, { id: "host-manager-template" });
  openSession(harness.db, harness.hub, {
    hostId: host.id,
    instanceId: "manager-template-test",
    hostName: "Manager Template Test Host",
    hostType: "persistent",
    dataDir,
    protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    heartbeatIntervalMs: 5_000,
    leaseTimeoutMs: 30_000,
  });
  return {
    dataDir,
    harness,
    hostId: host.id,
  };
}

async function readBundledStatusTemplate(): Promise<string> {
  return readFile(
    new URL(
      "../../src/services/threads/default-template/STATUS.html",
      import.meta.url,
    ),
    "utf8",
  );
}

async function writeManagerTemplateSet(
  args: WriteManagerTemplateSetArgs,
): Promise<void> {
  const templateDir = path.join(
    managerTemplateRootPath({ dataDir: args.dataDir }),
    args.name,
  );
  await mkdir(templateDir, { recursive: true });
  for (const [fileName, content] of Object.entries(args.files)) {
    await writeFile(path.join(templateDir, fileName), content, "utf8");
  }
}

async function writeActiveManagerTemplate(
  args: WriteActiveManagerTemplateArgs,
): Promise<void> {
  const templateRootPath = managerTemplateRootPath({ dataDir: args.dataDir });
  await mkdir(templateRootPath, { recursive: true });
  await writeFile(
    path.join(templateRootPath, ACTIVE_MANAGER_TEMPLATE_FILE_NAME),
    `${args.name}\n`,
    "utf8",
  );
}

async function seedStorage(args: SeedStorageArgs): Promise<string> {
  const threadStoragePath = path.join(
    args.dataDir,
    "thread-storage",
    args.threadId,
  );
  await seedManagerThreadStorage(
    {
      ...args.harness.deps,
      logger: args.logger ?? args.harness.deps.logger,
    },
    {
      explicitTemplateName: args.explicitTemplateName,
      hostId: args.hostId,
      threadId: args.threadId,
      threadStoragePath,
    },
  );
  return threadStoragePath;
}

describe("manager storage templates", () => {
  it("does not create manager templates during server bootstrap", async () => {
    const harness = await createTestAppHarness();
    try {
      await expect(
        stat(managerTemplateRootPath({ dataDir: harness.config.dataDir })),
      ).rejects.toThrow();
    } finally {
      await harness.cleanup();
    }
  });

  it("seeds bundled status when default resolves and no user template directory exists", async () => {
    const { dataDir, harness, hostId } = await createSeedHarness();
    try {
      const threadStoragePath = await seedStorage({
        dataDir,
        explicitTemplateName: null,
        harness,
        hostId,
        threadId: "thr-default-fallback",
      });

      await expect(
        readFile(path.join(threadStoragePath, "STATUS.html"), "utf8"),
      ).resolves.toBe(await readBundledStatusTemplate());
      await expect(
        stat(managerTemplateRootPath({ dataDir })),
      ).rejects.toThrow();
    } finally {
      await harness.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("seeds user-authored default files without bundled fallback", async () => {
    const { dataDir, harness, hostId } = await createSeedHarness();
    try {
      await writeManagerTemplateSet({
        dataDir,
        name: DEFAULT_MANAGER_TEMPLATE_NAME,
        files: {
          "STATUS.html": "user status\n",
        },
      });

      const threadStoragePath = await seedStorage({
        dataDir,
        explicitTemplateName: null,
        harness,
        hostId,
        threadId: "thr-user-default",
      });

      await expect(
        readFile(path.join(threadStoragePath, "STATUS.html"), "utf8"),
      ).resolves.toBe("user status\n");
    } finally {
      await harness.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not mix bundled files into an existing empty default template directory", async () => {
    const { dataDir, harness, hostId } = await createSeedHarness();
    try {
      await writeManagerTemplateSet({
        dataDir,
        name: DEFAULT_MANAGER_TEMPLATE_NAME,
        files: {},
      });

      const threadStoragePath = await seedStorage({
        dataDir,
        explicitTemplateName: null,
        harness,
        hostId,
        threadId: "thr-empty-default",
      });

      await expect(readdir(threadStoragePath)).resolves.toEqual([]);
    } finally {
      await harness.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("warns and skips seeding when active points to a missing non-default template", async () => {
    const { dataDir, harness, hostId } = await createSeedHarness();
    const logger = {
      ...testLogger,
      debug: vi.fn(),
      warn: vi.fn(),
    };
    try {
      await writeActiveManagerTemplate({
        dataDir,
        name: MINE_MANAGER_TEMPLATE_NAME,
      });

      const threadStoragePath = await seedStorage({
        dataDir,
        explicitTemplateName: null,
        harness,
        hostId,
        logger,
        threadId: "thr-missing-active",
      });

      await expect(stat(threadStoragePath)).rejects.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          templateName: MINE_MANAGER_TEMPLATE_NAME,
          threadId: "thr-missing-active",
        }),
        "Manager template directory is missing; skipping storage seed",
      );
    } finally {
      await harness.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("warns and skips seeding when an explicit non-default template is missing", async () => {
    const { dataDir, harness, hostId } = await createSeedHarness();
    const logger = {
      ...testLogger,
      debug: vi.fn(),
      warn: vi.fn(),
    };
    try {
      const threadStoragePath = await seedStorage({
        dataDir,
        explicitTemplateName: MINE_MANAGER_TEMPLATE_NAME,
        harness,
        hostId,
        logger,
        threadId: "thr-missing-explicit",
      });

      await expect(stat(threadStoragePath)).rejects.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          templateName: MINE_MANAGER_TEMPLATE_NAME,
          threadId: "thr-missing-explicit",
        }),
        "Manager template directory is missing; skipping storage seed",
      );
    } finally {
      await harness.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("seeds from the active non-default template when that directory exists", async () => {
    const { dataDir, harness, hostId } = await createSeedHarness();
    try {
      await writeActiveManagerTemplate({
        dataDir,
        name: MINE_MANAGER_TEMPLATE_NAME,
      });
      await writeManagerTemplateSet({
        dataDir,
        name: MINE_MANAGER_TEMPLATE_NAME,
        files: {
          "STATUS.html": "mine status\n",
        },
      });

      const threadStoragePath = await seedStorage({
        dataDir,
        explicitTemplateName: null,
        harness,
        hostId,
        threadId: "thr-active-mine",
      });

      await expect(
        readFile(path.join(threadStoragePath, "STATUS.html"), "utf8"),
      ).resolves.toBe("mine status\n");
    } finally {
      await harness.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
