import { describe, expect, it } from "vitest";
import {
  buildCloudAuthRuntimeMaterial,
  type ClaudeStoredCredential,
  type CloudAuthResolvedCredential,
  type CodexStoredCredential,
} from "../src/index.js";

describe("cloud auth runtime material", () => {
  it("builds managed auth files for claude, codex, and pi without refresh tokens", () => {
    const claudeCredential: ClaudeStoredCredential = {
      accessToken: "claude-access-token",
      accountEmail: "claude@example.test",
      accountId: "acct_claude_test",
      expiresAt: 1_800_000_000_000,
      providerId: "claude-code",
      refreshToken: "claude-refresh-token",
      scopes: ["user:profile", "user:sessions:claude_code"],
      subscriptionType: "max",
    };
    const codexCredential: CodexStoredCredential = {
      accessToken: "codex-access-token",
      accountId: "acct_codex_test",
      expiresAt: 1_800_000_000_500,
      idToken: "codex-id-token",
      providerId: "codex",
      refreshToken: "codex-refresh-token",
    };
    const credentials: CloudAuthResolvedCredential[] = [
      {
        credential: claudeCredential,
        label: "claude@example.test",
        lastErrorMessage: null,
        lastRefreshedAt: 1_700_000_000_000,
        providerId: "claude-code",
        updatedAt: 1_700_000_000_000,
      },
      {
        credential: codexCredential,
        label: "codex@example.test",
        lastErrorMessage: null,
        lastRefreshedAt: 1_700_000_100_000,
        providerId: "codex",
        updatedAt: 1_700_000_100_000,
      },
    ];

    const result = buildCloudAuthRuntimeMaterial({ credentials });

    expect(result.env).toEqual({
      PI_CODING_AGENT_DIR: "~/.pi/agent",
    });
    expect(result.files).toHaveLength(3);

    const codexFile = result.files.find((file) => file.path === "~/.codex/auth.json");
    expect(codexFile).toMatchObject({
      managedBy: "bb-runtime-material",
      mode: 0o600,
    });
    expect(codexFile?.contents).toContain("\"refresh_token\": \"\"");
    expect(codexFile?.contents).toContain("\"access_token\": \"codex-access-token\"");
    expect(codexFile?.contents).toContain("\"account_id\": \"acct_codex_test\"");
    expect(codexFile?.contents).toContain("\"id_token\": \"codex-id-token\"");

    const claudeFile = result.files.find(
      (file) => file.path === "~/.claude/.credentials.json",
    );
    expect(claudeFile).toMatchObject({
      managedBy: "bb-runtime-material",
      mode: 0o600,
    });
    expect(claudeFile?.contents).toContain("\"refreshToken\": \"\"");
    expect(claudeFile?.contents).toContain("\"accessToken\": \"claude-access-token\"");
    expect(claudeFile?.contents).toContain("\"subscriptionType\": \"max\"");

    const piFile = result.files.find((file) => file.path === "~/.pi/agent/auth.json");
    expect(piFile).toMatchObject({
      managedBy: "bb-runtime-material",
      mode: 0o600,
    });
    expect(piFile?.contents).toContain("\"anthropic\"");
    expect(piFile?.contents).toContain("\"openai-codex\"");
    expect(piFile?.contents).toContain("\"refresh\": \"\"");
    expect(piFile?.contents).toContain("\"accountId\": \"acct_codex_test\"");
  });

  it("returns no env or files when there are no credentials", () => {
    expect(buildCloudAuthRuntimeMaterial({ credentials: [] })).toEqual({
      env: {},
      files: [],
    });
  });
});
