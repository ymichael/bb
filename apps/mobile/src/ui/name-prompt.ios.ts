import { Alert } from "react-native";
import type { NamePromptOptions } from "./name-prompt-types";

export function promptName({
  title,
  message,
  initialValue,
  submitLabel,
  onSubmit,
  onCancel,
}: NamePromptOptions): boolean {
  Alert.prompt(
    title,
    message,
    [
      { text: "Cancel", style: "cancel", onPress: () => onCancel?.() },
      {
        text: submitLabel,
        onPress: (value?: string) => {
          const name = value?.trim();
          if (name) onSubmit(name);
          else onCancel?.();
        },
      },
    ],
    "plain-text",
    initialValue,
  );
  return true;
}

export type { NamePromptOptions } from "./name-prompt-types";
