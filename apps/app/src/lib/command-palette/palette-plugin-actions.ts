import type { PluginCommandPaletteActionContext } from "@get-bb/plugin-sdk";
import type { PluginThreadPanelOpenHandler } from "@/components/plugin/plugin-thread-panel-navigation";
import type { PluginCommandPaletteActionSlot } from "@/lib/plugin-slots";
import type { PaletteAction } from "./palette-action";

export interface BuildPluginPaletteActionsArgs {
  slots: readonly PluginCommandPaletteActionSlot[];
  threadId: string | null;
  projectId: string | null;
  openThreadPanel: PluginThreadPanelOpenHandler | null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actionContext(
  slot: PluginCommandPaletteActionSlot,
  args: BuildPluginPaletteActionsArgs,
): PluginCommandPaletteActionContext {
  return {
    threadId: args.threadId,
    projectId: args.projectId,
    openPanel: (options) => {
      if (args.openThreadPanel === null) {
        console.warn(
          `[plugin:${slot.pluginId}] commandPaletteAction "${slot.id}" openPanel declined: no thread side panel on this surface`,
        );
        return false;
      }
      return args.openThreadPanel({ ...options, pluginId: slot.pluginId });
    },
  };
}

export function buildPluginPaletteActions(
  args: BuildPluginPaletteActionsArgs,
): PaletteAction[] {
  const actions: PaletteAction[] = [];
  for (const slot of args.slots) {
    const context = actionContext(slot, args);
    if (slot.isAvailable !== undefined) {
      let available: boolean;
      try {
        available = slot.isAvailable(context);
      } catch (error) {
        console.warn(
          `[plugin:${slot.pluginId}] commandPaletteAction "${slot.id}" isAvailable failed: ${describeError(error)}`,
        );
        continue;
      }
      if (!available) continue;
    }
    actions.push({
      id: `plugin:${slot.pluginId}/${slot.id}`,
      group: "Plugins",
      title: slot.title,
      shortcut: null,
      run: () => {
        const warn = (error: unknown) => {
          console.warn(
            `[plugin:${slot.pluginId}] commandPaletteAction "${slot.id}" failed: ${describeError(error)}`,
          );
        };
        try {
          const result = slot.run(context);
          if (result instanceof Promise) result.catch(warn);
        } catch (error) {
          warn(error);
        }
      },
    });
  }
  return actions;
}
