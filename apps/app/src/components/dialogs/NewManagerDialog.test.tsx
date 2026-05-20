// @vitest-environment jsdom

import { Suspense, useEffect, type JSX, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { AvailableModel, Host, ProviderInfo, Thread } from "@bb/domain";
import type {
  CreateManagerThreadRequest,
  ProjectResponse,
} from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  systemExecutionOptionsQueryKey,
  threadQueryKey,
} from "@/hooks/queries/query-keys";
import {
  NewManagerDialogProvider,
  useNewManagerDialog,
} from "@/hooks/useNewManagerDialog";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { resetFakeReconnectingWebSockets } from "@/test/fake-reconnecting-websocket";
import {
  installFetchRoutes,
  jsonResponse,
  type FetchRoute,
} from "@/test/http-test-utils";
import { createTestSystemProvider } from "@/test/system-provider-test-utils";
import { NewManagerDialog } from "./NewManagerDialog";

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

type SystemProvidersFixture = ProviderInfo[] | (() => ProviderInfo[]);
type RequestedModelProvider = string | null;
type RequestedModelProviders = RequestedModelProvider[];

interface RefetchExecutionOptionsArgs {
  providerId: string;
  queryClient: QueryClient;
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

function getCreateButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: "Create" });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Create control is not a button");
  }
  return button;
}

