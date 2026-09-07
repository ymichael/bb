import {
  copyPluginSurfaceAgentReference,
  firstPartyPluginId,
  ProductMap,
} from "@bb/plugin-api-map";
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";

function useResolvablePluginIds(): ReadonlySet<string> | null {
  const [ids, setIds] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const read = async (url: string, pick: (row: never) => string) => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return [];
        const body = (await response.json()) as unknown;
        const rows = Array.isArray(body)
          ? body
          : ((body as { plugins?: unknown[]; results?: unknown[] }).plugins ??
            (body as { results?: unknown[] }).results ??
            []);
        return rows.map((row) => pick(row as never)).filter(Boolean);
      } catch {
        return [];
      }
    };
    void Promise.all([
      read("/api/v1/plugins", (row: { id?: string }) => row.id ?? ""),
      read(
        "/api/v1/plugin-catalog/search?q=",
        (row: { pluginId?: string }) => row.pluginId ?? "",
      ),
    ]).then(([installed, catalog]) => {
      if (!controller.signal.aborted) {
        setIds(new Set([...installed, ...catalog]));
      }
    });
    return () => controller.abort();
  }, []);
  return ids;
}

function PluginApiMapPage({ subPath }: { subPath: string }) {
  const resolvable = useResolvablePluginIds();
  const bbNavigate = useBbNavigate();
  const pluginPageHref = useCallback(
    (displayName: string) => {
      const id = firstPartyPluginId(displayName);
      if (!id || !resolvable?.has(id)) return null;
      return `/extensions/plugins/${id}`;
    },
    [resolvable],
  );
  const onSlideChange = useCallback(
    (slideId: string) => {
      bbNavigate.toPluginPanel("plugin-api", {
        subPath: slideId,
        replace: true,
      });
    },
    [bbNavigate],
  );
  return (
    <div
      data-guide-stage-viewport
      className="h-full min-h-0 w-full flex-1 overflow-y-auto px-6 pb-6 pt-5 [container-type:size] [--guide-stage-gap:3cqh] lg:pb-0 lg:pt-4"
    >
      <ProductMap
        pluginPageHref={pluginPageHref}
        initialSlideId={subPath.split("/")[0] || undefined}
        onSlideChange={onSlideChange}
        onCopyForAgent={copyPluginSurfaceAgentReference}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "plugin-api",
    title: "Plugin Guide",
    icon: "Puzzle",
    path: "plugin-api",
    component: PluginApiMapPage,
  });
});
