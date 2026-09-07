// @vitest-environment jsdom

import type { ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { focusManager } from "@tanstack/react-query";
import type { ProviderInfo } from "@bb/domain";
import type { SkillSummary } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import { sdk } from "@/lib/sdk";
import {
  buildRegistrySkillReferencePrompt,
  type RegistrySkill,
} from "@/lib/skills-registry";
import { SkillDetailView } from "../components/tools/SkillDetailView";
import {
  RegistrySkillDetailView,
  RegistrySkillsBrowsePage,
} from "../components/tools/SkillsBrowse";
import {
  SkillDetailDialogView,
  SkillsOverview,
} from "../components/tools/SkillsCollection";
import { SkillsLibrary } from "../components/tools/SkillsLibrary";

afterEach(() => {
  focusManager.setFocused(undefined);
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeSkill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: `skill_${"a".repeat(64)}`,
    name: "code-review",
    description: "Review the current diff.",
    provider: "claude-code",
    scope: "provider-user",
    pluginId: null,
    filePath: "/home/u/.claude/skills/code-review/SKILL.md",
    manageable: true,
    registrySkillId: null,
    ...overrides,
  };
}

function makeRegistrySkill(
  overrides: Partial<RegistrySkill> = {},
): RegistrySkill {
  return {
    id: "owner/repo/useful-skill",
    source: "owner/repo",
    skillId: "useful-skill",
    name: "Useful skill",
    installs: 100,
    stars: 20,
    installUrl: null,
    url: "https://skills.sh/owner/repo/useful-skill",
    topic: "Development",
    summary: "A useful skill.",
    ...overrides,
  };
}

function requestPath(input: RequestInfo | URL): string {
  const url = new URL(String(input), window.location.origin);
  return `${url.pathname}${url.search}`;
}

function LocationStateProbe() {
  const location = useLocation();
  return (
    <output data-testid="location-state">
      {JSON.stringify(location.state)}
    </output>
  );
}

function renderLibrarySkillRoute() {
  vi.spyOn(sdk.providers, "list").mockResolvedValue([]);
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          skills: [],
          pagination: { page: 0, perPage: 24, total: 0, hasMore: false },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
  renderDom(
    <MemoryRouter initialEntries={["/extensions/skills/library/skill_missing"]}>
      <QueryClientWrapper>
        <Routes>
          <Route
            path="/extensions/skills/library/:skillId"
            element={<SkillsLibrary />}
          />
        </Routes>
      </QueryClientWrapper>
    </MemoryRouter>,
  );
  return fetchMock;
}

const NO_PROVIDER_ROSTER: ReadonlyMap<string, ProviderInfo> = new Map();
const DEFAULT_PROVIDER_ROSTER: ReadonlyMap<string, ProviderInfo> = new Map(
  [
    makeProviderInfo({ id: "codex", displayName: "Codex" }),
    makeProviderInfo({ id: "claude-code", displayName: "Claude Code" }),
    makeProviderInfo({ id: "acp-cursor", displayName: "Cursor" }),
  ].map((provider) => [provider.id, provider]),
);

function render(props: Partial<Parameters<typeof SkillsOverview>[0]>): string {
  return renderToStaticMarkup(
    <SkillsOverview
      providerRoster={props.providerRoster ?? DEFAULT_PROVIDER_ROSTER}
      skills={props.skills ?? []}
      isLoading={props.isLoading ?? false}
      hasError={props.hasError ?? false}
      onCreateSkill={props.onCreateSkill ?? (() => {})}
      onSelectSkill={props.onSelectSkill ?? (() => {})}
      onRetry={props.onRetry}
    />,
  );
}

function renderSkillDetailDialog(
  skill: SkillSummary,
  overrides: Partial<ComponentProps<typeof SkillDetailDialogView>> = {},
) {
  return renderDom(
    <SkillDetailDialogView
      skill={skill}
      providerRoster={DEFAULT_PROVIDER_ROSTER}
      files={["SKILL.md"]}
      selectedPath="SKILL.md"
      onSelectPath={() => {}}
      content={`# ${skill.name}`}
      isLoadingContent={false}
      isContentError={false}
      canEdit={false}
      canDelete={false}
      canOpenInEditor={false}
      isDeleting={false}
      onEdit={() => {}}
      onRetry={() => {}}
      onDelete={() => {}}
      onOpenInEditor={() => {}}
      {...overrides}
    />,
  );
}

function renderRegistryBrowse(
  overrides: Partial<ComponentProps<typeof RegistrySkillsBrowsePage>> = {},
) {
  return renderDom(
    <RegistrySkillsBrowsePage
      skills={[makeRegistrySkill()]}
      pendingSkillIds={new Set()}
      unknownInstallSkillIds={new Set()}
      isLoading={false}
      loadingMore={false}
      hasMore={false}
      hasError={false}
      query=""
      onQueryChange={() => {}}
      onLoadMore={() => {}}
      onFork={() => {}}
      onSelect={() => {}}
      {...overrides}
    />,
  );
}

function stubRegistryFetch(
  registrySkill: RegistrySkill,
  options: {
    detail?: boolean;
    list?: boolean;
    entry?: RegistrySkill;
    entryFails?: boolean;
    ranking?: "trending" | "all-time";
  } = {},
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = requestPath(input);
    if (url.startsWith("/api/v1/skills-registry?")) {
      return new Response(
        JSON.stringify({
          skills: options.list ? [registrySkill] : [],
          pagination: {
            page: 0,
            perPage: 24,
            total: options.list ? 1 : 0,
            hasMore: false,
          },
          ranking: options.ranking ?? "trending",
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("/api/v1/skills-registry/entry?")) {
      if (options.entryFails) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(options.entry ?? registrySkill), {
        status: 200,
      });
    }
    if (url === "/api/v1/skills-registry/entries") {
      return Response.json({
        entries: options.entryFails ? [] : [options.entry ?? registrySkill],
      });
    }
    if (
      url.startsWith("/api/v1/skills-registry/detail?") &&
      options.detail !== false
    ) {
      return new Response(
        JSON.stringify({
          id: registrySkill.id,
          source: registrySkill.source,
          skillId: registrySkill.skillId,
          hash: null,
          files: [{ path: "SKILL.md", contents: "# Useful skill" }],
        }),
        { status: 200 },
      );
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderRegistrySkillRoute() {
  const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
  return renderDom(
    <MemoryRouter
      initialEntries={[
        "/extensions/skills/registry/owner%2Frepo%2Fuseful-skill",
      ]}
    >
      <QueryClientWrapper>
        <Routes>
          <Route
            path="/extensions/skills/registry/:registrySkillId"
            element={<SkillsLibrary />}
          />
        </Routes>
      </QueryClientWrapper>
    </MemoryRouter>,
  );
}

function NavigateButton({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      {label}
    </button>
  );
}

describe("SkillsOverview", () => {
  it("defaults to BB skills and places BB Official skills first", () => {
    const markup = render({
      skills: [
        makeSkill({ name: "claude-skill", provider: "claude-code" }),
        makeSkill({
          name: "aa-user-skill",
          provider: null,
          scope: "bb-user",
        }),
        makeSkill({
          name: "zz-official-skill",
          provider: null,
          scope: "bb-builtin",
          manageable: false,
        }),
      ],
    });
    expect(markup).not.toContain("claude-skill");
    expect(markup).toContain("Review the current diff.");
    expect(markup).toContain('aria-label="Filters: Provider: bb"');
    expect(markup).not.toContain("Provider: 1 selected");
    expect(markup).toContain("Sort");
    expect(markup).not.toContain('role="tab"');
    expect(markup).toContain("BB Official");
    expect(markup).toContain("New bb skill");
    expect(markup).not.toContain('aria-label="Open zz-official-skill"');
    expect(markup.indexOf("zz-official-skill")).toBeLessThan(
      markup.indexOf("aa-user-skill"),
    );
  });

  it("labels the Type filter and preserves independent source toggles", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "official-skill",
            provider: null,
            scope: "bb-builtin",
            manageable: false,
          }),
          makeSkill({
            name: "automations",
            provider: null,
            scope: "plugin",
            pluginId: "automations",
            manageable: false,
          }),
          makeSkill({
            name: "user-skill",
            provider: null,
            scope: "bb-user",
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    expect(screen.getByText("official-skill")).toBeTruthy();
    expect(screen.getByText("user-skill")).toBeTruthy();
    expect(screen.getByText("automations")).toBeTruthy();
    const typeTrigger = screen.getByRole("button", { name: /^Filters/ });
    fireEvent.focus(typeTrigger);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Provider: bb",
    );
    fireEvent.blur(typeTrigger);
    fireEvent.pointerDown(typeTrigger);
    expect(screen.getByText("Type")).toBeTruthy();
    expect(screen.queryByRole("menuitemcheckbox", { name: "All" })).toBeNull();
    for (const name of ["BB Official", "Included in plugin", "User"]) {
      expect(
        screen
          .getByRole("menuitemcheckbox", { name })
          .getAttribute("aria-checked"),
      ).toBe("false");
    }
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Included in plugin" }),
    );

    expect(await screen.findByText("automations")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "automations is included with Automations (bb plugin)",
      ).textContent,
    ).toBe("Included");
    expect(screen.queryByText("official-skill")).toBeNull();
    expect(screen.queryByText("user-skill")).toBeNull();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));
    expect(await screen.findByText("user-skill")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Included in plugin" }),
    );
    expect(await screen.findByText("official-skill")).toBeTruthy();
    expect(screen.getByText("automations")).toBeTruthy();
  });

  it("puts every non-builtin, non-plugin scope in the User bucket", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={DEFAULT_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "claude-authored",
            provider: "claude-code",
            scope: "provider-user",
          }),
          makeSkill({
            name: "codex-authored",
            provider: "codex",
            scope: "provider-project",
          }),
          makeSkill({
            name: "official-skill",
            provider: null,
            scope: "bb-builtin",
            manageable: false,
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Filters/ });
    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "bb" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));

    expect(await screen.findByText("claude-authored")).toBeTruthy();
    expect(screen.getByText("codex-authored")).toBeTruthy();
    expect(screen.queryByText("official-skill")).toBeNull();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Claude Code" }),
    );
    expect(await screen.findByText("claude-authored")).toBeTruthy();
    expect(screen.queryByText("codex-authored")).toBeNull();
    expect(screen.queryByText("official-skill")).toBeNull();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));
    expect(await screen.findByText("claude-authored")).toBeTruthy();
    expect(screen.queryByText("codex-authored")).toBeNull();
  });

  it("toggles BB Official independently from Included in plugin", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "official-skill",
            provider: null,
            scope: "bb-builtin",
            manageable: false,
          }),
          makeSkill({
            name: "automations",
            provider: null,
            scope: "plugin",
            pluginId: "automations",
            manageable: false,
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Included in plugin" }),
    );

    expect(await screen.findByText("automations")).toBeTruthy();
    expect(screen.queryByText("official-skill")).toBeNull();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "BB Official" }),
    );
    expect(await screen.findByText("official-skill")).toBeTruthy();
    expect(screen.getByText("automations")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Included in plugin" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "BB Official" }),
    );
    expect(await screen.findByText("official-skill")).toBeTruthy();
    expect(screen.getByText("automations")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: /^Filters/ })).toBeTruthy();
  });

  it("uses filter-neutral copy when a Type selection removes every skill", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "official-skill",
            provider: null,
            scope: "bb-builtin",
            manageable: false,
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Included in plugin" }),
    );

    expect(
      await screen.findByText("No skills match these filters."),
    ).toBeTruthy();
    expect(screen.queryByText("No skills match these providers.")).toBeNull();
  });

  it("renders browse content as the active full-page collection mode", () => {
    const registrySkill = makeRegistrySkill({ installs: 123_456, stars: 654 });
    const markup = renderToStaticMarkup(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[]}
        isLoading={false}
        hasError={false}
        activeMode="browse"
        browseContent={
          <RegistrySkillsBrowsePage
            skills={[registrySkill]}
            pendingSkillIds={new Set()}
            unknownInstallSkillIds={new Set()}
            isLoading={false}
            loadingMore={false}
            hasMore={false}
            hasError={false}
            query=""
            onQueryChange={() => {}}
            onLoadMore={() => {}}
            onFork={() => {}}
            onSelect={() => {}}
          />
        }
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    expect(markup).toContain("Useful skill");
  });

  it("names custom ACP agents from the provider roster", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={
          new Map([
            [
              "acp-foo",
              makeProviderInfo({ id: "acp-foo", displayName: "Foo Agent" }),
            ],
            [
              "acp-bar",
              makeProviderInfo({ id: "acp-bar", displayName: "Bar Agent" }),
            ],
          ])
        }
        skills={[
          makeSkill({
            name: "foo-skill",
            description: null,
            provider: "acp-foo",
            scope: "provider-user",
          }),
          makeSkill({
            name: "bar-skill",
            description: null,
            provider: "acp-bar",
            scope: "provider-user",
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));

    await waitFor(() => {
      expect(
        screen.getByRole("menuitemcheckbox", { name: "Foo Agent" }),
      ).not.toBeNull();
    });
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Bar Agent" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "ACP provider" }),
    ).toBeNull();
  });

  it("lists a provider filter only for providers present in the skills", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={DEFAULT_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "codex-skill",
            provider: "codex",
            scope: "provider-user",
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));

    await waitFor(() => {
      expect(
        screen.getByRole("menuitemcheckbox", { name: "Codex" }),
      ).not.toBeNull();
    });
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Claude Code" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Codex" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Codex" })
        .querySelector("[data-provider-logo]"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "bb" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("labels the Provider filter and prefixes its logo tooltip", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "bb-skill",
            provider: null,
            scope: "bb-user",
          }),
          makeSkill({ name: "claude-skill", provider: "claude-code" }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    const providerTrigger = screen.getByRole("button", { name: /^Filters/ });
    fireEvent.focus(providerTrigger);
    expect((await screen.findByRole("tooltip")).textContent?.trim()).toBe(
      "Provider: bb",
    );
    fireEvent.blur(providerTrigger);

    fireEvent.pointerDown(providerTrigger);
    expect(screen.getByText("Provider")).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "bb" }).querySelector("img"),
    ).not.toBeNull();
  });

  it("keeps the default BB filter selected when only provider skills exist", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "codex-skill",
            provider: "codex",
            scope: "provider-user",
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Filters/ })).toBeTruthy();
      expect(screen.queryByText("codex-skill")).toBeNull();
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));
    const bbFilter = screen.getByRole("menuitemcheckbox", { name: "bb" });
    expect(bbFilter.getAttribute("aria-checked")).toBe("true");
    expect(bbFilter.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(bbFilter);

    expect(await screen.findByText("codex-skill")).toBeTruthy();
  });

  it("preserves a user-selected provider filter across library refreshes", async () => {
    const initialSkills = [
      makeSkill({
        id: `skill_${"b".repeat(64)}`,
        name: "bb-skill",
        provider: null,
        scope: "bb-user",
      }),
      makeSkill({ name: "claude-skill", provider: "claude-code" }),
    ];
    const view = renderDom(
      <SkillsOverview
        providerRoster={DEFAULT_PROVIDER_ROSTER}
        skills={initialSkills}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "bb" }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Claude Code" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.getByText("claude-skill")).toBeTruthy();
      expect(screen.queryByText("bb-skill")).toBeNull();
      expect(
        screen.getByRole("button", { name: /Provider: Claude Code/ }),
      ).toBeTruthy();
    });

    view.rerender(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          ...initialSkills,
          makeSkill({
            id: `skill_${"c".repeat(64)}`,
            name: "new-bb-skill",
            provider: null,
            scope: "bb-user",
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    expect(screen.getByText("claude-skill")).toBeTruthy();
    expect(screen.queryByText("new-bb-skill")).toBeNull();
  });

  it("keeps edit and delete actions in detail rather than overview rows", () => {
    const markup = render({
      skills: [
        makeSkill({
          name: "bb-skill",
          provider: null,
          scope: "bb-user",
          manageable: true,
        }),
        makeSkill({ name: "provider-skill" }),
      ],
    });
    expect(markup).not.toContain('aria-label="Edit bb-skill"');
    expect(markup).not.toContain('aria-label="Delete bb-skill"');
    expect(markup).not.toContain('aria-label="Edit provider-skill"');
    expect(markup).not.toContain('aria-label="Delete provider-skill"');
  });

  it("waits for hover intent before warming a row's detail queries", () => {
    vi.useFakeTimers();
    try {
      const onPrefetchSkill = vi.fn();
      renderDom(
        <SkillsOverview
          providerRoster={NO_PROVIDER_ROSTER}
          skills={[makeSkill({ provider: null, scope: "bb-user" })]}
          isLoading={false}
          hasError={false}
          onCreateSkill={() => {}}
          onSelectSkill={() => {}}
          onPrefetchSkill={onPrefetchSkill}
        />,
      );
      const row = screen.getByRole("button", { name: "code-review" });
      fireEvent.focus(row);
      vi.advanceTimersByTime(100);
      fireEvent.blur(row);
      vi.advanceTimersByTime(1_000);
      expect(onPrefetchSkill).not.toHaveBeenCalled();

      fireEvent.focus(row);
      vi.advanceTimersByTime(150);
      expect(onPrefetchSkill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a loading skeleton", () => {
    const markup = render({ skills: [], isLoading: true });
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading skills");
    expect(markup).not.toContain("Start from an example");
  });

  it("shows a recoverable error state with a retry", () => {
    const markup = render({ skills: [], hasError: true, onRetry: () => {} });
    expect(markup).toContain("load skills.");
    expect(markup).toContain("Retry");
    expect(markup).toContain('role="alert"');
  });
});

describe("SkillsLibrary library detail routing", () => {
  it("keeps a detail loading state while the skill library resolves", () => {
    vi.spyOn(sdk.skills, "list").mockImplementation(
      () => new Promise(() => {}),
    );

    renderLibrarySkillRoute();

    expect(screen.getByText("Loading skill")).toBeTruthy();
    expect(screen.queryByText("New bb skill")).toBeNull();
  });

  it("shows a retryable detail error when the skill library fails to load", async () => {
    vi.spyOn(sdk.skills, "list").mockRejectedValue(
      new Error("skills unavailable"),
    );

    renderLibrarySkillRoute();

    expect(await screen.findByText("Couldn't load skill.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("New bb skill")).toBeNull();
  });

  it("shows not found on an unknown library skill detail route", async () => {
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });

    const fetchMock = renderLibrarySkillRoute();

    const notFound = await screen.findByText("Skill not found.");
    expect(notFound.closest("[data-resource-detail-state]")).not.toBeNull();
    expect(screen.queryByText("New bb skill")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SkillsLibrary registry detail lifecycle", () => {
  it("does not offer installation when a direct registry source is unavailable", async () => {
    const registrySkill = makeRegistrySkill();
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });
    stubRegistryFetch(registrySkill, { detail: false });
    renderRegistrySkillRoute();

    expect(
      await screen.findByText(
        "This registry skill is no longer available from its source.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Fork Useful skill/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Fork Useful skill/,
      }),
    ).toBeNull();
  });

  it("opens on Browse before Library and can start a skill from the registry", async () => {
    const registrySkill = makeRegistrySkill();
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });
    const fetchMock = stubRegistryFetch(registrySkill, { list: true });
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    renderDom(
      <MemoryRouter initialEntries={["/extensions/skills"]}>
        <QueryClientWrapper>
          <Routes>
            <Route path="/extensions/skills" element={<SkillsLibrary />} />
            <Route path="/" element={<LocationStateProbe />} />
          </Routes>
          <NavigateButton
            to="/extensions/skills?view=library"
            label="go-library"
          />
          <NavigateButton to="/extensions/skills" label="go-browse" />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    let forkButton = await screen.findByRole("button", {
      name: "Fork Useful skill into a new bb skill",
    });
    expect(screen.queryByRole("tab")).toBeNull();
    const registryListRequests = () =>
      fetchMock.mock.calls.filter(([input]) =>
        requestPath(input).startsWith("/api/v1/skills-registry?"),
      );
    expect(registryListRequests()).toHaveLength(1);

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(registryListRequests()).toHaveLength(1));

    fireEvent.click(screen.getByText("go-library"));
    expect(
      await screen.findByRole("textbox", { name: "Search skills" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("go-browse"));
    forkButton = await screen.findByRole("button", {
      name: "Fork Useful skill into a new bb skill",
    });
    expect(registryListRequests()).toHaveLength(1);

    fireEvent.click(forkButton);

    const state = JSON.parse(
      (await screen.findByTestId("location-state")).textContent ?? "null",
    );
    expect(state).toEqual({
      focusPrompt: true,
      initialPrompt: buildRegistrySkillReferencePrompt(registrySkill),
      replaceInitialPrompt: true,
      createDraftKind: "skill",
    });
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input) === "/api/v1/skills-registry/install",
      ),
    ).toBe(false);
  });

  it("shows the lifetime install count, not the trending window the list ranks by", async () => {
    const trendingEntry = makeRegistrySkill({ installs: 42, summary: null });
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });
    stubRegistryFetch(trendingEntry, {
      list: true,
      entry: makeRegistrySkill({ installs: 9_000 }),
    });
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    renderDom(
      <MemoryRouter initialEntries={["/extensions/skills?view=browse"]}>
        <QueryClientWrapper>
          <Routes>
            <Route path="/extensions/skills" element={<SkillsLibrary />} />
          </Routes>
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText("9.0K installs")).toBeTruthy();
    expect(screen.queryByLabelText("42 installs")).toBeNull();
  });

  it("shows no install count rather than the window count when the entry lookup fails", async () => {
    const trendingEntry = makeRegistrySkill({ installs: 42, summary: null });
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });
    stubRegistryFetch(trendingEntry, { list: true, entryFails: true });
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    renderDom(
      <MemoryRouter initialEntries={["/extensions/skills?view=browse"]}>
        <QueryClientWrapper>
          <Routes>
            <Route path="/extensions/skills" element={<SkillsLibrary />} />
          </Routes>
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", {
        name: "View details for Useful skill",
      }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("42 installs")).toBeNull();
    expect(screen.queryByLabelText(/installs$/)).toBeNull();
  });

  it("keeps the enriched star count when the entry supplies the install total", async () => {
    const listed = makeRegistrySkill({
      installs: 42,
      summary: null,
      stars: null,
    });
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestPath(input);
      if (url.startsWith("/api/v1/skills-registry?")) {
        return Response.json({
          skills: [listed],
          pagination: { page: 0, perPage: 24, total: 1, hasMore: false },
          ranking: "trending",
        });
      }
      if (url === "/api/v1/skills-registry/entries") {
        return Response.json({
          entries: [makeRegistrySkill({ installs: 9_000 })],
        });
      }
      if (url.startsWith("/api/v1/skills-registry/repository-stars?")) {
        return Response.json({ stars: 654 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    renderDom(
      <MemoryRouter initialEntries={["/extensions/skills?view=browse"]}>
        <QueryClientWrapper>
          <Routes>
            <Route path="/extensions/skills" element={<SkillsLibrary />} />
          </Routes>
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText("9.0K installs")).toBeTruthy();
    expect(await screen.findByLabelText("654 stars")).toBeTruthy();
  });

  it("reveals registry cards only after repository stars finish loading", async () => {
    const firstSkill = makeRegistrySkill({
      id: "owner/shared-repo/first-skill",
      source: "owner/shared-repo",
      skillId: "first-skill",
      name: "First skill",
      stars: null,
    });
    const secondSkill = makeRegistrySkill({
      id: "owner/shared-repo/second-skill",
      source: "owner/shared-repo",
      skillId: "second-skill",
      name: "Second skill",
      stars: null,
    });
    let resolveStars: ((response: Response) => void) | undefined;
    const starsResponse = new Promise<Response>((resolve) => {
      resolveStars = resolve;
    });
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestPath(input);
      if (url.startsWith("/api/v1/skills-registry?")) {
        return Promise.resolve(
          Response.json({
            skills: [firstSkill, secondSkill],
            pagination: {
              page: 0,
              perPage: 24,
              total: 2,
              hasMore: false,
            },
            ranking: "trending",
          }),
        );
      }
      if (
        url ===
        "/api/v1/skills-registry/repository-stars?source=owner%2Fshared-repo"
      ) {
        return starsResponse;
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    renderDom(
      <MemoryRouter initialEntries={["/extensions/skills?view=browse"]}>
        <QueryClientWrapper>
          <Routes>
            <Route path="/extensions/skills" element={<SkillsLibrary />} />
          </Routes>
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) =>
            requestPath(input) ===
            "/api/v1/skills-registry/repository-stars?source=owner%2Fshared-repo",
        ),
      ).toHaveLength(1);
    });
    expect(screen.queryByText("First skill")).toBeNull();
    expect(screen.queryByText("Second skill")).toBeNull();
    expect(
      screen.getByRole("status", { name: "Loading First skill" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Loading Second skill" }),
    ).toBeTruthy();

    resolveStars?.(Response.json({ stars: 27_053 }));

    expect(await screen.findByText("First skill")).toBeTruthy();
    expect(screen.getByText("Second skill")).toBeTruthy();
    expect(await screen.findAllByLabelText("27.1K stars")).toHaveLength(2);
  });

  it("resolves every card's entry through one batch request", async () => {
    const firstSkill = makeRegistrySkill({
      id: "owner/repo/first-skill",
      skillId: "first-skill",
      name: "First skill",
      summary: null,
    });
    const secondSkill = makeRegistrySkill({
      id: "owner/repo/second-skill",
      skillId: "second-skill",
      name: "Second skill",
      summary: null,
    });
    let resolveEntries: ((response: Response) => void) | undefined;
    const entriesResponse = new Promise<Response>((resolve) => {
      resolveEntries = resolve;
    });
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestPath(input);
      if (url.startsWith("/api/v1/skills-registry?")) {
        return Promise.resolve(
          Response.json({
            skills: [firstSkill, secondSkill],
            pagination: {
              page: 0,
              perPage: 24,
              total: 2,
              hasMore: false,
            },
            ranking: "trending",
          }),
        );
      }
      if (url === "/api/v1/skills-registry/entries") {
        return entriesResponse;
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    renderDom(
      <MemoryRouter initialEntries={["/extensions/skills?view=browse"]}>
        <QueryClientWrapper>
          <Routes>
            <Route path="/extensions/skills" element={<SkillsLibrary />} />
          </Routes>
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestPath(input) === "/api/v1/skills-registry/entries",
        ),
      ).toHaveLength(1);
    });
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        requestPath(input).startsWith("/api/v1/skills-registry/entry?"),
      ),
    ).toHaveLength(0);
    expect(screen.queryByText("First skill")).toBeNull();
    expect(
      screen.getByRole("status", { name: "Loading Second skill" }),
    ).toBeTruthy();

    resolveEntries?.(
      Response.json({
        entries: [
          { ...firstSkill, summary: "First description" },
          { ...secondSkill, summary: "Second description" },
        ],
      }),
    );

    expect(await screen.findByText("First skill")).toBeTruthy();
    expect(screen.getByText("First description")).toBeTruthy();
    expect(screen.getByText("Second skill")).toBeTruthy();
    expect(screen.getByText("Second description")).toBeTruthy();
  });
});