async function waitForCreateButtonReady(): Promise<void> {
  await waitFor(() => {
    expect(getCreateButton().disabled).toBe(false);
  });
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

async function refetchExecutionOptions(
  args: RefetchExecutionOptionsArgs,
): Promise<void> {
  await act(async () => {
    await args.queryClient.refetchQueries({
      queryKey: systemExecutionOptionsQueryKey({
        environmentId: null,
        providerId: args.providerId,
      }),
      type: "all",
    });
  });
}

function createDefaultSystemProviders(): ProviderInfo[] {
  return [
    createTestSystemProvider({
      capabilities: {
        supportsArchive: false,
        supportsServiceTier: true,
        supportsUserQuestion: false,
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
): ProviderInfo[] {
  return typeof systemProviders === "function"
    ? systemProviders()
    : systemProviders;
}

function compactConsecutiveProviderRequests(
  requests: readonly RequestedModelProvider[],
): RequestedModelProviders {
  const compacted: RequestedModelProviders = [];
  for (const request of requests) {
    if (compacted[compacted.length - 1] !== request) {
      compacted.push(request);
    }
  }
  return compacted;
}

function installNewManagerRoutes(args: InstallHireManagerRoutesArgs = {}) {
  const managerThread = args.managerThread ?? makeThread();
  const managerRequests: CreateManagerThreadRequest[] = [];
  const managerRequestProjectIds: string[] = [];
  const requestedModelProviders: RequestedModelProviders = [];
  const systemProviders =
    args.systemProviders ?? createDefaultSystemProviders();
  const projects = args.projects ?? [makeProjectResponse()];
  const hosts = [makeHost("host-local", "Local Host")];

  const routes: FetchRoute[] = [
    {
      pathname: "/api/v1/system/config",
      handler: async () =>
        jsonResponse({
          hostDaemonPort: 3001,
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

  routes.push({
    pathname: "/api/v1/system/execution-options",
    handler: async (request: Request) => {
      const url = new URL(request.url);
      const requestedProviderId = url.searchParams.get("providerId");
      const providers = resolveSystemProviders(systemProviders);
      const resolvedProviderId =
        (requestedProviderId &&
          providers.find((p) => p.id === requestedProviderId)?.id) ||
        providers[0]?.id ||
        null;
      requestedModelProviders.push(resolvedProviderId);
      const models = resolvedProviderId
        ? (args.modelResponsesByProvider?.[resolvedProviderId] ?? [])
        : [];
      return jsonResponse({ providers, models });
    },
  });

  installFetchRoutes(routes);

  return {
    managerRequests,
    managerRequestProjectIds,
    managerThread,
    requestedModelProviders,
  };
}

interface RenderNewManagerDialogArgs {
  initialProjectId?: string;
  wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
}

function ThreadRouteProbe() {
  const location = useLocation();
  return <p>Thread route: {location.pathname}</p>;
}

function NewManagerDialogProbe({ projectId }: { projectId: string }) {
  const { open } = useNewManagerDialog();
  useEffect(() => {
    open(projectId);
  }, [open, projectId]);
  return <NewManagerDialog />;
}

async function renderNewManagerDialog(args: RenderNewManagerDialogArgs) {
  const projectId = args.initialProjectId ?? "proj-1";
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
        <NewManagerDialogProvider>
          <Routes>
            <Route
              path="/projects/:projectId"
              element={<NewManagerDialogProbe projectId={projectId} />}
            />
            <Route
              path="/projects/:projectId/threads/:threadId"
              element={<ThreadRouteProbe />}
            />
          </Routes>
        </NewManagerDialogProvider>
      </MemoryRouter>,
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

describe("NewManagerDialog", () => {
  it("submits the default manager hire through the route and caches the created thread", async () => {
    const piModels = [
      makeModel("anthropic/claude-opus-4-7", {
        displayName: "Claude Opus 4.7",
        isDefault: true,
      }),
    ];
    const {
      managerRequests,
      managerRequestProjectIds,
      managerThread,
      requestedModelProviders,
    } = installNewManagerRoutes({
      modelResponsesByProvider: {
        pi: piModels,
      },
    });
    const { queryClient, wrapper } = createSuspenseWrapper();

    await renderNewManagerDialog({ wrapper });

    await waitFor(() => {
      expectProviderModelTitle(["Pi", "Claude Opus 4.7"]);
    });

    await waitForCreateButtonReady();
    fireEvent.click(getCreateButton());

    await waitFor(() => {
      expect(managerRequestProjectIds).toEqual(["proj-1"]);
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
    expect(
      await screen.findByText(
        `Thread route: /projects/${managerThread.projectId}/threads/${managerThread.id}`,
      ),
    ).toBeTruthy();
    expect(queryClient.getQueryData(threadQueryKey(managerThread.id))).toEqual(
      managerThread,
    );
    expect(compactConsecutiveProviderRequests(requestedModelProviders)).toEqual(
      ["pi"],
    );
  });

  it("submits the manager hire for the project selected on the page", async () => {
    const piModels = [
      makeModel("anthropic/claude-opus-4-7", {
        displayName: "Claude Opus 4.7",
        isDefault: true,
      }),
    ];
    const managerThread = { ...makeThread(), projectId: "proj-2" };
    const { managerRequests, managerRequestProjectIds } =
      installNewManagerRoutes({
        managerThread,
        modelResponsesByProvider: {
          pi: piModels,
        },
        projects: [makeProjectResponse(), makeSecondProjectResponse()],
      });
    const { wrapper } = createSuspenseWrapper();

    await renderNewManagerDialog({ wrapper });

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
      expectProviderModelTitle(["Pi", "Claude Opus 4.7"]);
    });

    await waitForCreateButtonReady();
    fireEvent.click(getCreateButton());

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
    expect(
      await screen.findByText(
        `Thread route: /projects/${managerThread.projectId}/threads/${managerThread.id}`,
      ),
    ).toBeTruthy();
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
    installNewManagerRoutes({
      modelResponsesByProvider: {
        pi: piModels,
        codex: codexModels,
      },
      systemProviders: () => systemProviders,
    });
    const { queryClient, wrapper } = createSuspenseWrapper();

    await renderNewManagerDialog({ wrapper });

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
    await refetchExecutionOptions({ queryClient, providerId: "codex" });

    await waitFor(() => {
      expectProviderModelTitle(["Pi"]);
    });

    systemProviders = createDefaultSystemProviders();
    await refetchExecutionOptions({ queryClient, providerId: "codex" });

    await waitFor(() => {
      expectProviderModelTitle(["Pi"]);
    });

    await refetchExecutionOptions({ queryClient, providerId: "pi" });

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
      installNewManagerRoutes({
        modelResponsesByProvider: {
          pi: piModels,
          codex: codexModels,
        },
      });
    const { queryClient, wrapper } = createSuspenseWrapper();

    await renderNewManagerDialog({ wrapper });

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

    await waitForCreateButtonReady();
    fireEvent.click(getCreateButton());

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
    expect(compactConsecutiveProviderRequests(requestedModelProviders)).toEqual(
      ["pi", "codex"],
    );
    expect(
      queryClient.getQueryData(
        systemExecutionOptionsQueryKey({
          environmentId: null,
          providerId: "codex",
        }),
      ),
    ).toEqual({
      providers: createDefaultSystemProviders(),
      models: codexModels,
    });
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
    installNewManagerRoutes({
      modelResponsesByProvider,
    });
    const { queryClient, wrapper } = createSuspenseWrapper();

    await renderNewManagerDialog({ wrapper });

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

    await refetchExecutionOptions({ queryClient, providerId: "pi" });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reasoning" }).title).toContain(
        "Medium",
      );
    });
  });
});
