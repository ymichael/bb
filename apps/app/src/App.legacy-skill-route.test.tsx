// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import {
  ExtensionsLandingRedirect,
  LegacySkillDetailRedirect,
  LegacyToolsPathRedirect,
} from "./App";
import {
  LEGACY_TOOLS_AUTOMATIONS_ROUTE_PATH,
  LEGACY_TOOLS_PREFIX_ROUTE_PATH,
  LEGACY_TOOLS_SKILL_DETAIL_ROUTE_PATH,
  LEGACY_TOOLS_SPLAT_ROUTE_PATH,
  TOOLS_PLUGIN_BROWSE_ROUTE_PATH,
  TOOLS_PLUGIN_DETAIL_ROUTE_PATH,
  TOOLS_PLUGINS_ROUTE_PATH,
  TOOLS_ROUTE_PATH,
  TOOLS_SKILL_DETAIL_ROUTE_PATH,
} from "./lib/route-paths";

function LocationPath() {
  const location = useLocation();
  return (
    <span>
      {location.pathname}
      {location.search}
      {location.hash}
    </span>
  );
}

describe("LegacySkillDetailRedirect", () => {
  afterEach(cleanup);

  it("preserves old installed links while Library remains canonical", () => {
    render(
      <MemoryRouter
        initialEntries={["/extensions/skills/installed/skill_abc123"]}
      >
        <Routes>
          <Route
            path={LEGACY_TOOLS_SKILL_DETAIL_ROUTE_PATH}
            element={<LegacySkillDetailRedirect />}
          />
          <Route
            path={TOOLS_SKILL_DETAIL_ROUTE_PATH}
            element={<LocationPath />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      screen.getByText("/extensions/skills/library/skill_abc123"),
    ).toBeTruthy();
  });
});

describe("ExtensionsLandingRedirect", () => {
  afterEach(cleanup);

  it("opens Extensions on Plugins by default", () => {
    render(
      <MemoryRouter initialEntries={[TOOLS_ROUTE_PATH]}>
        <Routes>
          <Route
            path={TOOLS_ROUTE_PATH}
            element={<ExtensionsLandingRedirect />}
          />
          <Route path={TOOLS_PLUGINS_ROUTE_PATH} element={<LocationPath />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(TOOLS_PLUGINS_ROUTE_PATH)).toBeTruthy();
  });
});

describe("LegacyToolsPathRedirect", () => {
  afterEach(cleanup);

  it("forwards /tools deep links to /extensions keeping subpath, query, and hash", () => {
    render(
      <MemoryRouter
        initialEntries={["/tools/plugins/github?view=installed#configuration"]}
      >
        <Routes>
          <Route
            path={LEGACY_TOOLS_SPLAT_ROUTE_PATH}
            element={<LegacyToolsPathRedirect />}
          />
          <Route
            path={TOOLS_PLUGIN_DETAIL_ROUTE_PATH}
            element={<LocationPath />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        "/extensions/plugins/github?view=installed#configuration",
      ),
    ).toBeTruthy();
  });

  it("forwards bare /tools into the Extensions landing redirect", () => {
    render(
      <MemoryRouter initialEntries={[LEGACY_TOOLS_PREFIX_ROUTE_PATH]}>
        <Routes>
          <Route
            path={LEGACY_TOOLS_PREFIX_ROUTE_PATH}
            element={<LegacyToolsPathRedirect />}
          />
          <Route
            path={TOOLS_ROUTE_PATH}
            element={<ExtensionsLandingRedirect />}
          />
          <Route path={TOOLS_PLUGINS_ROUTE_PATH} element={<LocationPath />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(TOOLS_PLUGINS_ROUTE_PATH)).toBeTruthy();
  });

  it("loses /tools/automations to that route's own more-specific redirect", () => {
    render(
      <MemoryRouter initialEntries={[LEGACY_TOOLS_AUTOMATIONS_ROUTE_PATH]}>
        <Routes>
          <Route
            path={LEGACY_TOOLS_SPLAT_ROUTE_PATH}
            element={<LegacyToolsPathRedirect />}
          />
          <Route
            path={LEGACY_TOOLS_AUTOMATIONS_ROUTE_PATH}
            element={<LocationPath />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(LEGACY_TOOLS_AUTOMATIONS_ROUTE_PATH)).toBeTruthy();
  });
});

describe("legacy plugin browse redirect", () => {
  afterEach(cleanup);

  it("redirects the old Browse path to the canonical bare Plugins route", () => {
    render(
      <MemoryRouter initialEntries={[TOOLS_PLUGIN_BROWSE_ROUTE_PATH]}>
        <Routes>
          <Route
            path={TOOLS_PLUGIN_BROWSE_ROUTE_PATH}
            element={<ExtensionsLandingRedirect />}
          />
          <Route path={TOOLS_PLUGINS_ROUTE_PATH} element={<LocationPath />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(TOOLS_PLUGINS_ROUTE_PATH)).toBeTruthy();
  });
});
