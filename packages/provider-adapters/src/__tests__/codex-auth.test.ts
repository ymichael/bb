import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCodexProviderLaunchConfiguration } from "../codex-auth.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;

async function writeAuthJson(
  homePath: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const codexDir = join(homePath, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "auth.json"), JSON.stringify(payload), "utf8");
}

describe("resolveCodexProviderLaunchConfiguration", () => {
  let tempHomePath = "";

  beforeEach(async () => {
    tempHomePath = await mkdtemp(join(tmpdir(), "bb-codex-auth-"));
    process.env.HOME = tempHomePath;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(async () => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;

    if (ORIGINAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;

    if (ORIGINAL_OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = ORIGINAL_OPENAI_BASE_URL;

    if (tempHomePath) {
      await rm(tempHomePath, { recursive: true, force: true });
      tempHomePath = "";
    }
  });

  it("returns env passthrough when explicit OpenAI env vars are set", async () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";

    await expect(resolveCodexProviderLaunchConfiguration()).resolves.toEqual({
      env: {
        OPENAI_API_KEY: "sk-test-123",
        OPENAI_BASE_URL: "https://example.test/v1",
      },
    });
  });

  it("materializes the host codex auth file when available", async () => {
    await writeAuthJson(tempHomePath, {
      auth_mode: "chatgpt",
      tokens: {
        access_token: "chatgpt-token",
        account_id: "org_123",
      },
    });

    await expect(resolveCodexProviderLaunchConfiguration()).resolves.toEqual({
      files: [
        {
          placement: "home",
          path: ".codex/auth.json",
          content: JSON.stringify(
            {
              auth_mode: "chatgpt",
              tokens: {
                access_token: "chatgpt-token",
                account_id: "org_123",
              },
            },
            null,
            2,
          ),
        },
      ],
    });
  });
});
