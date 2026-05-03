// @vitest-environment jsdom

import { Suspense, type JSX, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AvailableModel, Host, Thread } from "@bb/domain";
import type { ProjectResponse, SystemProviderInfo } from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { availableModelsQueryKey, threadQueryKey } from "@/hooks/queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { resetFakeReconnectingWebSockets } from "@/test/fake-reconnecting-websocket";
import {
  installFetchRoutes,
  jsonResponse,
  type FetchRoute,
} from "@/test/http-test-utils";
import { HireManagerModal } from "./HireManagerModal";

vi.mock("partysocket/ws", async () => {
  const { FakeReconnectingWebSocket } = await import(
    "@/test/fake-reconnecting-websocket"
  );
  return {
    default: FakeReconnectingWebSocket,
  };
});

interface InstallHireManagerRoutesArgs {
  managerThread?: Thread;
  modelResponsesByProvider?: Record<string, AvailableModel[]>;
}

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function createSuspenseWrapper() {
  const { queryClient, wrapper: baseWrapper } = createQueryClientTestHarness();

  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) =>
      baseWrapper({
        children: <Suspense fallback={null}>{children}</Suspense>,
      }),
  };
}

function makeProvider(
  id: string,
  displayName: string,
  supportedPermissionModes: SystemProviderInfo["capabilities"]["supportedPermissionModes"],
): SystemProviderInfo {
  return {
    id,
    displayName,
    capabilities: {
      supportsRename: true,
      supportsServiceTier: true,
      supportedPermissionModes: [...supportedPermissionModes],
    },
    available: true,
  };
}

function makeModel(
  model: string,
  overrides: Partial<AvailableModel> = {},
): AvailableModel {
  return {
    id: model,
    model,
    displayName: model,
    description: model,
    supportedReasoningEfforts: [
      {
        reasoningEffort: "medium",
        description: "Medium reasoning effort",
      },
    ],
    defaultReasoningEffort: "medium",
    isDefault: false,
    ...overrides,
  };
}