describe("RegistrySkillsBrowsePage", () => {
  it("uses the shared error state and retry action", () => {
    const onRetry = vi.fn();
    renderRegistryBrowse({
      skills: [],
      hasError: true,
      onRetry,
    });

    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't load skills.sh.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders the authoritative page order, exposes social proof, and loads more on scroll", () => {
    const alpha = makeRegistrySkill({
      id: "owner/repo/alpha",
      skillId: "alpha",
      name: "Alpha",
      installs: 10,
      stars: 100,
    });
    const zulu = makeRegistrySkill({
      id: "owner/repo/zulu",
      skillId: "zulu",
      name: "Zulu",
      installs: 20,
      stars: 10,
    });
    const onSelect = vi.fn();
    const onFork = vi.fn();
    const { container } = renderRegistryBrowse({
      skills: [alpha, zulu],
      hasMore: true,
      onFork,
      onSelect,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "View details for Alpha" }),
    );
    expect(onSelect).toHaveBeenCalledWith(alpha);
    expect(screen.getByRole("textbox", { name: "Search skills" })).toBeTruthy();
    expect(screen.getByLabelText("10 installs")).toBeTruthy();
    expect(screen.getAllByText("by owner/repo").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", {
        name: "Fork Alpha into a new bb skill",
      }).textContent,
    ).toBe("");
    const zuluCreate = screen.getByRole("button", {
      name: "Fork Zulu into a new bb skill",
    });
    fireEvent.click(zuluCreate);
    expect(onFork).toHaveBeenCalledWith(zulu);
    expect(screen.queryByRole("button", { name: /Save .* to bb/ })).toBeNull();

    expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
    const alphaTitle = screen.getByText("Alpha");
    const zuluTitle = screen.getByText("Zulu");
    expect(
      alphaTitle.compareDocumentPosition(zuluTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      container.querySelector("[data-resource-infinite-sentinel]"),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("keeps the list's own count on the all-time ranking", async () => {
    const listed = makeRegistrySkill({ installs: 42, summary: null });
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });
    stubRegistryFetch(listed, {
      list: true,
      ranking: "all-time",
      entry: makeRegistrySkill({ installs: 9_000 }),
    });
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    renderDom(
      <MemoryRouter initialEntries={["/extensions/skills?view=browse"]}>
        <QueryClientWrapper>
          <Routes>
            <Route path="/extensions/skills" element={<SkillsLibrary />} />
          </Routes>
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText("42 installs")).toBeTruthy();
    expect(screen.queryByLabelText("9.0K installs")).toBeNull();
  });
});

