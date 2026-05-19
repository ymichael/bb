import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureBuiltInManagerTemplatesInstalled,
  managerTemplateRootPath,
} from "../../src/services/threads/manager-storage-templates.js";
import { testLogger } from "../helpers/test-app.js";

async function makeDataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "bb-manager-templates-"));
}

describe("manager storage templates", () => {
  it("installs the default built-in manager template set", async () => {
    const dataDir = await makeDataDir();
    try {
      await ensureBuiltInManagerTemplatesInstalled({
        dataDir,
        logger: testLogger,
      });

      const templateRootPath = managerTemplateRootPath({ dataDir });
      await expect(
        readFile(path.join(templateRootPath, "active"), "utf8"),
      ).resolves.toBe("default\n");
      await expect(
        readdir(path.join(templateRootPath, "default")),
      ).resolves.toEqual(["STATUS.html"]);
      await expect(
        readFile(path.join(templateRootPath, "default", "STATUS.html"), "utf8"),
      ).resolves.toContain('<div class="sect-title">Open PRs · 0</div>');
      await expect(
        readFile(
          path.join(templateRootPath, "default", "PREFERENCES.md"),
          "utf8",
        ),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(templateRootPath, "default", "ASYNC.md"), "utf8"),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(templateRootPath, "default", "STATUS.md"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing default manager template directory", async () => {
    const dataDir = await makeDataDir();
    try {
      const templateRootPath = managerTemplateRootPath({ dataDir });
      const defaultTemplatePath = path.join(templateRootPath, "default");
      await mkdir(defaultTemplatePath, { recursive: true });
      await writeFile(
        path.join(defaultTemplatePath, "PREFERENCES.md"),
        "custom prefs\n",
        "utf8",
      );
      await writeFile(
        path.join(defaultTemplatePath, "STATUS.html"),
        "custom status\n",
        "utf8",
      );

      await ensureBuiltInManagerTemplatesInstalled({
        dataDir,
        logger: testLogger,
      });

      await expect(
        readFile(path.join(defaultTemplatePath, "PREFERENCES.md"), "utf8"),
      ).resolves.toBe("custom prefs\n");
      await expect(
        readFile(path.join(defaultTemplatePath, "STATUS.html"), "utf8"),
      ).resolves.toBe("custom status\n");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
