// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { Environment, Thread } from "@bb/domain";
import type { EnvironmentDisplayHostContext } from "@bb/core-ui";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import { systemEnvironmentProvidersQueryKey } from "@/hooks/queries/environment-provider-queries";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeEnvironment,
  makeThread as makeThreadFixture,
} from "@bb/test-helpers/domain-fixtures";
import {
  EnvironmentProvisioningFailureRow,
  EnvironmentRow,
  GitStatusRow,
  ThreadMetadataCard,
} from "./ThreadMetadataContent";

const localHost = { locality: "local", identity: null } as const;
const connectedLocalHost: EnvironmentDisplayHostContext = {
  locality: "local",
  identity: { name: "Michael-M4", connected: true },
};

function withQueryClient(
  children: ReactNode,
  registeredProviders?: readonly SystemEnvironmentProvider[],
): ReactNode {
  const queryClient = new QueryClient();
  if (registeredProviders !== undefined) {
    queryClient.setQueryData(
      systemEnvironmentProvidersQueryKey({}),
      registeredProviders,
    );
  }
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const worktreeProvider: SystemEnvironmentProvider = {
  id: "git-worktree",
  displayName: "Worktree",
  icon: "GitBranch",
  logoUrl: null,
  pluginId: "environment-git-worktree",
  acceptsEmptyInputs: true,
  availability: null,
  requires: {
    projectCheckout: true,
    gitCheckout: true,
    gitRemote: false,
    projectless: false,
  },
  inputs: null,
};

const modalProvider: SystemEnvironmentProvider = {
  id: "modal-sandbox",
  displayName: "Modal sandbox",
  icon: "Cloud",
  logoUrl: null,
  pluginId: "environment-modal-sandbox",
  acceptsEmptyInputs: true,
  availability: null,
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: true,
    projectless: false,
  },
  inputs: null,
};

