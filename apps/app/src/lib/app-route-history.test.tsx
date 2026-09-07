// @vitest-environment jsdom

import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { PluginContext } from "@/components/plugin/plugin-context";
import { SidebarHistoryNavigationControls } from "@/components/sidebar/SidebarHistoryNavigationControls";
import { useBbNavigate } from "./plugin-sdk-hooks";
import {
  AUTOMATIONS_PLUGIN_ID,
  AUTOMATIONS_PLUGIN_PANEL_PATH,
  getPluginPanelRoutePath,
  getAutomationDetailRoutePath,
  getAutomationEditRoutePath,
  getAutomationsRoutePath,
  getSkillDetailRoutePath,
} from "./route-paths";
import {
  resetAppRouteHistoryForTest,
  useRouteStateHistoryNavigation,
} from "./app-route-history";

const TOOL_SKILL_DETAIL_ROUTE = getSkillDetailRoutePath({
  skillId: "skill_review_loop",
});

const TOOL_ROUTE_SEQUENCE = [
  "/extensions/skills",
  "/extensions/skills/registry",
  TOOL_SKILL_DETAIL_ROUTE,
  "/extensions/skills/registry/moss-skills%2Fmoss-notes",
  "/extensions/plugins",
  "/extensions/plugins/github",
] as const;

function HistoryHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  const { canGoBack, canGoForward, goBack, goForward } =
    useRouteStateHistoryNavigation();

  return (
    <div>
      <div data-testid="path">{location.pathname}</div>
      <div data-testid="can-go-back">{String(canGoBack)}</div>
      <div data-testid="can-go-forward">{String(canGoForward)}</div>
      <button type="button" onClick={goBack}>
        Back
      </button>
      <button type="button" onClick={goForward}>
        Forward
      </button>
      {TOOL_ROUTE_SEQUENCE.map((path) => (
        <button key={path} type="button" onClick={() => navigate(path)}>
          {path}
        </button>
      ))}
    </div>
  );
}

function RemountableHistoryHarness() {
  const [mounted, setMounted] = useState(true);
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => setMounted((value) => !value)}>
        toggle-harness
      </button>
      <button type="button" onClick={() => navigate("/")}>
        go-home
      </button>
      {mounted ? <HistoryHarness /> : null}
    </div>
  );
}

function SidebarControlsHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <div data-testid="path">{location.pathname}</div>
      <SidebarHistoryNavigationControls />
      {TOOL_ROUTE_SEQUENCE.map((path) => (
        <button key={path} type="button" onClick={() => navigate(path)}>
          {path}
        </button>
      ))}
    </div>
  );
}

const AUTOMATION_ROUTE = {
  projectId: "proj_standard",
  automationId: "auto_standard",
} as const;

function PluginNavigationHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  const pluginNavigate = useBbNavigate();
  const detailPath = getAutomationDetailRoutePath(AUTOMATION_ROUTE);
  const editSubPath = `${AUTOMATION_ROUTE.projectId}/${AUTOMATION_ROUTE.automationId}/edit`;
  const detailSubPath = `${AUTOMATION_ROUTE.projectId}/${AUTOMATION_ROUTE.automationId}`;

  return (
    <div>
      <div data-testid="path">{location.pathname}</div>
      <button type="button" onClick={() => navigate(detailPath)}>
        Open detail
      </button>
      <button
        type="button"
        onClick={() =>
          pluginNavigate.toPluginPanel(AUTOMATIONS_PLUGIN_PANEL_PATH, {
            subPath: editSubPath,
          })
        }
      >
        Edit from detail
      </button>
      <button
        type="button"
        onClick={() =>
          pluginNavigate.toPluginPanel(AUTOMATIONS_PLUGIN_PANEL_PATH, {
            subPath: editSubPath,
          })
        }
      >
        Open direct edit
      </button>
      <button
        type="button"
        onClick={() =>
          pluginNavigate.toCompose({
            initialPrompt: "Edit this automation",
          })
        }
      >
        Redirect edit to compose
      </button>
      <button
        type="button"
        onClick={() =>
          pluginNavigate.toPluginPanel(AUTOMATIONS_PLUGIN_PANEL_PATH, {
            subPath: detailSubPath,
            replace: true,
          })
        }
      >
        Exit edit
      </button>
      <button type="button" onClick={() => navigate(-1)}>
        Native back
      </button>
    </div>
  );
}

function RemountablePluginNavigationHarness() {
  const [mountKey, setMountKey] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setMountKey((value) => value + 1)}>
        Remount plugin
      </button>
      <PluginContext.Provider value={AUTOMATIONS_PLUGIN_ID}>
        <PluginNavigationHarness key={mountKey} />
      </PluginContext.Provider>
    </>
  );
}

async function clickAndExpectPath(label: string, path: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() => {
    expect(screen.getByTestId("path").textContent).toBe(path);
  });
}

