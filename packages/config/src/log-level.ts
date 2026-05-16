export const LOG_LEVEL_VALUES = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

export function validateLogLevel(value: string): string {
  if (LOG_LEVEL_VALUES.includes(value)) {
    return value;
  }

  throw new Error(
    `BB_LOG_LEVEL must be one of ${LOG_LEVEL_VALUES.join(
      ", ",
    )}, received "${value}"`,
  );
}
