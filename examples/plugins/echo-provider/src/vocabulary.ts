import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";
import {
  type DeltaPresentation,
  experimental_presentationTitle as presentationTitle,
  experimental_withTitle as withTitle,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const ECHO_PLUGIN_ID = "echo-provider";

export const ECHO_PROVIDER_ID = "echo-agent";

export const ECHO_MODEL_ID = "echo-1";

export const ECHO_MODEL = {
  id: ECHO_MODEL_ID,
  displayName: "Echo 1",
  description: "Repeats what it hears.",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Whisper" },
    { reasoningEffort: "medium", description: "Speak" },
    { reasoningEffort: "high", description: "Shout" },
  ],
  defaultReasoningEffort: "medium",
  isDefault: true,
} satisfies PluginProviderFallbackModel;

export const ECHO_RECEIPT_KIND = `${ECHO_PLUGIN_ID}/receipt` as const;

export const echoReceiptSchema = z.object({
  prompt: z.string(),
  itemCount: z.number().int().nonnegative(),
  shouted: z.boolean(),
});
export type EchoReceipt = z.infer<typeof echoReceiptSchema>;

export const ECHO_MOOD_KIND = `${ECHO_PLUGIN_ID}/mood` as const;

export const echoMoodSchema = z.object({
  mood: z.enum(["cheerful", "bored"]),
  turnsEchoed: z.number().int().nonnegative(),
});
export type EchoMood = z.infer<typeof echoMoodSchema>;

export const echoExtensionKinds = {
  receipt: { item: echoReceiptSchema },
  mood: { state: echoMoodSchema },
} as const;

export const echoProviderOptionsSchema = z.object({
  shout: z.boolean(),
  model: z.string(),
  promptMode: z.enum(["plan"]).nullable(),
});
export type EchoProviderOptions = z.infer<typeof echoProviderOptionsSchema>;

export const ECHO_GREETING_ENV = "BB_ECHO_PROVIDER_GREETING";

export const ECHO_PROJECT_SKILL_ROOT = ".echo/skills";

export const ECHO_STAMP_TOOL_NAME = "echo_stamp";

export const echoStampToolParametersSchema = z.object({
  text: z.string().min(1),
});

export const ECHO_STAMP_TOOL_PRESENTATION = {
  label: { pending: "Stamping receipt", completed: "Stamped receipt" },
  icon: { glyph: "Check" },
  tint: { light: "#1d4ed8", dark: "#93c5fd" },
} as const;

export const AGENT_MESSAGE_PRESENTATION: DeltaPresentation = {
  label: { pending: "Echoing", completed: "Echoed" },
  icon: { glyph: "Repeat" },
};

export function commandPresentation(command: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
    },
    presentationTitle(command),
  );
}

export function fileReadPresentation(path: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Reading file", completed: "Read file" },
      icon: { glyph: "FileText" },
    },
    presentationTitle(path),
  );
}

export function searchPresentation(query: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Searching files", completed: "Searched files" },
      icon: { glyph: "Search" },
    },
    presentationTitle(query),
  );
}

export function delegationPresentation(label: string): DeltaPresentation {
  return withTitle(
    {
      label: {
        pending: "Running echo child",
        completed: "Echo child finished",
      },
      icon: { glyph: "UserRound" },
      detail:
        "A scripted child turn, linked to this row through its parentRef.",
    },
    presentationTitle(label),
  );
}

export function planStepsPresentation(activeStep: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Updating plan", completed: "Updated plan" },
      icon: { glyph: "ListTodo" },
    },
    presentationTitle(activeStep),
  );
}

export const NOOP_TOOL_PRESENTATION: DeltaPresentation = {
  label: { pending: "Clearing throat", completed: "Cleared throat" },
  icon: { glyph: "Toolbox" },
  suppress: true,
};

export const ECHO_RECEIPT_ICON_GLYPH = `${ECHO_PLUGIN_ID}/receipt` as const;

export function receiptPresentation(receipt: EchoReceipt): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Writing receipt", completed: "Wrote receipt" },
      icon: { glyph: ECHO_RECEIPT_ICON_GLYPH },
      detail: `Echoed ${receipt.itemCount} item${receipt.itemCount === 1 ? "" : "s"}${receipt.shouted ? ", shouting" : ""}.`,
      tint: { light: "#047857", dark: "#6ee7b7" },
    },
    presentationTitle(receipt.prompt),
  );
}