async function expectSidebarButtonState(
  label: "Go back" | "Go forward",
  disabled: boolean,
) {
  await waitFor(() => {
    expect(
      (screen.getByRole("button", { name: label }) as HTMLButtonElement)
        .disabled,
    ).toBe(disabled);
  });
}

describe("useRouteStateHistoryNavigation", () => {
  afterEach(() => {
    cleanup();
    resetAppRouteHistoryForTest();
  });

  it("keeps the stack when the controls remount across sidebar layouts", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <RemountableHistoryHarness />
      </MemoryRouter>,
    );
    await clickAndExpectPath("/extensions/skills", "/extensions/skills");
    expect(screen.getByTestId("can-go-back").textContent).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "toggle-harness" }));
    expect(screen.queryByTestId("can-go-back")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "go-home" }));
    fireEvent.click(screen.getByRole("button", { name: "toggle-harness" }));

    expect(screen.getByTestId("path").textContent).toBe("/");
    expect(screen.getByTestId("can-go-back").textContent).toBe("true");
    await clickAndExpectPath("Back", "/extensions/skills");
  });

  it("tracks every Tools route for sidebar back and forward controls", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <HistoryHarness />
      </MemoryRouter>,
    );

    for (const path of TOOL_ROUTE_SEQUENCE) {
      await clickAndExpectPath(path, path);
    }

    expect(screen.getByTestId("can-go-back").textContent).toBe("true");
    expect(screen.getByTestId("can-go-forward").textContent).toBe("false");

    await clickAndExpectPath("Back", "/extensions/plugins");
    await clickAndExpectPath(
      "Back",
      "/extensions/skills/registry/moss-skills%2Fmoss-notes",
    );
    await clickAndExpectPath("Back", TOOL_SKILL_DETAIL_ROUTE);
    await clickAndExpectPath("Back", "/extensions/skills/registry");
    await clickAndExpectPath("Back", "/extensions/skills");
    await clickAndExpectPath("Back", "/");

    expect(screen.getByTestId("can-go-back").textContent).toBe("false");
    expect(screen.getByTestId("can-go-forward").textContent).toBe("true");

    await clickAndExpectPath("Forward", "/extensions/skills");
    await clickAndExpectPath("Forward", "/extensions/skills/registry");
    await clickAndExpectPath("Forward", TOOL_SKILL_DETAIL_ROUTE);
    await clickAndExpectPath(
      "Forward",
      "/extensions/skills/registry/moss-skills%2Fmoss-notes",
    );
    await clickAndExpectPath("Forward", "/extensions/plugins");
    await clickAndExpectPath("Forward", "/extensions/plugins/github");
  });

  it("updates the actual sidebar arrow buttons after Tools route clicks", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <SidebarControlsHarness />
      </MemoryRouter>,
    );

    await expectSidebarButtonState("Go back", true);
    await expectSidebarButtonState("Go forward", true);

    await clickAndExpectPath("/extensions/skills", "/extensions/skills");

    await expectSidebarButtonState("Go back", false);
    await expectSidebarButtonState("Go forward", true);

    await clickAndExpectPath(TOOL_SKILL_DETAIL_ROUTE, TOOL_SKILL_DETAIL_ROUTE);
    await clickAndExpectPath("Go back", "/extensions/skills");

    await expectSidebarButtonState("Go forward", false);
  });

  it("redirects remounted automation edit routes without duplicate history entries", async () => {
    render(
      <MemoryRouter initialEntries={[getAutomationsRoutePath()]}>
        <RemountablePluginNavigationHarness />
      </MemoryRouter>,
    );

    const detailPath = getAutomationDetailRoutePath(AUTOMATION_ROUTE);
    const editPath = getAutomationEditRoutePath(AUTOMATION_ROUTE);

    await clickAndExpectPath("Open detail", detailPath);
    await clickAndExpectPath("Edit from detail", editPath);
    await clickAndExpectPath("Remount plugin", editPath);
    await clickAndExpectPath("Redirect edit to compose", "/");
    await clickAndExpectPath("Native back", detailPath);
    await clickAndExpectPath("Native back", getAutomationsRoutePath());

    await clickAndExpectPath("Open direct edit", editPath);
    await clickAndExpectPath("Remount plugin", editPath);
    await clickAndExpectPath("Redirect edit to compose", "/");
    await clickAndExpectPath("Native back", getAutomationsRoutePath());
  });

  it("keeps Automations on its plugin panel route", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <RemountablePluginNavigationHarness />
      </MemoryRouter>,
    );

    const editSubPath = `${AUTOMATION_ROUTE.projectId}/${AUTOMATION_ROUTE.automationId}/edit`;
    await clickAndExpectPath(
      "Open direct edit",
      getPluginPanelRoutePath({
        pluginId: AUTOMATIONS_PLUGIN_ID,
        path: AUTOMATIONS_PLUGIN_PANEL_PATH,
        subPath: editSubPath,
      }),
    );
  });
});
