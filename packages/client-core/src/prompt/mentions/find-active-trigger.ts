import type { ActiveTrigger, TypeaheadTrigger } from "./types.js";

export interface ActiveTriggerEditor {
  state: {
    selection: {
      empty: boolean;
      from: number;
    };
    doc: {
      textBetween(
        from: number,
        to: number,
        blockSeparator?: string,
        leafText?: string,
      ): string;
    };
  };
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function triggerPattern(
  trigger: TypeaheadTrigger,
  options: { windowed: boolean },
): RegExp {
  const escapedChar = escapeRegexLiteral(trigger.char);
  const queryPattern =
    trigger.kind === "mention" ? `(?:[^\\s${escapedChar}]| )*` : "\\S*";
  const boundary = options.windowed ? "([\\s([{])" : "(^|[\\s([{])";
  return new RegExp(`${boundary}${escapedChar}(${queryPattern})$`, "u");
}

const TRIGGER_SCAN_WINDOW = 256;

export function findActiveTrigger(
  editor: ActiveTriggerEditor,
  triggers: readonly TypeaheadTrigger[],
): ActiveTrigger | null {
  const selection = editor.state.selection;
  if (!selection.empty) return null;

  const scanStart = Math.max(0, selection.from - TRIGGER_SCAN_WINDOW);
  const windowed = scanStart > 0;
  const textBeforeCursor = editor.state.doc.textBetween(
    scanStart,
    selection.from,
    "\n",
    "\n",
  );

  for (const trigger of triggers) {
    const match = triggerPattern(trigger, { windowed }).exec(textBeforeCursor);
    if (!match) continue;

    const query = match[2] ?? "";
    const from = selection.from - query.length - 1;
    if (from < 0) continue;

    if (trigger.kind === "mention") {
      return {
        char: trigger.char,
        kind: "mention",
        query,
        from,
        to: selection.from,
      };
    }
    return {
      char: trigger.char,
      kind: "command",
      query,
      from,
      to: selection.from,
    };
  }

  return null;
}
