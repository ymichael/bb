import { describe, expect, it } from "vitest";
import {
  buildHostRuntimeMaterialVersion,
  createHostRuntimeMaterialSnapshot,
  isEmptyHostRuntimeMaterialSnapshot,
} from "../src/index.js";

describe("runtime material snapshot", () => {
  it("builds a stable version regardless of env or file ordering", () => {
    const first = buildHostRuntimeMaterialVersion({
      env: {
        OPENAI_API_KEY: "test-openai-key",
        ANTHROPIC_API_KEY: "test-anthropic-key",
      },
      files: [
        {
          contents: "{\"token\":\"b\"}\n",
          managedBy: "bb-runtime-material",
          mode: 0o600,
          path: "~/.codex/auth.json",
        },
        {
          contents: "{\"token\":\"a\"}\n",
          managedBy: "bb-runtime-material",
          mode: 0o600,
          path: "~/.claude/.credentials.json",
        },
      ],
    });

    const second = buildHostRuntimeMaterialVersion({
      env: {
        ANTHROPIC_API_KEY: "test-anthropic-key",
        OPENAI_API_KEY: "test-openai-key",
      },
      files: [
        {
          contents: "{\"token\":\"a\"}\n",
          managedBy: "bb-runtime-material",
          mode: 0o600,
          path: "~/.claude/.credentials.json",
        },
        {
          contents: "{\"token\":\"b\"}\n",
          managedBy: "bb-runtime-material",
          mode: 0o600,
          path: "~/.codex/auth.json",
        },
      ],
    });

    expect(second).toBe(first);
  });

  it("creates versioned snapshots and detects empty ones", () => {
    const empty = createHostRuntimeMaterialSnapshot({
      env: {},
      files: [],
    });
    expect(empty.version).not.toBe("");
    expect(isEmptyHostRuntimeMaterialSnapshot(empty)).toBe(true);

    const populated = createHostRuntimeMaterialSnapshot({
      env: {
        OPENAI_API_KEY: "test-openai-key",
      },
      files: [],
    });
    expect(isEmptyHostRuntimeMaterialSnapshot(populated)).toBe(false);
  });
});
