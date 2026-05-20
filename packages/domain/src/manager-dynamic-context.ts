export const threadDynamicContextFileStatusValues = [
  "present",
  "missing",
  "too_large",
  "non_utf8",
] as const;

export type ThreadDynamicContextFileStatus =
  (typeof threadDynamicContextFileStatusValues)[number];
