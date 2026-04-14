import { describe, expect, it } from "vitest";
import { getCloudAuthProviderDefinition } from "../src/index.js";

describe("cloud auth provider definitions", () => {
  it("formats Claude OAuth scopes with percent-encoded spaces", async () => {
    const flow = await getCloudAuthProviderDefinition("claude-code")
      .createAuthorizationFlow();

    expect(flow.authorizationUrl).toContain(
      "scope=org%3Acreate_api_key%20user%3Aprofile%20user%3Ainference%20user%3Asessions%3Aclaude_code%20user%3Amcp_servers%20user%3Afile_upload",
    );
    expect(flow.authorizationUrl).not.toContain("scope=org%3Acreate_api_key+");
  });

  it("formats Codex OAuth scopes with percent-encoded spaces", async () => {
    const flow = await getCloudAuthProviderDefinition("codex")
      .createAuthorizationFlow();

    expect(flow.authorizationUrl).toContain(
      "scope=openid%20profile%20email%20offline_access",
    );
    expect(flow.authorizationUrl).not.toContain("scope=openid+");
  });
});
