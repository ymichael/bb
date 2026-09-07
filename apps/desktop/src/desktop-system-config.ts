import {
  appCommandIdSchema,
  appKeybindingSchema,
  type AppKeybinding,
  type AppKeybindings,
} from "@bb/domain";
import { z } from "zod";

const desktopKeybindingSchema = appKeybindingSchema.extend({
  command: z.string(),
});

const desktopSystemConfigSchema = z.object({
  keybindings: z.array(desktopKeybindingSchema).max(256),
});

interface DesktopSystemConfig {
  keybindings: AppKeybindings;
}

export function parseDesktopSystemConfig(
  payload: unknown,
): DesktopSystemConfig {
  const parsed = desktopSystemConfigSchema.parse(payload);
  const keybindings: AppKeybinding[] = [];
  for (const binding of parsed.keybindings) {
    const command = appCommandIdSchema.safeParse(binding.command);
    if (!command.success) {
      continue;
    }
    keybindings.push({ ...binding, command: command.data });
  }
  return { keybindings };
}
