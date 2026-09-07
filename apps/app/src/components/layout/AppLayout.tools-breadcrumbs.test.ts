import { describe, expect, it } from "vitest";
import {
  resolveAutomationBreadcrumbs,
  resolveToolsAreaHeaderMeta,
  resolveToolsBreadcrumbs,
  TOOLS_NAV_ITEMS,
} from "@/components/tools/tools-navigation";

describe("resolveToolsBreadcrumbs", () => {
  it("uses one section identity contract for navigation and page chrome", () => {
    expect(
      TOOLS_NAV_ITEMS.map(({ id, label, icon, to }) => ({
        id,
        label,
        icon,
        to,
      })),
    ).toEqual([
      {
        id: "plugins",
        label: "Plugins",
        icon: "ElectricPlugs",
        to: "/extensions/plugins",
      },
      { id: "skills", label: "Skills", icon: "Zap", to: "/extensions/skills" },
    ]);
  });

  it("includes the selected collection tab", () => {
    expect(resolveToolsBreadcrumbs("/extensions/skills")).toEqual([
      { label: "Skills", to: "/extensions/skills" },
      { label: "Browse" },
    ]);
    expect(
      resolveToolsBreadcrumbs("/extensions/skills", "?view=library"),
    ).toEqual([
      { label: "Skills", to: "/extensions/skills" },
      { label: "My skills" },
    ]);
    expect(resolveToolsBreadcrumbs("/extensions/plugins")).toEqual([
      { label: "Plugins", to: "/extensions/plugins" },
      { label: "Browse" },
    ]);
    expect(
      resolveToolsBreadcrumbs("/extensions/plugins", "?view=create"),
    ).toEqual([
      { label: "Extensions", to: "/extensions/plugins" },
      { label: "Create a plugin" },
    ]);
    expect(
      resolveToolsBreadcrumbs("/extensions/plugins", "?view=installed"),
    ).toEqual([
      { label: "Plugins", to: "/extensions/plugins" },
      { label: "Installed" },
    ]);
  });

  it("resolves literal browse paths as Browse, not as a resource named browse", () => {
    expect(resolveToolsBreadcrumbs("/extensions/plugins/browse")).toEqual([
      { label: "Plugins", to: "/extensions/plugins" },
      { label: "Browse" },
    ]);
    expect(resolveToolsBreadcrumbs("/extensions/skills/registry")).toEqual([
      { label: "Skills", to: "/extensions/skills" },
      { label: "Browse" },
    ]);
  });

  it("makes every detail ancestor clickable and keeps the resource passive", () => {
    expect(
      resolveToolsBreadcrumbs(
        "/extensions/skills/library/skill_abc123",
        "",
        "Example Skill",
      ),
    ).toEqual([
      { label: "Skills", to: "/extensions/skills" },
      { label: "My skills", to: "/extensions/skills?view=library" },
      { label: "Example Skill" },
    ]);
    expect(
      resolveToolsBreadcrumbs(
        "/extensions/skills/registry/vercel-labs%2Fskills%2Ffind-skills",
      ),
    ).toEqual([
      { label: "Skills", to: "/extensions/skills" },
      { label: "Browse", to: "/extensions/skills/registry" },
      { label: "find-skills" },
    ]);
    expect(resolveToolsBreadcrumbs("/extensions/plugins/ui-patterns")).toEqual([
      { label: "Plugins", to: "/extensions/plugins" },
      { label: "Browse", to: "/extensions/plugins" },
      { label: "ui-patterns" },
    ]);
    expect(
      resolveToolsBreadcrumbs(
        "/extensions/plugins/ui-patterns",
        "?view=installed",
        "UI Patterns",
      ),
    ).toEqual([
      { label: "Plugins", to: "/extensions/plugins" },
      { label: "Installed", to: "/settings/plugins" },
      { label: "UI Patterns" },
    ]);
    expect(
      resolveToolsBreadcrumbs(
        "/plugins/automations/automations/personal/weekly-review",
      ),
    ).toBeNull();
  });
});

describe("resolveAutomationBreadcrumbs", () => {
  it("maps the installed and browse surfaces to automation breadcrumbs", () => {
    expect(
      resolveAutomationBreadcrumbs("/plugins/automations/automations"),
    ).toEqual([
      {
        label: "Automations",
        to: "/plugins/automations/automations",
      },
      { label: "Installed" },
    ]);
    expect(
      resolveAutomationBreadcrumbs("/plugins/automations/automations/browse"),
    ).toEqual([
      {
        label: "Automations",
        to: "/plugins/automations/automations",
      },
      { label: "Browse" },
    ]);
  });

  it("keeps detail ancestors clickable and replaces the loading fallback label", () => {
    const detailPath =
      "/plugins/automations/automations/proj_personal/weekly-review";

    expect(resolveAutomationBreadcrumbs(detailPath)).toEqual([
      {
        label: "Automations",
        to: "/plugins/automations/automations",
      },
      {
        label: "Installed",
        to: "/plugins/automations/automations",
      },
      { label: "weekly-review" },
    ]);
    expect(resolveAutomationBreadcrumbs(detailPath, "Weekly review")).toEqual([
      {
        label: "Automations",
        to: "/plugins/automations/automations",
      },
      {
        label: "Installed",
        to: "/plugins/automations/automations",
      },
      { label: "Weekly review" },
    ]);
    expect(
      resolveAutomationBreadcrumbs(`${detailPath}/edit`, "Weekly review"),
    ).toEqual([
      {
        label: "Automations",
        to: "/plugins/automations/automations",
      },
      {
        label: "Installed",
        to: "/plugins/automations/automations",
      },
      { label: "Weekly review" },
    ]);
  });

  it("uses the route id when automation data is missing", () => {
    expect(
      resolveAutomationBreadcrumbs(
        "/plugins/automations/automations/proj_personal/missing%20automation",
      )?.at(-1),
    ).toEqual({ label: "missing automation" });
  });

  it("does not claim unrelated plugin routes", () => {
    expect(
      resolveAutomationBreadcrumbs("/plugins/simple-notes/simple-notes"),
    ).toBeNull();
  });
});

describe("resolveToolsAreaHeaderMeta", () => {
  it("shows the static Extensions title on tools routes", () => {
    expect(
      resolveToolsAreaHeaderMeta(
        "/extensions/plugins?view=installed".split("?")[0]!,
      ),
    ).toEqual({ kind: "extensions-title", title: "Extensions" });
    expect(resolveToolsAreaHeaderMeta("/extensions/skills/registry")).toEqual({
      kind: "extensions-title",
      title: "Extensions",
    });
  });

  it("shows established ancestor/current breadcrumbs during plugin creation", () => {
    expect(
      resolveToolsAreaHeaderMeta("/extensions/plugins", null, "?view=create"),
    ).toEqual({
      kind: "breadcrumbs",
      breadcrumbs: [
        { label: "Extensions", to: "/extensions/plugins" },
        { label: "Create a plugin" },
      ],
    });
  });

  it("keeps automation breadcrumbs, including the legacy /tools alias", () => {
    const meta = resolveToolsAreaHeaderMeta("/plugins/automations/automations");
    expect(meta?.kind).toBe("breadcrumbs");
  });

  it("claims nothing when the route is unrelated", () => {
    expect(resolveToolsAreaHeaderMeta("/")).toBeNull();
  });
});
