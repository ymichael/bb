export function toOptionalString(value: string | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}
