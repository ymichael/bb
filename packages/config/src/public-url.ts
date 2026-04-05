export function validateOptionalUrl(name: string, value: string): string {
  if (value.length === 0) {
    return value;
  }
  return validateRequiredUrl(name, value);
}

export function validateRequiredUrl(name: string, value: string): string {
  try {
    void new URL(value);
    return value;
  } catch {
    throw new Error(`${name} must be a valid URL, received "${value}"`);
  }
}