function makeProjectResponse(): ProjectResponse {
  return {
    id: "proj-1",
    name: "Demo",
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: "src-1",
        projectId: "proj-1",
        type: "local_path",
        hostId: "host-local",
        path: "/tmp/demo",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

function makeHost(id: string, name: string): Host {
  return {
    id,
    name,
    type: "persistent",
    status: "connected",
    lastSeenAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeThread(): Thread {
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
  };
}

function findOptionLabel(text: string): HTMLElement {
  const label = screen
    .getAllByText(text)
    .find((element) => element.tagName === "SPAN");
  if (!label) {
    throw new Error(`Could not find option label "${text}"`);
  }
  return label;
}

function installHireManagerRoutes(args: InstallHireManagerRoutesArgs = {}) {
  const managerThread = args.managerThread ?? makeThread();
  const managerRequests: unknown[] = [];
  const requestedModelProviders: Array<string | null> = [];
  const providers = [
    makeProvider("pi", "Pi", ["full"]),
    makeProvider("codex", "Codex", ["full", "workspace-write", "readonly"]),
  ];
  const projects = [makeProjectResponse()];
  const hosts = [makeHost("host-local", "Local Host")];

  const routes: FetchRoute[] = [
    {
      pathname: "/api/v1/system/config",
      handler: async () =>
        jsonResponse({
          githubConnected: false,
          hostDaemonPort: 3001,
          sandboxHostSupported: false,
          voiceTranscriptionEnabled: false,
        }),
    },
    {
      pathname: "/status",
      port: 3001,
      handler: async () =>
        jsonResponse({
          connected: true,
          hostId: "host-local",
          serverUrl: "http://localhost:3334",
          supportsNativeFolderPicker: true,
          platform: "darwin",
        }),
    },
    {
      pathname: "/api/v1/projects",
      handler: async () => jsonResponse(projects),
    },
    {
      pathname: "/api/v1/hosts",
      handler: async () => jsonResponse(hosts),
    },
    {
      pathname: "/api/v1/system/providers",
      handler: async () => jsonResponse(providers),
    },
    {
      method: "POST",
      pathname: "/api/v1/projects/proj-1/managers",
      handler: async (request: Request) => {
        managerRequests.push(await request.json());
        return jsonResponse(managerThread);
      },
    },
  ];

  if (args.modelResponsesByProvider) {
    routes.push({
      pathname: "/api/v1/system/models",
      handler: async (request: Request) => {
        const url = new URL(request.url);
        const providerId = url.searchParams.get("providerId");
        requestedModelProviders.push(providerId);
        return jsonResponse(
          providerId
            ? (args.modelResponsesByProvider?.[providerId] ?? [])
            : [],
        );
      },
    });
  }

  installFetchRoutes(routes);

  return {
    managerRequests,
    managerThread,
    requestedModelProviders,
  };
}

async function renderOpenHireManagerModal(args: {
  onClose?: () => void;
  onHired?: (thread: Thread) => void;
  wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
}) {
  await act(async () => {
    render(
      <HireManagerModal
        projectId="proj-1"
        open
        onClose={args.onClose ?? (() => {})}
        onHired={args.onHired ?? (() => {})}
      />,
      { wrapper: args.wrapper },
    );
  });
}

beforeEach(() => {
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  resetFakeReconnectingWebSockets();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HireManagerModal", () => {
  it("submits a real hire request without provider or model when using the server default", async () => {
    const { managerRequests, managerThread } = installHireManagerRoutes();
    const { queryClient, wrapper } = createSuspenseWrapper();
    const onHired = vi.fn();

    await renderOpenHireManagerModal({
      onHired,
      wrapper,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host" }).title).toContain(
        "Local Host",
      );
    });
    expect(
      screen.getByText(
        "Using server-owned manager defaults unless you choose an override.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hire Manager" }));

    await waitFor(() => {
      expect(managerRequests).toEqual([
        {
          origin: "app",
          environment: { type: "host", hostId: "host-local" },
        },
      ]);
    });
    await waitFor(() => {
      expect(onHired).toHaveBeenCalledWith(managerThread);
    });
    expect(queryClient.getQueryData(threadQueryKey(managerThread.id))).toEqual(
      managerThread,
    );
  });

  it("submits the selected provider override through the real models query and hire mutation", async () => {
    const piModels = [
      makeModel("anthropic/claude-sonnet-4-6"),
      makeModel("anthropic/claude-opus-4-7", {
        displayName: "Claude Opus 4.7",
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "medium",
            description: "Medium reasoning effort",
          },
          {
            reasoningEffort: "xhigh",
            description: "Extra high reasoning effort",
          },
        ],
        isDefault: true,
      }),
    ];
    const { managerRequests, requestedModelProviders } =
      installHireManagerRoutes({
        modelResponsesByProvider: {
          pi: piModels,
        },
      });
    const { queryClient, wrapper } = createSuspenseWrapper();

    await renderOpenHireManagerModal({
      wrapper,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host" }).title).toContain(
        "Local Host",
      );
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Provider" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await waitFor(() => findOptionLabel("Pi")));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Model" }).title).toContain(
        "Claude Opus 4.7",
      );
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Reasoning" }).title,
      ).toContain("Extra High");
    });

    fireEvent.click(screen.getByRole("button", { name: "Hire Manager" }));

    await waitFor(() => {
      expect(managerRequests).toEqual([
        {
          origin: "app",
          providerId: "pi",
          model: "anthropic/claude-opus-4-7",
          reasoningLevel: "xhigh",
          environment: { type: "host", hostId: "host-local" },
        },
      ]);
    });
    expect(requestedModelProviders).toEqual(["pi"]);
    expect(
      queryClient.getQueryData(availableModelsQueryKey("pi", null)),
    ).toEqual(piModels);
  });

  it("preserves a user-selected reasoning level across real model refetches", async () => {
    const modelResponsesByProvider = {
      pi: [
        makeModel("anthropic/claude-sonnet-4-6"),
        makeModel("anthropic/claude-opus-4-7", {
          displayName: "Claude Opus 4.7",
          defaultReasoningEffort: "xhigh",
          supportedReasoningEfforts: [
            {
              reasoningEffort: "medium",
              description: "Medium reasoning effort",
            },
            {
              reasoningEffort: "xhigh",
              description: "Extra high reasoning effort",
            },
          ],
          isDefault: true,
        }),
      ],
    };
    installHireManagerRoutes({
      modelResponsesByProvider,
    });
    const { queryClient, wrapper } = createSuspenseWrapper();

    await renderOpenHireManagerModal({
      wrapper,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host" }).title).toContain(
        "Local Host",
      );
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Provider" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await waitFor(() => findOptionLabel("Pi")));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Reasoning" }).title,
      ).toContain("Extra High");
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Reasoning" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await waitFor(() => findOptionLabel("Medium")));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Reasoning" }).title,
      ).toContain("Medium");
    });

    modelResponsesByProvider.pi = [
      makeModel("anthropic/claude-sonnet-4-6"),
      makeModel("anthropic/claude-opus-4-7", {
        displayName: "Claude Opus 4.7",
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "medium",
            description: "Medium reasoning effort",
          },
          {
            reasoningEffort: "xhigh",
            description: "Extra high reasoning effort",
          },
        ],
        isDefault: true,
      }),
    ];

    await queryClient.refetchQueries({
      queryKey: availableModelsQueryKey("pi", null),
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Reasoning" }).title,
      ).toContain("Medium");
    });
  });
});
