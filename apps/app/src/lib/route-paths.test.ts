import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  getPluginConfigurationRoutePath,
  getPluginDetailRoutePath,
  getPluginsRoutePath,
  getRegistrySkillDetailRoutePath,
  getAutomationDetailRoutePath,
  getAutomationEditRoutePath,
  getAutomationsRoutePath,
  getSkillDetailRoutePath,
  getSkillsRoutePath,
  getThreadRoutePath,
  isRoutePath,
  isProjectlessProjectId,
  LEGACY_AUTOMATION_DETAIL_ROUTE_PATH,
  LEGACY_AUTOMATIONS_ROUTE_PATH,
  LEGACY_SKILLS_ROUTE_PATH,
  resolveRouteHref,
} from "./route-paths";

describe("route path helpers", () => {
  it("recognizes the legacy archived URL", () => {
    expect(isRoutePath({ path: "/archived" })).toBe(true);
  });

  it("builds canonical projectless thread detail URLs", () => {
    expect(
      getThreadRoutePath({
        projectId: PERSONAL_PROJECT_ID,
        threadId: "thr_personal",
      }),
    ).toBe("/threads/thr_personal");
  });

  it("keeps standard project thread detail URLs project scoped", () => {
    expect(
      getThreadRoutePath({
        projectId: "proj_standard",
        threadId: "thr_standard",
      }),
    ).toBe("/projects/proj_standard/threads/thr_standard");
  });

  it("recognizes only the personal project id as projectless", () => {
    expect(isProjectlessProjectId(PERSONAL_PROJECT_ID)).toBe(true);
    expect(isProjectlessProjectId("proj_standard")).toBe(false);
    expect(isProjectlessProjectId(undefined)).toBe(false);
  });

  it("recognizes route paths with query and hash suffixes", () => {
    expect(
      isRoutePath({
        path: "/projects/proj_standard/threads/thr_standard?panel=files#row-1",
      }),
    ).toBe(true);
  });

  it("recognizes the global settings route", () => {
    expect(isRoutePath({ path: "/settings" })).toBe(true);
  });

  it("builds and recognizes the Extensions routes", () => {
    expect(getSkillsRoutePath()).toBe("/extensions/skills");
    expect(
      getSkillDetailRoutePath({
        skillId: "skill_abc123",
      }),
    ).toBe("/extensions/skills/library/skill_abc123");
    expect(
      getRegistrySkillDetailRoutePath({
        registrySkillId: "moss-skills/moss-notes",
      }),
    ).toBe("/extensions/skills/registry/moss-skills%2Fmoss-notes");
    expect(getPluginsRoutePath()).toBe("/extensions/plugins");
    expect(getPluginDetailRoutePath({ pluginId: "github" })).toBe(
      "/extensions/plugins/github",
    );
    expect(
      getPluginDetailRoutePath({ pluginId: "github", view: "installed" }),
    ).toBe("/settings/plugins/github?view=installed");
    expect(getPluginConfigurationRoutePath({ pluginId: "github" })).toBe(
      "/settings/plugins/github",
    );
    for (const path of [
      "/extensions",
      "/tools",
      "/tools/plugins/github",
      "/extensions/skills",
      "/extensions/skills/library/skill_abc123",
      "/extensions/skills/installed/skill_abc123",
      "/extensions/skills/registry/moss-skills%2Fmoss-notes",
      "/extensions/plugins",
      "/extensions/plugins/browse",
      "/extensions/plugins/github",
    ]) {
      expect(isRoutePath({ path })).toBe(true);
    }
  });

  it("builds canonical Automations plugin routes", () => {
    expect(getAutomationsRoutePath()).toBe("/plugins/automations/automations");
    expect(
      getAutomationDetailRoutePath({
        projectId: "proj_standard",
        automationId: "auto_standard",
      }),
    ).toBe("/plugins/automations/automations/proj_standard/auto_standard");
    expect(
      getAutomationEditRoutePath({
        projectId: "proj_standard",
        automationId: "auto_standard",
      }),
    ).toBe("/plugins/automations/automations/proj_standard/auto_standard/edit");

    for (const path of [
      "/plugins/automations/automations",
      "/plugins/automations/automations/browse",
      "/plugins/automations/automations/proj_standard/auto_standard",
      "/plugins/automations/automations/proj_standard/auto_standard/edit",
    ]) {
      expect(isRoutePath({ path })).toBe(true);
    }
  });

  it("keeps old Skills and Automations paths recognizable for redirects", () => {
    expect(LEGACY_SKILLS_ROUTE_PATH).toBe("/skills");
    expect(LEGACY_AUTOMATIONS_ROUTE_PATH).toBe("/automations");
    expect(LEGACY_AUTOMATION_DETAIL_ROUTE_PATH).toBe(
      "/automations/:projectId/:automationId",
    );
    expect(isRoutePath({ path: "/skills" })).toBe(true);
    expect(isRoutePath({ path: "/automations" })).toBe(true);
    expect(
      isRoutePath({ path: "/automations/proj_standard/auto_standard" }),
    ).toBe(true);
    expect(isRoutePath({ path: "/tools/automations" })).toBe(true);
    expect(
      isRoutePath({
        path: "/plugins/automations/automations/proj_standard/auto_standard",
      }),
    ).toBe(true);
  });

  it("does not mistake deeper filesystem-like paths for routes", () => {
    expect(
      isRoutePath({
        path: "/projects/my-repo/src/file.ts",
      }),
    ).toBe(false);
  });

  it("resolves same-origin hrefs to router paths", () => {
    expect(
      resolveRouteHref({
        currentOrigin: "https://bb.local",
        href: "https://bb.local/projects/proj_standard/threads/thr_standard?q=1",
      }),
    ).toEqual({
      path: "/projects/proj_standard/threads/thr_standard?q=1",
    });
  });

  it("rejects external and protocol-relative route-shaped hrefs", () => {
    expect(
      resolveRouteHref({
        currentOrigin: "https://bb.local",
        href: "https://example.test/projects/proj_standard/threads/thr_standard",
      }),
    ).toBeNull();
    expect(
      resolveRouteHref({
        currentOrigin: "https://bb.local",
        href: "//example.test/projects/proj_standard/threads/thr_standard",
      }),
    ).toBeNull();
  });

  it("rejects fragment-only and query-only hrefs", () => {
    expect(
      resolveRouteHref({
        currentOrigin: "https://bb.local",
        href: "#timeline-row",
      }),
    ).toBeNull();
    expect(
      resolveRouteHref({
        currentOrigin: "https://bb.local",
        href: "?panel=files",
      }),
    ).toBeNull();
  });
});
