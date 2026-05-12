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
import type {
  CreateManagerThreadRequest,
  ProjectResponse,
  SystemProviderInfo,
} from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableModelsQueryKey,
  systemProvidersQueryKey,
  threadQueryKey,
} from "@/hooks/queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { resetFakeReconnectingWebSockets } from "@/test/fake-reconnecting-websocket";
import {
  installFetchRoutes,
  jsonResponse,
  type FetchRoute,
} from "@/test/http-test-utils";
import { createTestSystemProvider } from "@/test/system-provider-test-utils";
import { HireManagerDialog } from "./HireManagerDialog";

vi.mock("partysocket/ws", async () => {
  const { FakeReconnectingWebSocket } =
    await import("@/test/fake-reconnecting-websocket");
  return {
    default: FakeReconnectingWebSocket,
  };
});

interface InstallHireManagerRoutesArgs {
  managerThread?: Thread;
  modelResponsesByProvider?: Record<string, AvailableModel[]>;
  projects?: ProjectResponse[];
  systemProviders?: SystemProvidersFixture;
}

type SystemProvidersFixture =
  | SystemProviderInfo[]
  | (() => SystemProviderInfo[]);

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

function makeSecondProjectResponse(): ProjectResponse {
  return {
    id: "proj-2",
    name: "Second Demo",
    createdAt: 2,
    updatedAt: 2,
    sources: [
      {
        id: "src-2",
        projectId: "proj-2",
        type: "local_path",
        hostId: "host-local",
        path: "/tmp/second-demo",
        isDefault: true,
        createdAt: 2,
        updatedAt: 2,
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

function getProviderModelButton(): HTMLElement {
  return screen.getByRole("button", { name: "Provider and model" });
}

async function openProviderModelPicker(): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", { name: "Provider and model" }),
  );
}

function expectProviderModelTitle(parts: readonly string[]): void {
  const title = getProviderModelButton().title;
  for (const part of parts) {
    expect(title).toContain(part);
  }
}

async function selectProviderModel(args: {
  provider: string;
  model: string;
}): Promise<void> {
  await openProviderModelPicker();
  fireEvent.click(await screen.findByTitle(args.provider));
  fireEvent.click(await waitFor(() => findOptionLabel(args.model)));
}

function createDefaultSystemProviders(): SystemProviderInfo[] {
  return [
    createTestSystemProvider({
      capabilities: {
        supportsArchive: false,
        supportsServiceTier: true,
        supportedPermissionModes: ["full"],
      },
      displayName: "Pi",
      id: "pi",
    }),
    createTestSystemProvider({
      capabilities: {
        supportsServiceTier: true,
      },
      displayName: "Codex",
      id: "codex",
    }),
  ];
}

function resolveSystemProviders(
  systemProviders: SystemProvidersFixture,
): SystemProviderInfo[] {
  return typeof systemProviders === "function"
    ? systemProviders()
    : systemProviders;
}

function installHireManagerRoutes(args: InstallHireManagerRoutesArgs = {}) {
  const managerThread = args.managerThread ?? makeThread();
  const managerRequests: CreateManagerThreadRequest[] = [];
  const managerRequestProjectIds: string[] = [];
  const requestedModelProviders: Array<string | null> = [];
  const systemProviders =
    args.systemProviders ?? createDefaultSystemProviders();
  const projects = args.projects ?? [makeProjectResponse()];
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
      handler: async () =>
        jsonResponse(resolveSystemProviders(systemProviders)),
    },
  ];

  for (const project of projects) {
    routes.push({
      method: "POST",
      pathname: `/api/v1/projects/${project.id}/managers`,
      handler: async (request: Request) => {
        managerRequestProjectIds.push(project.id);
        managerRequests.push(await request.json());
        return jsonResponse(managerThread);
      },
    });
  }

  if (args.modelResponsesByProvider) {
    routes.push({
      pathname: "/api/v1/system/models",
      handler: async (request: Request) => {
        const url = new URL(request.url);
        const providerId = url.searchParams.get("providerId");
        requestedModelProviders.push(providerId);
        return jsonResponse(
          providerId ? (args.modelResponsesByProvider?.[providerId] ?? []) : [],
        );
      },
    });
  }

  installFetchRoutes(routes);

  return {
    managerRequests,
    managerRequestProjectIds,
    managerThread,
    requestedModelProviders,
  };
}

