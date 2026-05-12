// @vitest-environment jsdom

import { Suspense, useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useIsMutating } from "@tanstack/react-query";
import type { ThreadWithRuntime } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import {
  HIRE_PROJECT_MANAGER_MUTATION_KEY,
  useHireProjectManager,
} from "./project-mutations";

interface ProjectMutationsWrapperProps {
  children: ReactNode;
}

interface DeferredResponse {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
}

interface HireManagerSubmitterProps {
  onSubmitted: () => void;
}

function createDeferredResponse(): DeferredResponse {
  let resolveResponse: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });

  return {
    promise,
    resolve: resolveResponse,
  };
}

function makeManagerThread(): ThreadWithRuntime {
  return {
    id: "thr-manager-1",
    projectId: "proj-1",
    environmentId: "env-1",
    automationId: null,
    providerId: "pi",
    type: "manager",
    title: "Manager",
    titleFallback: "Manager",
    status: "active",
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
    runtime: {
      displayStatus: "active",
      hostReconnectGraceExpiresAt: null,
    },
  };
}

function createProjectMutationsWrapper() {
  const harness = createQueryClientTestHarness();

  function ProjectMutationsWrapper({ children }: ProjectMutationsWrapperProps) {
    return harness.wrapper({
      children: <Suspense fallback={null}>{children}</Suspense>,
    });
  }

  return ProjectMutationsWrapper;
}

function HireManagerSubmitter({ onSubmitted }: HireManagerSubmitterProps) {
  const hireProjectManager = useHireProjectManager();

  return (
    <button
      type="button"
      onClick={() => {
        hireProjectManager.mutate({
          projectId: "proj-1",
          providerId: "pi",
          model: "model-1",
          reasoningLevel: "medium",
          environment: { type: "host", hostId: "host-local" },
        });
        onSubmitted();
      }}
    >
      Submit hire
    </button>
  );
}

function PendingObserverHarness() {
  const [showSubmitter, setShowSubmitter] = useState(true);
  const activeHireManagerRequests = useIsMutating({
    mutationKey: HIRE_PROJECT_MANAGER_MUTATION_KEY,
  });

  return (
    <>
      {showSubmitter ? (
        <HireManagerSubmitter onSubmitted={() => setShowSubmitter(false)} />
      ) : null}
      <span>
        {activeHireManagerRequests > 0 ? "hire pending" : "hire idle"}
      </span>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project mutations", () => {
  it("reports hire manager pending after the submitting component unmounts", async () => {
    const pendingResponse = createDeferredResponse();
    installFetchRoutes([
      {
        method: "POST",
        pathname: "/api/v1/projects/proj-1/managers",
        handler: () => pendingResponse.promise,
      },
    ]);
    const wrapper = createProjectMutationsWrapper();

    await act(async () => {
      render(<PendingObserverHarness />, { wrapper });
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit hire" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Submit hire" })).toBeNull();
      expect(screen.getByText("hire pending")).toBeTruthy();
    });

    await act(async () => {
      pendingResponse.resolve(jsonResponse(makeManagerThread()));
    });

    await waitFor(() => {
      expect(screen.getByText("hire idle")).toBeTruthy();
    });
  });
});
