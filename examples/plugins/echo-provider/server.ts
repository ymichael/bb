import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  ECHO_GREETING_ENV,
  ECHO_MODEL,
  ECHO_PROJECT_SKILL_ROOT,
  ECHO_PROVIDER_ID,
  ECHO_STAMP_TOOL_NAME,
  ECHO_STAMP_TOOL_PRESENTATION,
  echoExtensionKinds,
  echoStampToolParametersSchema,
  type EchoProviderOptions,
} from "./src/vocabulary.js";

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    shout: {
      type: "boolean",
      label: "Shout",
      description: "Echo every prompt in upper case.",
      default: false,
    },
  });

  bb.agents.registerTool({
    name: ECHO_STAMP_TOOL_NAME,
    description: "Stamp a piece of text with the echo provider's seal.",
    parameters: echoStampToolParametersSchema,
    presentation: ECHO_STAMP_TOOL_PRESENTATION,
    execute: ({ text }) => `stamped: ${text}`,
  });

  bb.providers.register({
    id: ECHO_PROVIDER_ID,
    displayName: "Echo",
    icon: "Zap",
    strings: {
      signInHint: "Nothing to sign in to: the echo agent runs offline.",
      expiredHint: "Echo sessions never expire.",
      installUrl:
        "https://github.com/get-bb/bb/tree/main/examples/plugins/echo-provider",
      brandPrefix: "Echo ",
      planModeCopy: "Echo will repeat your plan without running anything.",
      iconTint: { light: "#b45309", dark: "#fcd34d" },
    },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high"],
    },
    reasoningLevels: [
      { id: "low", label: "Whisper" },
      { id: "medium", label: "Speak" },
      { id: "high", label: "Shout", description: "Echo with conviction." },
    ],
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
    composerActions: ["plan"],
    models: { fallback: [ECHO_MODEL] },
    env: { passthrough: [ECHO_GREETING_ENV] },
    experimental_nativeSkillRoots: { project: [ECHO_PROJECT_SKILL_ROOT] },
    deriveProviderOptions(context): EchoProviderOptions {
      return {
        shout: context.settings.shout === true,
        model: context.model,
        promptMode: context.promptMode ?? null,
      };
    },
    extensionKinds: echoExtensionKinds,
  });
}