const personalProvider: SystemEnvironmentProvider = {
  id: "personal-workspace",
  displayName: "Personal workspace",
  icon: "Folder",
  logoUrl: null,
  pluginId: "environment-personal-workspace",
  acceptsEmptyInputs: true,
  availability: null,
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: false,
    projectless: true,
  },
  inputs: null,
};

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    title: null,
    titleFallback: null,
    lastReadAt: null,
    latestAttentionAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function renderEnvironmentRow(
  environment: Environment,
  registeredProviders?: readonly SystemEnvironmentProvider[],
  environmentDisplayHost: EnvironmentDisplayHostContext = localHost,
): string {
  return renderToStaticMarkup(
    withQueryClient(
      <TooltipProvider>
        <MemoryRouter>
          <EnvironmentRow
            thread={makeThread({ environmentId: environment.id })}
            environment={environment}
            environmentDisplayHost={environmentDisplayHost}
          />
        </MemoryRouter>
      </TooltipProvider>,
      registeredProviders,
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ThreadMetadataCard", () => {
  it("shows its scrollbar only during active scrolling", () => {
    vi.useFakeTimers();
    const { container } = render(
      <ThreadMetadataCard>
        <div>Thread information</div>
      </ThreadMetadataCard>,
    );
    const scrollArea = container.querySelector("dl");
    if (!(scrollArea instanceof HTMLElement)) {
      throw new Error("missing info scroll area");
    }

    expect(scrollArea.classList).toContain("transient-scrollbar");
    expect(scrollArea.hasAttribute("data-scrollbar-scrolling")).toBe(false);

    fireEvent.scroll(scrollArea);
    expect(scrollArea.dataset.scrollbarScrolling).toBe("true");

    act(() => vi.advanceTimersByTime(599));
    expect(scrollArea.dataset.scrollbarScrolling).toBe("true");

    act(() => vi.advanceTimersByTime(1));
    expect(scrollArea.hasAttribute("data-scrollbar-scrolling")).toBe(false);
  });
});

describe("EnvironmentRow", () => {
  it("shows an unregistered provider id as not installed", () => {
    const markup = renderEnvironmentRow(
      makeEnvironment({ environmentProviderId: "retired-cloud" }),
      [],
      connectedLocalHost,
    );

    expect(markup).toContain("retired-cloud (not installed)");
  });

  it("shows the create-thread action for a ready environment", () => {
    expect(renderEnvironmentRow(makeEnvironment())).toContain(
      'aria-label="New thread in this environment"',
    );
  });

  it("explains the create-thread action in a tooltip", async () => {
    render(
      withQueryClient(
        <TooltipProvider delayDuration={0}>
          <MemoryRouter>
            <EnvironmentRow
              thread={makeThread()}
              environment={makeEnvironment()}
              environmentDisplayHost={localHost}
            />
          </MemoryRouter>
        </TooltipProvider>,
      ),
    );

    fireEvent.focus(
      screen.getByRole("button", {
        name: "New thread in this environment",
      }),
    );

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "New thread in this environment",
    );
  });

  it("hides the create-thread action while an environment is provisioning", () => {
    const markup = renderEnvironmentRow(
      makeEnvironment({
        status: "provisioning",
        path: null,
      }),
    );

    expect(markup).not.toContain('aria-label="New thread in this environment"');
  });

  it("hides the create-thread action before an environment has a path", () => {
    const markup = renderEnvironmentRow(
      makeEnvironment({
        path: null,
      }),
    );

    expect(markup).not.toContain('aria-label="New thread in this environment"');
  });

  it("offers the create-thread action on a project's own checkout", () => {
    const markup = renderEnvironmentRow(
      makeEnvironment({ environmentProviderId: null }),
    );

    expect(markup).toContain('aria-label="New thread in this environment"');
  });

  it("shows a custom provider label with its machine", () => {
    const markup = renderEnvironmentRow(
      makeEnvironment({ environmentProviderId: "modal-sandbox" }),
      [modalProvider],
      connectedLocalHost,
    );

    expect(markup).toContain("Modal sandbox");
    expect(markup).toContain("Michael-M4");
  });

  it("shows a personal environment with the project folder icon and machine", () => {
    const markup = renderEnvironmentRow(
      makeEnvironment({
        environmentProviderId: "personal-workspace",
      }),
      [personalProvider],
      connectedLocalHost,
    );

    expect(markup).toContain(">Personal workspace<");
    expect(markup).toContain("· Michael-M4");
    expect(markup).toContain('data-icon="Folder"');
  });

  it("shows an explicit environment name before its machine", () => {
    const markup = renderEnvironmentRow(
      makeEnvironment({ name: "Design system polish" }),
      [worktreeProvider],
      connectedLocalHost,
    );

    expect(markup).toContain("Design system polish");
    expect(markup).toContain("· Michael-M4");
    expect(markup).not.toContain("· Worktree");
  });

  it("shows no provider id while the registered provider list is still loading", () => {
    const markup = renderEnvironmentRow(
      makeEnvironment({ environmentProviderId: "modal-sandbox" }),
    );

    expect(markup).not.toContain("modal-sandbox");
  });
});

describe("EnvironmentProvisioningFailureRow", () => {
  it("shows a short provisioning status without the failure detail", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentProvisioningFailureRow failed />,
    );

    expect(markup).toContain("Environment");
    expect(markup).toContain("Not created");
    expect(markup).toContain("provisioning failed");
  });
});

describe("GitStatusRow", () => {
  it("shows no live git status for an archived attached checkout", () => {
    const markup = renderToStaticMarkup(
      <GitStatusRow
        thread={makeThread({ archivedAt: 10, environmentId: "env_checkout" })}
        environment={makeEnvironment({
          id: "env_checkout",
          environmentProviderId: "project-checkout",
          managed: false,
        })}
        workspaceStatus={undefined}
        workspaceStatusError={new Error("should not have queried")}
        selectedMergeBaseBranch={undefined}
      />,
    );

    expect(markup).toBe("");
  });
});
