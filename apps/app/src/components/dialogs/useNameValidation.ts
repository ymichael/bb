import { useCallback, useState } from "react";

interface NameMaxLengthRule {
  limit: number;
  message: string;
}

interface UseNameValidationArgs {
  emptyMessage: string;
  maxLength?: NameMaxLengthRule;
}

interface UseNameValidationResult {
  validationMessage: string | null;
  validate: (value: string) => string | null;
  clearMessage: () => void;
}

export function useNameValidation({
  emptyMessage,
  maxLength,
}: UseNameValidationArgs): UseNameValidationResult {
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );

  const validate = useCallback(
    (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) {
        setValidationMessage(emptyMessage);
        return null;
      }
      if (maxLength && trimmed.length > maxLength.limit) {
        setValidationMessage(maxLength.message);
        return null;
      }
      return trimmed;
    },
    [emptyMessage, maxLength],
  );

  const clearMessage = useCallback(() => setValidationMessage(null), []);

  return { validationMessage, validate, clearMessage };
}