function stubIntersectionObserver() {
  const callbacks: IntersectionObserverCallback[] = [];
  class StubIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  return () => {
    for (const callback of [...callbacks]) {
      callback(
        [{ isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    }
  };
}

describe("SkillsLibrary registry browse paging", () => {
  function renderBrowse() {
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    return renderDom(
      <MemoryRouter initialEntries={["/extensions/skills?view=browse"]}>
        <QueryClientWrapper>
          <Routes>
            <Route path="/extensions/skills" element={<SkillsLibrary />} />
          </Routes>
        </QueryClientWrapper>
      </MemoryRouter>,
    );
  }

  it("keeps loaded cards and offers an inline retry when a later page fails", async () => {
    const alpha = makeRegistrySkill({
      id: "owner/repo/alpha",
      skillId: "alpha",
      name: "Alpha",
    });
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestPath(input);
      if (url.startsWith("/api/v1/skills-registry?")) {
        const page = new URL(url, window.location.origin).searchParams.get(
          "page",
        );
        if (page === "0") {
          return Response.json({
            skills: [alpha],
            pagination: { page: 0, perPage: 24, total: 48, hasMore: true },
            ranking: "trending",
          });
        }
        return new Response(null, { status: 503 });
      }
      if (url === "/api/v1/skills-registry/entries") {
        return Response.json({ entries: [alpha] });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const fireSentinel = stubIntersectionObserver();
    renderBrowse();

    expect(await screen.findByText("Alpha")).toBeTruthy();
    fireSentinel();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load more from skills.sh.");
    expect(screen.getByText("Alpha")).toBeTruthy();

    const pageTwoCalls = () =>
      fetchMock.mock.calls.filter(([input]) =>
        requestPath(input).includes("page=1"),
      ).length;
    expect(pageTwoCalls()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(pageTwoCalls()).toBe(2));
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("restarts accumulation instead of mixing rankings when the server falls back", async () => {
    const alpha = makeRegistrySkill({
      id: "owner/repo/alpha",
      skillId: "alpha",
      name: "Alpha",
    });
    const bravo = makeRegistrySkill({
      id: "owner/repo/bravo",
      skillId: "bravo",
      name: "Bravo",
    });
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestPath(input);
      if (url.startsWith("/api/v1/skills-registry?")) {
        const page = new URL(url, window.location.origin).searchParams.get(
          "page",
        );
        if (page === "0") {
          return Response.json({
            skills: [alpha],
            pagination: { page: 0, perPage: 24, total: 48, hasMore: true },
            ranking: "trending",
          });
        }
        return Response.json({
          skills: [bravo],
          pagination: { page: 1, perPage: 24, total: 48, hasMore: false },
          ranking: "all-time",
        });
      }
      if (url === "/api/v1/skills-registry/entries") {
        return Response.json({ entries: [alpha, bravo] });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const fireSentinel = stubIntersectionObserver();
    renderBrowse();

    expect(await screen.findByText("Alpha")).toBeTruthy();
    fireSentinel();

    expect(await screen.findByText("Bravo")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
  });
});

describe("RegistrySkillDetailView reference creation", () => {
  it("keeps forking available whether or not a local copy exists", () => {
    const registrySkill = makeRegistrySkill();
    const onFork = vi.fn();
    const props = {
      skill: registrySkill,
      detail: {
        id: registrySkill.id,
        source: registrySkill.source,
        skillId: registrySkill.skillId,
        hash: null,
        files: [{ path: "SKILL.md", contents: "# Useful skill" }],
      },
      localSkill: null,
      localPath: null,
      onRetry: () => {},
      onFork,
      onEditLocalSkill: () => {},
    };
    const view = renderDom(<RegistrySkillDetailView {...props} />);

    const forkButton = screen.getByRole("button", {
      name: "Fork Useful skill into a new bb skill",
    });
    expect(forkButton.textContent).toContain("Fork");
    fireEvent.click(forkButton);
    expect(onFork).toHaveBeenCalledWith(registrySkill);
    expect(screen.queryByRole("button", { name: /Save .* to bb/ })).toBeNull();

    view.rerender(
      <RegistrySkillDetailView
        {...props}
        localSkill={makeSkill({
          name: registrySkill.skillId,
          provider: null,
          scope: "bb-user",
          registrySkillId: registrySkill.id,
        })}
        localPath="/home/u/.bb/skills/useful-skill/SKILL.md"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Fork Useful skill into a new bb skill",
      }),
    );
    expect(onFork).toHaveBeenCalledTimes(2);
  });
});

describe("SkillDetailDialogView", () => {
  it("presents a built-in skill as BB Official without an actions menu", async () => {
    const skill = makeSkill({
      name: "bb-cli",
      provider: null,
      scope: "bb-builtin",
      manageable: false,
    });
    renderSkillDetailDialog(skill);

    const official = screen.getByLabelText("bb-cli is BB Official");
    expect(official.textContent).toBe("BB Official");
    expect(screen.queryByRole("button", { name: "bb-cli actions" })).toBeNull();
    fireEvent.pointerMove(official);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Ships with bb",
    );
  });

  it.each([
    {
      skill: makeSkill({
        name: "documents",
        provider: "codex",
        scope: "plugin",
        pluginId: "documents",
        manageable: false,
      }),
      accessibleLabel: "documents is included with Documents (Codex plugin)",
      tooltipName: "Documents plugin.",
      providerIcon: "codex",
    },
    {
      skill: makeSkill({
        name: "plugin-notes",
        provider: null,
        scope: "plugin",
        pluginId: "skill-catalog-fixture",
        manageable: false,
      }),
      accessibleLabel:
        "plugin-notes is included with Skill catalog fixture (bb plugin)",
      tooltipName: "Skill catalog fixture plugin.",
      providerIcon: "bb",
    },
  ])("presents $skill.name as plugin-provided", async (example) => {
    renderSkillDetailDialog(example.skill);

    const included = screen.getByLabelText(example.accessibleLabel);
    expect(included.textContent).toBe("Included");
    expect(
      screen.queryByRole("button", { name: `${example.skill.name} actions` }),
    ).toBeNull();
    fireEvent.pointerMove(included);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Included with");
    expect(tooltip.textContent).toContain(example.tooltipName);
    const providerIcon = tooltip.querySelector(
      `[data-provider-icon="${example.providerIcon}"]`,
    );
    expect(providerIcon).not.toBeNull();
    expect(
      ["flex", "size-3.5", "shrink-0", "items-center", "justify-center"].every(
        (className) => providerIcon?.classList.contains(className),
      ),
    ).toBe(true);
  });

  it("labels externally discovered provider skills as imported", async () => {
    const skill = makeSkill({
      name: "code-review",
      provider: "claude-code",
      scope: "provider-user",
      manageable: true,
    });
    renderSkillDetailDialog(skill, { canEdit: true, canDelete: true });

    const imported = screen.getByLabelText(
      "code-review is imported from Claude Code",
    );
    expect(imported.textContent).toBe("Imported");
    fireEvent.pointerMove(imported);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Discovered from");
    expect(tooltip.textContent).toContain("Claude Code");
    expect(
      tooltip.querySelector('[data-provider-icon="claude-code"]'),
    ).not.toBeNull();
  });

  it("uses a hoverable copy target and delegates editing to the thread flow", () => {
    const skill = makeSkill({
      name: "bb-skill",
      provider: null,
      scope: "bb-user",
      manageable: true,
      filePath: "/home/u/.bb/skills/bb-skill/SKILL.md",
    });
    const onEdit = vi.fn();
    renderSkillDetailDialog(skill, {
      canEdit: true,
      canDelete: true,
      onEdit,
    });

    screen.getByRole("button", {
      name: "Copy skill path: /home/u/.bb/skills/bb-skill",
    });
    expect(screen.getByText("~/.bb/skills/bb-skill")).toBeTruthy();
    expect(screen.queryByText("BB Official", { exact: true })).toBeNull();
    expect(screen.queryByText("Included", { exact: true })).toBeNull();
    expect(screen.queryByText("Imported", { exact: true })).toBeNull();
    expect(screen.queryByText("Editable", { exact: true })).toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "bb-skill actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox", { name: "Edit SKILL.md" })).toBeNull();
  });
});

describe("SkillDetailView registry states", () => {
  it("links to the source and omits social proof", () => {
    renderDom(
      <SkillDetailView
        leading={<span>Skill</span>}
        title="find-skills"
        path="skills.sh/vercel-labs/skills/find-skills"
        pathHref="https://www.skills.sh/vercel-labs/skills/find-skills"
        files={["SKILL.md"]}
        selectedPath="SKILL.md"
        onSelectFile={() => {}}
        contentState={{ kind: "ready", content: "# Find skills" }}
      />,
    );

    const sourceLink = screen.getByRole("link", {
      name: "Open skills.sh/vercel-labs/skills/find-skills in a new tab",
    });
    expect(sourceLink.getAttribute("href")).toBe(
      "https://www.skills.sh/vercel-labs/skills/find-skills",
    );
    expect(sourceLink.getAttribute("target")).toBe("_blank");
    expect(sourceLink.textContent).not.toContain("/SKILL.md");
    expect(screen.queryByText("Registry social proof")).toBeNull();
    expect(
      screen
        .getByRole("heading", { name: "Find skills" })
        .closest(".overflow-auto"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
  });
});
