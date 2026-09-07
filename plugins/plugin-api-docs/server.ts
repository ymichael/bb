import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  PLUGIN_GUIDE_SURFACE_PROVIDER_ID,
  pluginSurfaceAgentContext,
} from "@bb/plugin-api-map/agent-reference";

export default function plugin(bb: BbPluginApi) {
  bb.ui.registerMentionProvider({
    id: PLUGIN_GUIDE_SURFACE_PROVIDER_ID,
    label: "Plugin Guide",
    search: () => [],
    resolve(surfaceId) {
      const context = pluginSurfaceAgentContext(surfaceId);
      if (context === null) {
        throw new Error(`Unknown Plugin Guide surface: ${surfaceId}`);
      }
      return { context };
    },
  });
  bb.log.debug("plugin API docs loaded");
}
