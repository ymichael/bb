import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { appToast } from "@/components/ui/app-toast";
import { getPluginDetailRoutePath } from "@/lib/route-paths";

interface PluginNotificationTarget {
  id: string;
  name: string | null;
}

type PluginView = "catalog" | "installed";

export function pluginNotificationDescription(
  plugin: PluginNotificationTarget,
  view: PluginView,
  detail?: ReactNode,
): ReactNode {
  return (
    <>
      <Link
        to={getPluginDetailRoutePath({
          pluginId: plugin.id,
          ...(view === "installed" ? { view } : {}),
        })}
        className="rounded-sm underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {plugin.name ?? plugin.id}
      </Link>
      {detail === undefined ? null : <> — {detail}</>}
    </>
  );
}

function createPluginToast(tone: "error" | "message" | "success") {
  return (
    title: ReactNode,
    plugin: PluginNotificationTarget,
    view: PluginView,
    detail?: ReactNode,
  ) =>
    appToast[tone](title, {
      description: pluginNotificationDescription(plugin, view, detail),
    });
}

export const pluginToast = {
  error: createPluginToast("error"),
  message: createPluginToast("message"),
  success: createPluginToast("success"),
};