async function renderOpenHireManagerDialog(args: {
  onClose?: () => void;
  onHired?: (thread: Thread) => void;
  wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
}) {
  await act(async () => {
    render(
      <HireManagerDialog
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

describe("HireManagerDialog", () => {
  it("shows an empty provider state after providers load with no entries", async () => {
    installHireManagerRoutes({
      systemProviders: [],
    });
    const { wrapper } = createSuspenseWrapper();

    await renderOpenHireManagerDialog({
      wrapper,
    });

    await waitFor(() => {
      expect(screen.getByText("No providers available")).toBeTruthy();
    });
    expect(screen.queryByText("Loading providers…")).toBeNull();
  });

  it("omits the server default option and submits the selected provider and model", async () => {
    const piModels = [
      makeModel("anthropic/claude-opus-4-7", {
        displayName: "Claude Opus 4.7",
        isDefault: true,
      }),
    ];
    const { managerRequests, managerThread, requestedModelProviders } =
      installHireManagerRoutes({
        modelResponsesByProvider: {
          pi: piModels,
        },
      });
    const { queryClient, wrapper } = createSuspenseWrapper();
    const onHired = vi.fn();

    await renderOpenHireManagerDialog({
      onHired,
      wrapper,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host" }).title).toContain(
        "Local Host",
      );
    });
    await waitFor(() => {
      expectProviderModelTitle(["Pi", "Claude Opus 4.7"]);
    });

    await openProviderModelPicker();
    fireEvent.click(await waitFor(() => findOptionLabel("Claude Opus 4.7")));
    expect(screen.queryByText("Server Default")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hire Manager" }));

    await waitFor(() => {
      expect(managerRequests).toEqual([
        {
          origin: "app",
          providerId: "pi",
          model: "anthropic/claude-opus-4-7",
          reasoningLevel: "medium",
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
    expect(requestedModelProviders).toEqual(["pi"]);
  });

  it("submits the manager hire for the project selected in the dialog", async () => {
    const piModels = [
      makeModel("anthropic/claude-opus-4-7", {
        displayName: "Claude Opus 4.7",
        isDefault: true,
      }),
    ];
    const managerThread = { ...makeThread(), projectId: "proj-2" };
    const { managerRequests, managerRequestProjectIds } =
      installHireManagerRoutes({
        managerThread,
        modelResponsesByProvider: {
          pi: piModels,
        },
        projects: [makeProjectResponse(), makeSecondProjectResponse()],
      });
    const { wrapper } = createSuspenseWrapper();

    await renderOpenHireManagerDialog({
      wrapper,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Project" }).title).toContain(
        "Demo",
      );
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Project" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Second Demo" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Project" }).title).toContain(
        "Second Demo",
      );
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host" }).title).toContain(
        "Local Host",
      );
    });
    await waitFor(() => {
      expectProviderModelTitle(["Pi", "Claude Opus 4.7"]);
    });

    fireEvent.click(screen.getByRole("button", { name: "Hire Manager" }));

    await waitFor(() => {
      expect(managerRequestProjectIds).toEqual(["proj-2"]);
      expect(managerRequests).toEqual([
        {
          origin: "app",
          providerId: "pi",
          model: "anthropic/claude-opus-4-7",
          reasoningLevel: "medium",
          environment: { type: "host", hostId: "host-local" },
        },
      ]);
    });
  });

  it("keeps the visible fallback provider selected when a stale provider returns", async () => {
    let systemProviders = createDefaultSystemProviders();
    const piModels = [
      makeModel("anthropic/claude-opus-4-7", {
        displayName: "Claude Opus 4.7",
        isDefault: true,
      }),
    ];
    const codexModels = [
      makeModel("openai-codex/gpt-5.4", {
        displayName: "GPT-5.4",
        isDefault: true,
      }),
    ];
    installHireManagerRoutes({
      modelResponsesByProvider: {
        pi: piModels,
        codex: codexModels,
      },
      systemProviders: () => systemProviders,
    });
    const { queryClient, wrapper } = createSuspenseWrapper();

    await renderOpenHireManagerDialog({
      wrapper,
    });

    await waitFor(() => {
      expectProviderModelTitle(["Pi"]);
    });

    await selectProviderModel({
      provider: "Codex",
      model: "GPT-5.4",
    });

    await waitFor(() => {
      expectProviderModelTitle(["Codex", "GPT-5.4"]);
    });

    systemProviders = systemProviders.filter(
      (provider) => provider.id === "pi",
    );
    await queryClient.refetchQueries({ queryKey: systemProvidersQueryKey() });

    await waitFor(() => {
      expectProviderModelTitle(["Pi"]);
    });

    systemProviders = createDefaultSystemProviders();
    await queryClient.refetchQueries({ queryKey: systemProvidersQueryKey() });

    await waitFor(() => {
      expectProviderModelTitle(["Pi"]);
    });
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
    const codexModels = [
      makeModel("openai-codex/gpt-5.4", {
        displayName: "GPT-5.4",
        isDefault: true,
      }),
    ];
    const { managerRequests, requestedModelProviders } =
      installHireManagerRoutes({
        modelResponsesByProvider: {
          pi: piModels,
          codex: codexModels,
        },
      });
    const { queryClient, wrapper } = createSuspenseWrapper();

    await renderOpenHireManagerDialog({
      wrapper,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host" }).title).toContain(
        "Local Host",
      );
    });

    await selectProviderModel({
      provider: "Codex",
      model: "GPT-5.4",
    });

    await waitFor(() => {
      expectProviderModelTitle(["Codex", "GPT-5.4"]);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reasoning" }).title).toContain(
        "Medium",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Hire Manager" }));

    await waitFor(() => {
      expect(managerRequests).toEqual([
        {
          origin: "app",
          providerId: "codex",
          model: "openai-codex/gpt-5.4",
          reasoningLevel: "medium",
          environment: { type: "host", hostId: "host-local" },
        },
      ]);
    });
    expect(requestedModelProviders).toEqual(["pi", "codex"]);
    expect(
      queryClient.getQueryData(availableModelsQueryKey("codex", null)),
    ).toEqual(codexModels);
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

    await renderOpenHireManagerDialog({
      wrapper,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host" }).title).toContain(
        "Local Host",
      );
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reasoning" }).title).toContain(
        "Extra High",
      );
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Reasoning" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await waitFor(() => findOptionLabel("Medium")));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reasoning" }).title).toContain(
        "Medium",
      );
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
      expect(screen.getByRole("button", { name: "Reasoning" }).title).toContain(
        "Medium",
      );
    });
  });
});
