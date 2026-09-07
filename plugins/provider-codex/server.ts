import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { codexExtensionKinds } from "./src/extension-kinds.js";
import { CODEX_NATIVE_ROOTS_DECLARATION } from "./src/native-roots.js";

export default function plugin(bb: BbPluginApi) {
  bb.experimental_aiServices.register({
    id: "codex",
    displayName: "Codex (ChatGPT account or API key)",
    kinds: ["inference", "voice"],
  });

  bb.settings.define({
    memoryEnabled: {
      type: "boolean",
      label: "Codex memory",
      description:
        "Allow Codex to recall existing memories and generate new memories from bb threads.",
      default: true,
    },
    subagentsDisabled: {
      type: "boolean",
      label: "Disable provider subagents",
      description:
        "Prevent Codex from starting native subagents so agents use bb for delegation.",
      default: false,
    },
  });

  bb.providers.register({
    id: "codex",
    displayName: "Codex",
    icon: "./icons/codex.svg",
    strings: {
      signInHint: "Run `codex` on the machine to sign in.",
      expiredHint: "Your Codex session expired. Run `codex`, then reload.",
      installUrl: "https://developers.openai.com/codex/cli",
      brandPrefix: "GPT-",
    },
    models: { scope: "host" },
    ...CODEX_NATIVE_ROOTS_DECLARATION,
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: true,
      supportsThreadRename: true,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
      {
        id: "ultra",
        label: "Ultra",
        description: "Max effort plus automatic task delegation.",
      },
    ],
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
    composerActions: ["plan", "goal"],
    deriveProviderOptions(context) {
      return {
        memoryEnabled: context.settings.memoryEnabled !== false,
        providerSubagentsEnabled: context.settings.subagentsDisabled !== true,
      };
    },
    extensionKinds: codexExtensionKinds,
  });
}
