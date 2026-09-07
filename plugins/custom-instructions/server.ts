import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 4096;
const STORAGE_KEY = "customInstructions";
const customInstructionsSchema = z
  .string()
  .max(
    MAX_CUSTOM_INSTRUCTIONS_LENGTH,
    `Custom instructions must be at most ${MAX_CUSTOM_INSTRUCTIONS_LENGTH} characters`,
  );

function parseInstructionsInput(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("expected { instructions: string }");
  }
  const entries = Object.entries(input);
  if (entries.length !== 1 || entries[0]?.[0] !== "instructions") {
    throw new Error('expected exactly one field: "instructions"');
  }
  const instructions = entries[0][1];
  if (typeof instructions !== "string") {
    throw new Error('"instructions" must be a string');
  }
  const parsed = customInstructionsSchema.safeParse(instructions);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "invalid instructions");
  }
  return parsed.data;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    instructions: {
      type: "string",
      label: "Custom instructions",
      description:
        "Give agents extra instructions and context for tasks on this bb host.",
      experimental_multiline: true,
      experimental_schema: customInstructionsSchema,
      default: "",
    },
  });

  let current = await settings.get();
  const legacy = await bb.storage.kv.get<string>(STORAGE_KEY);
  if (legacy !== undefined) {
    if (current.instructions.length === 0 && legacy.length > 0) {
      current = await settings.experimental_set({ instructions: legacy });
    }
    await bb.storage.kv.delete(STORAGE_KEY);
  }
  let customInstructions = current.instructions;

  settings.onChange((next) => {
    customInstructions = next.instructions;
  });

  bb.agents.contributeInstructions(() =>
    customInstructions.trim().length > 0 ? customInstructions : null,
  );

  bb.cli.register({
    name: "instructions",
    summary: "Read and update the custom instructions injected into agents",
    commands: [
      {
        name: "get",
        summary: "Print the current custom instructions",
        usage: "bb instructions get [--json]",
      },
      {
        name: "set",
        summary: "Replace the custom instructions",
        usage: "bb instructions set <text...> [--json]",
      },
      {
        name: "clear",
        summary: "Clear the custom instructions",
        usage: "bb instructions clear [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const positional = argv.filter((value) => value !== "--json");
      const [command, ...rest] = positional;
      if (command === "get") {
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ instructions: customInstructions })
            : customInstructions,
        };
      }
      if (command === "set") {
        const instructions = parseInstructionsInput({
          instructions: rest.join(" "),
        });
        const next = await settings.experimental_set({ instructions });
        customInstructions = next.instructions;
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ instructions: customInstructions })
            : "Custom instructions updated",
        };
      }
      if (command === "clear") {
        const next = await settings.experimental_set({ instructions: "" });
        customInstructions = next.instructions;
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ instructions: "" })
            : "Custom instructions cleared",
        };
      }
      return {
        exitCode: 1,
        stderr: "Usage: bb instructions get|set <text...>|clear [--json]",
      };
    },
  });
}
