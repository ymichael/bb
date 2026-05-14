// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installAbortableJsonRoute } from "@/test/abort-signal-test-utils";
import { useProjectPromptHistory } from "./project-queries";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project queries", () => {
  it("passes AbortSignal through project prompt history requests", async () => {
    const route = installAbortableJsonRoute({
      pathname: "/api/v1/projects/project-1/prompt-history",
      body: [],
    });
    const { wrapper } = createQueryClientTestHarness();
    const { unmount } = renderHook(
      () => useProjectPromptHistory("project-1"),
      { wrapper },
    );

    await waitFor(() => {
      expect(route.getSignal()).toBeInstanceOf(AbortSignal);
    });

    unmount();

    await waitFor(() => {
      expect(route.getSignal()?.aborted).toBe(true);
    });
  });
});
